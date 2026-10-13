const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeckStore, normalizeDeck } = require('../src/deck-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cue-deck-'));

const mkDeck = (title) => ({
  version: 1,
  source: { fileName: 'a.pptx', type: 'pptx', sha256: 'abc' },
  slides: [{ n: 1, title, body: 'b', notes: 'n', fingerprint: 'f', points: ['p'], questions: ['q'], keyIdea: 'k', script: 's', edited: true, enrichError: false }],
  matchCache: { ['a'.repeat(64)]: 2 },
});

test('save then load round-trips; remove deletes file and .bak', () => {
  const dir = tmp();
  const store = new DeckStore({ dir });
  const file = store.fileFor('setup-1');
  assert.equal(file, 'setup-1.json');
  store.save(file, mkDeck('A'));
  store.save(file, mkDeck('B'));
  assert.deepEqual(store.load(file), mkDeck('B'));
  assert.ok(fs.existsSync(path.join(dir, file)));
  assert.ok(fs.existsSync(path.join(dir, file + '.bak')));
  store.remove(file);
  assert.ok(!fs.existsSync(path.join(dir, file)));
  assert.ok(!fs.existsSync(path.join(dir, file + '.bak')));
  assert.ok(!fs.existsSync(path.join(dir, file + '.tmp')));
  assert.equal(store.load(file), null);
});

test('a corrupt deck file is recovered from .bak', () => {
  const dir = tmp();
  const store = new DeckStore({ dir });
  const file = store.fileFor('s');
  store.save(file, mkDeck('A'));
  store.save(file, mkDeck('B'));
  fs.writeFileSync(path.join(dir, file), '{garbage');
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(store.load(file).slides[0].title, 'A');
  } finally {
    console.error = origErr;
  }
});

test('normalizeDeck drops bad slides and non-numeric cache entries', () => {
  const d = normalizeDeck({ version: 1, source: { fileName: 'a.pptx', type: 'pptx', sha256: 'x' },
    slides: [{ n: 1, title: 'A', points: ['p', 5] }, 'junk'], matchCache: { abcd: 3, bad: 'x', ['f'.repeat(64)]: 1 } });
  assert.equal(d.slides.length, 1);
  assert.deepEqual(d.slides[0].points, ['p']);
  assert.deepEqual(d.matchCache, { ['f'.repeat(64)]: 1 });
  const old = normalizeDeck({ slides: [{}], matchCache: { ['e'.repeat(16)]: 2 } });
  assert.deepEqual(old.matchCache, {}, 'keys from the earlier 64-bit hash are dropped');
});

test('normalizeDeck fills defaults, bounds cache values, rejects non-decks', () => {
  const d = normalizeDeck({ slides: [{}], matchCache: { ['a'.repeat(64)]: 151, ['b'.repeat(64)]: 1.5, ['c'.repeat(64)]: 150, ['d'.repeat(64)]: 0 } });
  assert.deepEqual(d.slides[0], { n: 1, title: '', body: '', notes: '', fingerprint: '', points: [], questions: [], keyIdea: '', script: '', edited: false, enrichError: false });
  assert.equal(d.version, 1);
  assert.deepEqual(d.matchCache, { ['c'.repeat(64)]: 150, ['d'.repeat(64)]: 0 });
  assert.equal(normalizeDeck(null), null);
  assert.equal(normalizeDeck('x'), null);
  assert.equal(normalizeDeck({}), null);
  assert.equal(normalizeDeck({ slides: 'no' }), null);
});

test('fileFor rejects ids with path characters', () => {
  const s = new DeckStore({ dir: tmp() });
  assert.throws(() => s.fileFor('../x'));
  assert.throws(() => s.fileFor(''));
  assert.throws(() => s.fileFor(5));
});

test('normalizeDeck keeps a slide script and defaults it to empty', () => {
  const d = normalizeDeck({ slides: [{ n: 1, script: 'Hello there.' }, { n: 2 }, { n: 3, script: 7 }] });
  assert.deepEqual(d.slides.map((s) => s.script), ['Hello there.', '', '']);
});
