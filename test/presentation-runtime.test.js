const test = require('node:test');
const assert = require('node:assert');
const {
  createPresentationRuntime, buildPresentationUpdate, deckChanged, isMatchingFatal
} = require('../src/presentation-runtime');

const H1 = '0000000000000000';
const H2 = 'ffffffffffffffff';
const H3 = '00000000ffffffff';

function deck(count = 3, extra = {}) {
  return {
    version: 1,
    source: { fileName: 'talk.pptx', type: 'pptx', sha256: 'abc' },
    slides: Array.from({ length: count }, (_, i) => ({ n: i + 1, title: 'T' + (i + 1), body: 'b', points: ['p' + (i + 1)] })),
    matchCache: {},
    ...extra
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function make(opts = {}) {
  let t = 0;
  const saves = [];
  const rt = createPresentationRuntime({
    deck: 'deck' in opts ? opts.deck : deck(),
    durationMin: 10,
    now: () => t,
    identify: opts.identify || (async () => 2),
    onCacheWrite: () => saves.push(1)
  });
  return { rt, saves, tick: (ms) => { t += ms; } };
}

test('buildPresentationUpdate fills slide and next from the deck', () => {
  const d = deck(3);
  const u = buildPresentationUpdate({ deck: d, snapshot: { current: 2, slideCount: 3 }, matching: 'ok' });
  assert.deepStrictEqual(u.slide, { n: 2, title: 'T2', points: ['p2'], script: '' });
  assert.deepStrictEqual(u.next, { n: 3, title: 'T3' });
  assert.strictEqual(u.matching, 'ok');
  const last = buildPresentationUpdate({ deck: d, snapshot: { current: 3 }, matching: 'ok' });
  assert.strictEqual(last.next, null);
  const before = buildPresentationUpdate({ deck: d, snapshot: { current: null }, matching: 'ok' });
  assert.strictEqual(before.slide, null);
  assert.deepStrictEqual(before.next, { n: 1, title: 'T1' });
  const none = buildPresentationUpdate({ deck: null, snapshot: { current: null }, matching: 'disabled' });
  assert.strictEqual(none.slide, null);
  assert.strictEqual(none.next, null);
});

test('deckChanged compares slide count and source hash only', () => {
  assert.strictEqual(deckChanged(null, null), false);
  assert.strictEqual(deckChanged(null, deck()), true);
  assert.strictEqual(deckChanged(deck(), null), true);
  assert.strictEqual(deckChanged(deck(3), deck(4)), true);
  assert.strictEqual(deckChanged(deck(3), deck(3, { source: { sha256: 'zzz' } })), true);
  const enriched = deck(3); enriched.slides[0].points = ['new'];
  assert.strictEqual(deckChanged(deck(3), enriched), false);
});

test('isMatchingFatal matches auth and quota errors', () => {
  assert.ok(isMatchingFatal('HTTP 429 Too Many Requests'));
  assert.ok(isMatchingFatal('401 unauthorized'));
  assert.ok(isMatchingFatal('model_not_found'));
  assert.ok(!isMatchingFatal('network reset'));
});

test('a deckless runtime has no matcher and paces by time only', async () => {
  const { rt } = make({ deck: null });
  assert.strictEqual(rt.matcher, null);
  assert.strictEqual(rt.update().matching, 'disabled');
  assert.strictEqual(rt.update().snapshot.slideCount, 0);
  const r = await rt.onFrame(H1);
  assert.strictEqual(r.changed, false);
});

test('onFrame matches and moves to the identified slide', async () => {
  const { rt, saves } = make({ identify: async () => 2 });
  const r = await rt.onFrame(H1);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(rt.state.snapshot().current, 2);
  assert.strictEqual(rt.deck.matchCache[H1], 2);
  assert.deepStrictEqual(rt.takeCacheWrites(), { [H1]: 2 });
  assert.deepStrictEqual(rt.takeCacheWrites(), {});
  assert.strictEqual(saves.length, 1);
  assert.strictEqual(rt.update().slide.n, 2);
});

test('an unmatched screen marks off-deck', async () => {
  const { rt } = make({ identify: async () => null });
  await rt.onFrame(H1);
  assert.strictEqual(rt.state.snapshot().offDeck, true);
});

test('identify sends the deck slides and hint, and parses the reply', async () => {
  const calls = [];
  const rt = createPresentationRuntime({
    deck: deck(3),
    durationMin: 10,
    capture: async () => 'data:image/jpeg;base64,xx',
    callLLM: async (req) => { calls.push(req); return '{"slide": 3}'; },
    onCacheWrite: () => {}
  });
  await rt.onFrame(H1);
  assert.strictEqual(rt.state.snapshot().current, 3);
  assert.strictEqual(calls[0].imageDataUrl, 'data:image/jpeg;base64,xx');
  assert.strictEqual(calls[0].maxTokens, 30);
  assert.match(calls[0].turns[0].text, /1: T1/);
});

test('a stale result does not override a newer slide decision', async () => {
  const first = deferred();
  const queue = [first.promise, Promise.resolve(3)];
  const { rt } = make({ identify: () => queue.shift() });
  const p1 = rt.onFrame(H1);
  const p2 = rt.onFrame(H2); // queued behind H1; H2 is now the latest
  first.resolve(1);
  const r1 = await p1;
  assert.strictEqual(r1.changed, false);
  assert.strictEqual(rt.deck.matchCache[H1], 1); // its cache write still happened
  await p2;
  assert.strictEqual(rt.state.snapshot().current, 3);
});

test('superseded results are ignored', async () => {
  const first = deferred();
  const queue = [first.promise, Promise.resolve(2)];
  const { rt } = make({ identify: () => queue.shift() });
  const p1 = rt.onFrame(H1);
  const p2 = rt.onFrame(H2);
  const p3 = rt.onFrame(H3); // supersedes H2's wait
  const r2 = await p2;
  assert.strictEqual(r2.changed, false);
  first.resolve(1);
  await p1;
  await p3;
  assert.strictEqual(rt.state.snapshot().current, 2);
});

test('a manual step corrects the cache, and a later in-flight result does not undo it', async () => {
  const first = deferred();
  const { rt } = make({ identify: () => first.promise });
  const p = rt.onFrame(H1);
  const s = rt.step(1); // nothing current yet: go to slide 1
  assert.strictEqual(s.changed, true);
  assert.strictEqual(rt.state.snapshot().current, 1);
  rt.step(1);
  assert.strictEqual(rt.state.snapshot().current, 2);
  first.resolve(3);
  const r = await p;
  assert.strictEqual(r.changed, false);
  assert.strictEqual(rt.state.snapshot().current, 2);
  assert.strictEqual(rt.deck.matchCache[H1], 2);
  assert.strictEqual(rt.takeCacheWrites()[H1], 2);
});

test('step corrects the cache for the latest hash', async () => {
  const { rt } = make({ identify: async () => 1 });
  await rt.onFrame(H1);
  rt.step(1);
  assert.strictEqual(rt.deck.matchCache[H1], 2);
  rt.step(-1);
  assert.strictEqual(rt.deck.matchCache[H1], 1);
  const out = rt.step(-1); // already on slide 1
  assert.strictEqual(out.changed, false);
});

test('step before any frame does not touch the cache', () => {
  const { rt } = make();
  rt.step(1);
  assert.deepStrictEqual(rt.deck.matchCache, {});
});

test('failures set failed until the next success; fatal errors disable once', async () => {
  const queue = [
    () => Promise.reject(new Error('socket hang up')),
    () => Promise.resolve(2),
    () => Promise.reject(new Error('429 quota exceeded'))
  ];
  const { rt } = make({ identify: () => queue.shift()() });
  const a = await rt.onFrame(H1);
  assert.strictEqual(a.changed, true);
  assert.strictEqual(rt.update().matching, 'failed');
  await rt.onFrame(H2);
  assert.strictEqual(rt.update().matching, 'ok');
  const c = await rt.onFrame(H3);
  assert.strictEqual(rt.update().matching, 'disabled');
  assert.match(c.message, /429/);
  const d = await rt.onFrame('0f0f0f0f0f0f0f0f');
  assert.strictEqual(d.changed, false);
  assert.strictEqual(d.message, undefined);
});

test('swapDeck keeps state and unsaved cache entries for an enrichment-only change', async () => {
  const { rt } = make({ identify: async () => 2 });
  await rt.onFrame(H1);
  const fresh = deck(3, { matchCache: { [H2]: 1 } });
  fresh.slides[1].points = ['enriched'];
  assert.strictEqual(rt.swapDeck(fresh), true);
  assert.strictEqual(rt.update().slide.points[0], 'enriched');
  assert.deepStrictEqual(rt.deck.matchCache, { [H2]: 1, [H1]: 2 });
  assert.strictEqual(rt.state.snapshot().current, 2);
  assert.strictEqual(rt.swapDeck(deck(4)), false);
});

test('noteTranscript starts the pacing clock', () => {
  const { rt, tick } = make({ deck: null });
  const before = rt.state.snapshot().remainingMs;
  tick(1000);
  assert.strictEqual(rt.state.snapshot().remainingMs, before);
  rt.noteTranscript();
  tick(60000);
  assert.strictEqual(rt.state.snapshot().remainingMs, before - 60000);
});

test('resumeMatching clears a pause only when a matcher exists', async () => {
  let fail = true;
  const { rt } = make({ identify: async () => { if (fail) throw new Error('401 unauthorized'); return 2; } });
  await rt.onFrame(H1);
  assert.strictEqual(rt.update().matching, 'disabled');
  rt.resumeMatching();
  assert.strictEqual(rt.update().matching, 'ok');
  fail = false;
  await rt.onFrame(H2);
  assert.strictEqual(rt.state.snapshot().current, 2);
  const bare = make({ deck: null }).rt;
  bare.resumeMatching();
  assert.strictEqual(bare.update().matching, 'disabled');
});

test('resumeMatching leaves failed alone', async () => {
  const { rt } = make({ identify: async () => { throw new Error('socket hang up'); } });
  await rt.onFrame(H1);
  rt.resumeMatching();
  assert.strictEqual(rt.update().matching, 'failed');
});

test('an error for an older hash does not mark failed, but a fatal one still disables', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first.promise, second.promise];
  const { rt } = make({ identify: () => queue.shift() });
  const p1 = rt.onFrame(H1);
  const p2 = rt.onFrame(H2); // H2 is now the latest
  first.reject(new Error('socket hang up'));
  const r1 = await p1;
  assert.strictEqual(r1.changed, false);
  assert.strictEqual(rt.update().matching, 'ok');
  second.resolve(2);
  await p2;
  assert.strictEqual(rt.state.snapshot().current, 2);

  const third = deferred();
  const q2 = [third.promise, Promise.resolve(3)];
  const b = make({ identify: () => q2.shift() }).rt;
  const s1 = b.onFrame(H1);
  const s2 = b.onFrame(H2);
  third.reject(new Error('429 quota'));
  const f = await s1;
  assert.match(f.message, /429/);
  assert.strictEqual(b.update().matching, 'disabled');
  const r2 = await s2; // queued before the pause: its result is ignored
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(b.state.snapshot().current, null);
});

