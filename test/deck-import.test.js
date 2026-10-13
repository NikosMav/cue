const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { importDeck, enrichDeck, appendQuestions } = require('../src/deck-import');
const { DeckError } = require('../src/deck-extract');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const slide = (n, title, extra = {}) => ({ n, title, body: 'body ' + title, notes: '', fingerprint: 'fp-' + title, ...extra });
const full = (n, title, extra = {}) => ({ ...slide(n, title), points: [], questions: [], keyIdea: '', edited: false, enrichError: false, ...extra });
const extractor = (slides) => async () => ({ slides });

test('same file re-import is a no-op', async () => {
  const buffer = Buffer.from('same');
  const previous = { version: 1, source: { fileName: 'a.pptx', type: 'pptx', sha256: sha(buffer) }, slides: [full(1, 'A')], matchCache: {} };
  const r = await importDeck({ buffer, type: 'pptx', fileName: 'a.pptx', previous, extract: async () => { throw new Error('should not extract'); } });
  assert.equal(r.unchanged, true);
  assert.equal(r.deck, previous);
  assert.deepEqual(r.toEnrich, []);
});

test('re-import carries edited content by fingerprint, even when slides move, and clears the cache', async () => {
  const previous = {
    version: 1, source: { fileName: 'a.pptx', type: 'pptx', sha256: 'old' },
    slides: [full(1, 'A', { points: ['mine'], edited: true, keyIdea: 'k' }), full(2, 'B', { points: ['b'] })],
    matchCache: { ['a'.repeat(16)]: 1 },
  };
  const r = await importDeck({ buffer: Buffer.from('new'), type: 'pptx', fileName: 'b.pptx', previous, extract: extractor([slide(1, 'B'), slide(2, 'A'), slide(3, 'C')]) });
  assert.equal(r.unchanged, false);
  const [b, a, c] = r.deck.slides;
  assert.deepEqual(a.points, ['mine']);
  assert.equal(a.edited, true);
  assert.equal(a.keyIdea, 'k');
  assert.deepEqual(b.points, ['b']);
  assert.equal(b.edited, false);
  assert.deepEqual(c.points, []);
  assert.deepEqual(r.toEnrich, [3]);
  assert.deepEqual(r.deck.matchCache, {});
  assert.equal(r.deck.source.fileName, 'b.pptx');
  assert.equal(r.deck.source.sha256, sha(Buffer.from('new')));
});

test('a deck with no visible slides is rejected', async () => {
  await assert.rejects(
    importDeck({ buffer: Buffer.from('x'), type: 'pdf', fileName: 'x.pdf', previous: null, extract: extractor([]) }),
    (e) => e instanceof DeckError && e.message === 'The deck has no visible slides.'
  );
});

const tenSlides = () => ({ version: 1, source: { fileName: 'a', type: 'pptx', sha256: 'x' }, slides: Array.from({ length: 10 }, (_, i) => full(i + 1, 'S' + (i + 1))), matchCache: {} });
const okResponse = (ns) => JSON.stringify(ns.map((n) => ({ n, points: ['p' + n], questions: ['q' + n], keyIdea: 'k' + n })));
const batchNs = (request) => JSON.parse(request.turns[0].text.split('Slides to write for (JSON):\n')[1]).map((s) => s.n);

test('a failed batch marks only its slides and enrichment continues', async () => {
  let calls = 0;
  const progress = [];
  const out = await enrichDeck(tenSlides(), {
    ns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    conversation: 'talk', notes: '',
    call: async (request) => { calls++; if (calls === 1) throw new Error('boom'); return okResponse(batchNs(request)); },
    onBatch: (d, done, total) => progress.push([done, total]),
  });
  assert.equal(calls, 2);
  for (const s of out.slides.slice(0, 8)) assert.equal(s.enrichError, true);
  for (const s of out.slides.slice(8)) { assert.equal(s.enrichError, false); assert.deepEqual(s.points, ['p' + s.n]); assert.equal(s.keyIdea, 'k' + s.n); }
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

test('an empty parse marks the batch as failed', async () => {
  const out = await enrichDeck(tenSlides(), { ns: [1, 2], call: async () => 'not json at all', onBatch() {} });
  assert.equal(out.slides[0].enrichError, true);
  assert.equal(out.slides[1].enrichError, true);
  assert.equal(out.slides[2].enrichError, false);
});

test('edited slides are never sent for enrichment', async () => {
  const deck = tenSlides();
  deck.slides[1].edited = true;
  deck.slides[1].points = ['mine'];
  const sent = [];
  const out = await enrichDeck(deck, {
    ns: [1, 2, 3],
    call: async (request) => { const ns = batchNs(request); sent.push(...ns); return okResponse(ns); },
    onBatch() {},
  });
  assert.deepEqual(sent, [1, 3]);
  assert.deepEqual(out.slides[1].points, ['mine']);
});

test('a duplicated n in a response keeps the first and ignores slides outside the batch', async () => {
  const out = await enrichDeck(tenSlides(), {
    ns: [1],
    call: async () => JSON.stringify([
      { n: 1, points: ['first'], questions: [], keyIdea: '' },
      { n: 1, points: ['second'], questions: [], keyIdea: '' },
      { n: 5, points: ['stray'], questions: [], keyIdea: '' },
    ]),
    onBatch() {},
  });
  assert.deepEqual(out.slides[0].points, ['first']);
  assert.deepEqual(out.slides[4].points, []);
});

test('appendQuestions dedupes, caps at 6 and marks edited', () => {
  const deck = { ...tenSlides() };
  deck.slides[0].questions = ['a', 'b', 'c', 'd', 'e'];
  const out = appendQuestions(deck, [{ n: 1, question: 'Q' }, { n: 1, question: 'q' }, { n: 1, question: 'new' }, { n: 1, question: 'A' }]);
  assert.deepEqual(out.slides[0].questions, ['a', 'b', 'c', 'd', 'e', 'Q']);
  assert.equal(out.slides[0].edited, true);
  assert.equal(out.slides[1].edited, false);
});
