const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatcher } = require('../src/deck-match');
const { buildMatchRequest, parseMatchResponse } = require('../src/presentation-prompts');

const H0 = '0000000000000000';
const H3 = '0000000000000007'; // distance 3 from H0
const H6 = '000000000000003f'; // distance 6 from H0
const H9 = 'ffffffffffffffff';
const HA = 'f0f0f0f0f0f0f0f0';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(r => setImmediate(r));

function setup({ cache = {}, slideCount = 32, identify } = {}) {
  const calls = [];
  const m = createMatcher({
    getCache: () => cache,
    setCache: (h, n) => { cache[h] = n; },
    slideCount,
    identify: identify || (async hint => { calls.push(hint); return 5; })
  });
  return { m, cache, calls };
}

test('cache hit within distance 5 returns cached without identify', async () => {
  const { m, calls } = setup({ cache: { [H0]: 7 } });
  assert.deepEqual(await m.match(H3, null), { n: 7, cached: true });
  assert.equal(calls.length, 0);
});

test('distance 6 calls identify with the hint and caches the answer', async () => {
  const { m, calls, cache } = setup({ cache: { [H0]: 7 } });
  const r = await m.match(H6, 4);
  assert.deepEqual(r, { n: 5, cached: false });
  assert.deepEqual(calls, [4]);
  assert.equal(cache[H6], 5);
});

test('null answer is stored as 0 and returned as n null; later hit is cached null', async () => {
  const { m, cache } = setup({ identify: async () => null });
  assert.deepEqual(await m.match(H0, null), { n: null, cached: false });
  assert.equal(cache[H0], 0);
  assert.deepEqual(await m.match(H0, null), { n: null, cached: true });
});

test('cached value above slideCount is a miss', async () => {
  const { m, calls } = setup({ cache: { [H0]: 40 }, slideCount: 32 });
  const r = await m.match(H0, null);
  assert.equal(r.cached, false);
  assert.equal(calls.length, 1);
});

test('out-of-range identify answer counts as null', async () => {
  const { m, cache } = setup({ identify: async () => 99, slideCount: 32 });
  assert.deepEqual(await m.match(H0, null), { n: null, cached: false });
  assert.equal(cache[H0], 0);
});

test('nearest cached hash wins', async () => {
  const { m } = setup({ cache: { [H3]: 2, [H0]: 9 } });
  assert.deepEqual(await m.match(H0, null), { n: 9, cached: true });
});

test('correct overwrites the cache immediately', async () => {
  const { m, cache } = setup({ cache: { [H0]: 7 } });
  m.correct(H0, 12);
  assert.equal(cache[H0], 12);
  m.correct(H9, 99);
  assert.equal(H9 in cache, false);
});

test('three hashes, two rapid matches: at most two identify calls, middle one superseded', async () => {
  const d1 = deferred();
  const hints = [];
  const answers = [d1.promise, Promise.resolve(8)];
  const { m } = setup({ identify: hint => { hints.push(hint); return answers.shift(); } });
  const a = m.match(H0, 1);
  const b = m.match(H9, 2);
  const c = m.match(HA, 3);
  d1.resolve(1);
  assert.deepEqual(await a, { n: 1, cached: false });
  assert.deepEqual(await b, { n: null, cached: false, superseded: true });
  assert.deepEqual(await c, { n: 8, cached: false });
  assert.deepEqual(hints, [1, 3]);
});

test('waiter re-checks the cache after the pending call resolves', async () => {
  const d1 = deferred();
  const calls = [];
  const { m } = setup({ identify: hint => { calls.push(hint); return d1.promise; } });
  const a = m.match(H0, null);
  const b = m.match(H3, null); // near H0, not yet cached
  d1.resolve(6);
  await a;
  assert.deepEqual(await b, { n: 6, cached: true });
  assert.equal(calls.length, 1);
});

test('rejection is not cached, is rethrown, and clears in-flight state', async () => {
  let fail = true;
  const calls = [];
  const { m, cache } = setup({
    identify: async hint => { calls.push(hint); if (fail) throw new Error('boom'); return 3; }
  });
  await assert.rejects(m.match(H0, null), /boom/);
  assert.equal(H0 in cache, false);
  fail = false;
  assert.deepEqual(await m.match(H0, null), { n: 3, cached: false });
  assert.equal(calls.length, 2);
});

test('a waiter still runs after the pending call rejects', async () => {
  const d1 = deferred();
  const answers = [d1.promise, Promise.resolve(4)];
  const { m } = setup({ identify: () => answers.shift() });
  const a = m.match(H0, null);
  const b = m.match(H9, null);
  const aRes = assert.rejects(a, /nope/);
  d1.reject(new Error('nope'));
  await aRes;
  assert.deepEqual(await b, { n: 4, cached: false });
  await tick();
});

test('buildMatchRequest lists slides, adds the hint and sets limits', () => {
  const r = buildMatchRequest({
    slides: [{ n: 1, title: 'Intro', body: 'x'.repeat(200) }, { n: 2, title: 'Two', body: '' }],
    hint: 1
  });
  assert.equal(r.maxTokens, 30);
  assert.equal(r.effort, 'low');
  assert.match(r.system, /\{"slide": n\}/);
  assert.match(r.system, /\{"slide": null\}/);
  const t = r.turns[0].text;
  assert.equal(r.turns[0].role, 'user');
  assert.match(t, new RegExp('1: Intro \| x{80}(?!x)'));
  assert.match(t, /2: Two/);
  assert.match(t, /The presenter was on slide 1; slide 2 is most likely\./);
  assert.doesNotMatch(buildMatchRequest({ slides: [], hint: null }).turns[0].text, /most likely/);
});

test('parseMatchResponse accepts only integers within range', () => {
  assert.equal(parseMatchResponse('{"slide": 7}', 32), 7);
  assert.equal(parseMatchResponse('```json\n{"slide": 7}\n```', 32), 7);
  assert.equal(parseMatchResponse('slide 7', 32), null);
  assert.equal(parseMatchResponse('{"slide": 33}', 32), null);
  assert.equal(parseMatchResponse('{"slide": 0}', 32), null);
  assert.equal(parseMatchResponse('{"slide": 2.5}', 32), null);
  assert.equal(parseMatchResponse('{"slide": "7"}', 32), null);
  assert.equal(parseMatchResponse('{"slide": null}', 32), null);
});
