// "Script source: Use my speaker notes as written" (presentation setups).
const test = require('node:test');
const assert = require('node:assert/strict');
const { importDeck, enrichDeck } = require('../src/deck-import');
const { extractDeck, NOTES_CHARS } = require('../src/deck-extract');
const { makeSetup, normalizeSetups, effectiveSettings } = require('../src/setups');
const { makePptx } = require('./fixtures/make-deck');

const GREEK_NOTES = [
  'Καλώς ήρθατε στο πρώτο μάθημα. Σήμερα θα δούμε τι είναι ένα API και γιατί το χρειαζόμαστε.',
  '▶ Δείξτε το διάγραμμα στην οθόνη',
  'Ένα API είναι μια συμφωνία ανάμεσα σε δύο προγράμματα:\nτο ένα ζητά, το άλλο απαντά.',
  '⏸ Παύση για ερωτήσεις',
  '◀ Πίσω στη διαφάνεια 2',
  'Στο επόμενο βίντεο θα γράψουμε το πρώτο μας αίτημα.'
];
const GREEK_SCRIPT = GREEK_NOTES.join('\n');

const neverCall = async () => { throw new Error('no LLM call in notes mode'); };

async function importNotesDeck(slides) {
  const buffer = await makePptx(slides);
  const { deck, toEnrich } = await importDeck({ buffer, type: 'pptx', fileName: 'lesson-1-2.pptx', scriptSource: 'notes' });
  return { deck, toEnrich };
}

test('Script source is a presentation setup option, "write" by default, stored like Follow slides', () => {
  assert.equal(makeSetup({ kind: 'presentation' }).scriptSource, 'write');
  assert.equal(makeSetup({ kind: 'general' }).scriptSource, undefined);
  const s = normalizeSetups({ setups: [
    { id: 'a', name: 'A', kind: 'presentation', scriptSource: 'notes', followSlides: 'keys' },
    { id: 'b', name: 'B', kind: 'presentation', scriptSource: 'whatever' },
    { id: 'c', name: 'C', kind: 'general', scriptSource: 'notes' }
  ] });
  const [a, b, c] = ['a', 'b', 'c'].map((id) => s.setups.find((x) => x.id === id));
  assert.equal(a.scriptSource, 'notes');
  assert.equal(b.scriptSource, 'write');
  assert.equal(c.scriptSource, undefined);
  const flat = effectiveSettings({ ...s, setupsVersion: 1, activeSetupId: 'a' });
  assert.equal(flat.scriptSource, 'notes');
  assert.equal(flat.followSlides, 'keys');
});

test('notes as written: the script is the notes exactly, Greek and line breaks included, with no LLM call', async () => {
  const { deck, toEnrich } = await importNotesDeck([
    { title: 'Τι είναι ένα API', body: ['Ορισμός', 'Παραδείγματα'], notes: GREEK_NOTES },
    { title: 'Χωρίς σημειώσεις', body: ['Εικόνα'] }
  ]);
  assert.deepEqual(toEnrich, [1, 2]);
  assert.equal(deck.slides[0].notes, GREEK_SCRIPT, 'paragraphs and the soft line break survive extraction');
  const batches = [];
  const out = await enrichDeck(deck, { ns: toEnrich, call: neverCall, scriptSource: 'notes', scriptLength: 'short', onBatch: (d, done, total, ns) => batches.push({ done, total, ns }) });
  const [one, two] = out.slides;
  assert.equal(one.script, GREEK_SCRIPT, 'no trimming to the Short word limit');
  assert.deepEqual([one.points, one.questions, one.keyIdea, one.enrichError], [[], [], '', false]);
  assert.equal(two.script, '', 'a slide without notes gets an empty script');
  assert.deepEqual([two.points, two.questions, two.keyIdea, two.enrichError], [[], [], '', false]);
  assert.deepEqual(batches, [{ done: 1, total: 1, ns: [1, 2] }], 'progress reports once, finished');
});

test('notes as written keep stage-direction lines on their own lines', async () => {
  const { deck, toEnrich } = await importNotesDeck([{ title: 'A', notes: GREEK_NOTES }]);
  const { slides: [s] } = await enrichDeck(deck, { ns: toEnrich, call: neverCall, scriptSource: 'notes' });
  const lines = s.script.split('\n');
  for (const mark of ['▶', '⏸', '◀']) assert.ok(lines.some((l) => l.startsWith(mark)), mark);
});

test('a script of about 900 characters is not cut by NOTES_CHARS', async () => {
  const long = 'Αυτή είναι μια πρόταση του σεναρίου μου για το μάθημα. '.repeat(18).trim();
  assert.ok(long.length >= 900 && long.length < NOTES_CHARS, String(long.length));
  const { slides } = await extractDeck(await makePptx([{ title: 'A', notes: long }]), 'pptx');
  assert.equal(slides[0].notes, long);
});

test('notes mode leaves hand-edited slides alone and fills only a missing script', async () => {
  const deck = {
    version: 1, source: { fileName: 'x.pptx', type: 'pptx', sha256: 'h' }, matchCache: {},
    slides: [
      { n: 1, title: 'A', body: '', notes: 'σημειώσεις 1', fingerprint: 'a', points: ['mine'], questions: [], keyIdea: '', script: 'my own words', edited: true, enrichError: false },
      { n: 2, title: 'B', body: '', notes: 'σημειώσεις 2', fingerprint: 'b', points: ['mine'], questions: [], keyIdea: 'k', script: '', edited: true, enrichError: false }
    ]
  };
  const out = await enrichDeck(deck, { ns: [1, 2], call: neverCall, scriptSource: 'notes' });
  assert.equal(out.slides[0].script, 'my own words');
  assert.equal(out.slides[1].script, 'σημειώσεις 2');
  assert.deepEqual(out.slides[1].points, ['mine']);
  assert.equal(out.slides[1].keyIdea, 'k');
});

test('re-importing in notes mode takes corrected notes for unedited slides', async () => {
  const first = await importNotesDeck([{ title: 'A', body: ['x'], notes: 'παλιό' }]);
  const enriched = await enrichDeck(first.deck, { ns: first.toEnrich, call: neverCall, scriptSource: 'notes' });
  const buffer = await makePptx([{ title: 'A', body: ['x'], notes: 'διορθωμένο' }]);
  const again = await importDeck({ buffer, type: 'pptx', fileName: 'lesson-1-2.pptx', previous: enriched, scriptSource: 'notes' });
  assert.deepEqual(again.toEnrich, [1]);
  const out = await enrichDeck(again.deck, { ns: again.toEnrich, call: neverCall, scriptSource: 'notes' });
  assert.equal(out.slides[0].script, 'διορθωμένο');
});

test('"Write it for me" still calls the model', async () => {
  const deck = { version: 1, source: {}, matchCache: {}, slides: [{ n: 1, title: 'A', body: 'b', notes: 'n', fingerprint: 'a', points: [], questions: [], keyIdea: '', script: '', edited: false, enrichError: false }] };
  let calls = 0;
  const reply = JSON.stringify([{ n: 1, script: 'Hello.', points: ['p'], questions: [], keyIdea: 'k' }]);
  const out = await enrichDeck(deck, { ns: [1], call: async () => { calls++; return reply; } });
  assert.equal(calls, 1);
  assert.equal(out.slides[0].script, 'Hello.');
});