test('recordCoverage stores results per slide', () => {
  const rt = createPresentationRuntime({ deck: deck(), durationMin: 45, now: () => 0 });
  assert.deepEqual(rt.coverage, {});
  rt.recordCoverage(2, { status: 'missed', missing: 'x' });
  assert.deepEqual(rt.coverage[2], { status: 'missed', missing: 'x' });
});

test('recordCoverage keeps one flag per slide: replaced on revisit, removed when covered', () => {
  const rt = createPresentationRuntime({ deck: deck(), durationMin: 45, now: () => 0 });
  rt.recordCoverage(2, { status: 'missed', missing: 'x' });
  rt.recordCoverage(3, { status: 'partial', missing: 'y' });
  assert.deepEqual(rt.state.snapshot().flags, ["Slide 2: didn't mention x", "Slide 3: didn't mention y"]);
  rt.recordCoverage(2, { status: 'partial', missing: 'z' });
  assert.deepEqual(rt.state.snapshot().flags, ["Slide 3: didn't mention y", "Slide 2: didn't mention z"]);
  rt.recordCoverage(3, { status: 'covered', missing: '' });
  assert.deepEqual(rt.state.snapshot().flags, ["Slide 2: didn't mention z"]);
  assert.deepEqual(rt.coverage[3], { status: 'covered', missing: '' });
});

test('setDurationMin updates the planned length in place', () => {
  const rt = createPresentationRuntime({ deck: deck(), durationMin: 45, now: () => 0 });
  assert.equal(rt.durationMin, 45);
  rt.setDurationMin(20);
  assert.equal(rt.durationMin, 20);
  assert.equal(rt.update().snapshot.remainingMs, 20 * 60000);
});
