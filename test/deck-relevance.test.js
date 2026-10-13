const test = require('node:test');
const assert = require('node:assert/strict');
const { deckOutline, relevantSlides } = require('../src/deck-relevance');

test('deckOutline writes one line per slide and omits an empty key idea', () => {
  const deck = { slides: [{ n: 1, title: 'Intro', keyIdea: '' }, { n: 2, title: 'Big-O', keyIdea: 'Count steps' }] };
  assert.equal(deckOutline(deck), '1. Intro\n2. Big-O — Count steps');
  assert.equal(deckOutline(null), '');
  assert.equal(deckOutline({ slides: [] }), '');
});

const slides = [
  { n: 1, title: 'Welcome', body: 'Course logistics', questions: [] },
  { n: 2, title: 'Sorting basics', body: 'Bubble sort compares neighbours', questions: ['Why is bubble sort slow?'] },
  { n: 3, title: 'Merge sort', body: 'Divide the array and merge sorted halves', questions: [] },
  { n: 4, title: 'Quick sort', body: 'Pick a pivot and partition the array', questions: ['What pivot is best?'] },
  { n: 5, title: 'Heaps', body: 'Priority queue as an array', questions: [] },
  { n: 6, title: 'Pivot choice', body: 'Median of three pivot partition', questions: [] },
  { n: 7, title: 'Graphs', body: 'Vertices and edges', questions: [] }
];

const PIVOT = 'How do you choose the pivot to partition the array?';

test('relevantSlides scores shared words, skips neighbours and needs a score of 2', () => {
  // pivot + partition (+ array) are shared with slides 4 and 6.
  assert.deepEqual(relevantSlides(PIVOT, slides, 1).map((s) => s.n), [4, 6]);
  // With slide 5 current, 4 and 6 are neighbours and skipped; 3 and 5 share
  // only "array" (score 1), so nothing qualifies.
  assert.deepEqual(relevantSlides(PIVOT, slides, 5), []);
  // One shared content word is not enough.
  assert.deepEqual(relevantSlides('Tell me about graphs', slides, 1), []);
  // Stop words never count toward the score.
  assert.deepEqual(relevantSlides('the and of to is a', slides, 1), []);
});

test('relevantSlides counts question text, breaks ties by lower n and honours the limit', () => {
  assert.deepEqual(relevantSlides('Why is bubble sort slow?', slides, 7).map((s) => s.n), [2]);
  const tie = [
    { n: 9, title: 'cache misses', body: '', questions: [] },
    { n: 3, title: 'cache misses', body: '', questions: [] },
    { n: 6, title: 'cache misses', body: '', questions: [] },
    { n: 12, title: 'cache misses', body: '', questions: [] }
  ];
  assert.deepEqual(relevantSlides('cache misses', tie, 30).map((s) => s.n), [3, 6, 9]);
  assert.deepEqual(relevantSlides('cache misses', tie, 30, 2).map((s) => s.n), [3, 6]);
  assert.deepEqual(relevantSlides('cache misses', tie, null).map((s) => s.n), [3, 6, 9]);
  assert.deepEqual(relevantSlides('', tie, 1), []);
  assert.deepEqual(relevantSlides('cache misses', null, 1), []);
});

test('relevantSlides ranks the higher score first', () => {
  const s = [
    { n: 1, title: 'pivot partition', body: '', questions: [] },
    { n: 8, title: 'pivot partition array', body: '', questions: [] }
  ];
  assert.deepEqual(relevantSlides('pivot partition array', s, 20).map((x) => x.n), [8, 1]);
});

test('slideContext: current, existing neighbours and relevant slides', () => {
  const { slideContext } = require('../src/deck-relevance');
  const ctx = slideContext({ slides }, 5, PIVOT);
  assert.equal(ctx.current.n, 5);
  assert.deepEqual(ctx.neighbours.map((s) => s.n), [4, 6]);
  assert.deepEqual(ctx.relevant.map((s) => s.n), []);
  const first = slideContext({ slides }, 1, PIVOT);
  assert.deepEqual(first.neighbours.map((s) => s.n), [2]);
  assert.deepEqual(first.relevant.map((s) => s.n), [4, 6]);
  assert.deepEqual(slideContext({ slides }, 7, 'x').neighbours.map((s) => s.n), [6]);
});

test('slideContext: no current slide or no deck', () => {
  const { slideContext } = require('../src/deck-relevance');
  const noCurrent = slideContext({ slides }, null, PIVOT);
  assert.equal(noCurrent.current, null);
  assert.deepEqual(noCurrent.neighbours, []);
  assert.deepEqual(noCurrent.relevant.map((s) => s.n), [4, 6]);
  assert.deepEqual(slideContext(null, 3, PIVOT), { current: null, neighbours: [], relevant: [] });
  assert.deepEqual(slideContext({ slides }, 99, 'x').current, null);
});
