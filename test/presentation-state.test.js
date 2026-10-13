const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPresentationState, FLICK_MS, COVERAGE_MIN_DWELL_MS, ON_TRACK_FRACTION, shouldCheckCoverage,
} = require('../src/presentation-state');

const MIN = 60000;
function make(opts) {
  const clock = { t: 0 };
  const st = createPresentationState({ now: () => clock.t, ...opts });
  return { st, clock };
}

test('constants', () => {
  assert.equal(FLICK_MS, 8000);
  assert.equal(COVERAGE_MIN_DWELL_MS, 20000);
  assert.equal(ON_TRACK_FRACTION, 0.15);
});

test('on track, ahead and behind follow the +-15% margin', () => {
  let { st, clock } = make({ durationMin: 40, slideCount: 40 });
  st.setSlide(1, { source: 'manual' });
  clock.t = 10 * MIN;
  st.setSlide(11, { source: 'manual' });
  let p = st.snapshot().pacing;
  assert.equal(p.status, 'on');
  assert.equal(p.minutes, 0);

  ({ st, clock } = make({ durationMin: 40, slideCount: 40 }));
  st.setSlide(1, { source: 'manual' });
  clock.t = 10 * MIN;
  st.setSlide(20, { source: 'manual' });
  p = st.snapshot().pacing;
  assert.equal(p.status, 'ahead');
  assert.equal(p.minutes, 9);

  ({ st, clock } = make({ durationMin: 40, slideCount: 40 }));
  st.setSlide(1, { source: 'manual' });
  clock.t = 20 * MIN;
  st.setSlide(5, { source: 'manual' });
  p = st.snapshot().pacing;
  assert.equal(p.status, 'behind');
  assert.equal(p.minutes, 16);
  assert.equal(st.snapshot().remainingMs, 20 * MIN);
});

test('a forward jump marks skipped slides; revisiting clears the skip', () => {
  const { st, clock } = make({ durationMin: 40, slideCount: 10 });
  st.setSlide(1, { source: 'manual' });
  clock.t = 30000;
  st.setSlide(4, { source: 'manual' });
  assert.deepEqual(st.snapshot().skipped, [2, 3]);
  clock.t = 60000;
  st.setSlide(2, { source: 'manual' });
  assert.deepEqual(st.snapshot().skipped, [3]);
});

test('a visited slide is not marked skipped by a later jump over it', () => {
  const { st, clock } = make({ durationMin: 40, slideCount: 10 });
  st.setSlide(3, { source: 'manual' });
  clock.t = 30000;
  st.setSlide(1, { source: 'manual' });
  clock.t = 60000;
  st.setSlide(5, { source: 'manual' });
  assert.deepEqual(st.snapshot().skipped, [2, 4]);
});

test('a visit under 8 s counts as flicked past, not visited, for pacing', () => {
  // 10 min, 10 slides: 1 min per slide. Start on 1, flick through 2 (5 s), back to 1.
  let { st, clock } = make({ durationMin: 10, slideCount: 10 });
  st.setSlide(1, { source: 'manual' });
  clock.t = 5000;
  st.setSlide(2, { source: 'manual' });
  clock.t = 10000;
  st.setSlide(1, { source: 'manual' });
  // Slide 2 was flicked: still counted as remaining. Slides 2..10 = 9, +1 current = 10.
  // remaining = 10 min - 10 s; margin = -10 s -> on, 0 min.
  let s = st.snapshot();
  assert.equal(s.remainingMs, 10 * MIN - 10000);
  assert.equal(s.pacing.status, 'on');

  // Same shape, but slide 2 gets a real 4 min visit: it drops out of remaining.
  ({ st, clock } = make({ durationMin: 10, slideCount: 10 }));
  st.setSlide(1, { source: 'manual' });
  clock.t = 5000;
  st.setSlide(2, { source: 'manual' });
  clock.t = 5000 + 4 * MIN;
  st.setSlide(1, { source: 'manual' });
  // remainingSlides = 8 + 1 = 9; remainingMs = 10 min - 4 min 5 s; margin = 5 min 55 s - 9 min = -3 min 5 s
  // that is within 15% of 10 min (1.5 min)? No, 3.08 > 1.5 -> behind, 3 min.
  s = st.snapshot();
  assert.equal(s.pacing.status, 'behind');
  assert.equal(s.pacing.minutes, 3);
});

test('left reports the visit just ended', () => {
  const { st, clock } = make({ durationMin: 40, slideCount: 10 });
  clock.t = 1000;
  assert.deepEqual(st.setSlide(1, { source: 'match' }), { left: null });
  clock.t = 31000;
  assert.deepEqual(st.setSlide(2, { source: 'match' }), {
    left: { n: 1, enterTs: 1000, leaveTs: 31000, dwellMs: 30000 },
  });
  assert.deepEqual(st.setSlide(2, { source: 'match' }), { left: null });
  assert.deepEqual(st.snapshot().timeline, [
    { n: 1, enterTs: 1000, leaveTs: 31000 },
    { n: 2, enterTs: 31000, leaveTs: null },
  ]);
});

test('setSlide to the current slide clears offDeck', () => {
  const { st } = make({ durationMin: 40, slideCount: 10 });
  st.setSlide(1, { source: 'match' });
  st.setOffDeck(true);
  assert.equal(st.snapshot().offDeck, true);
  assert.deepEqual(st.setSlide(1, { source: 'match' }), { left: null });
  assert.equal(st.snapshot().offDeck, false);
});

test('snapshot returns copies of internal arrays', () => {
  const { st, clock } = make({ durationMin: 40, slideCount: 10 });
  st.setSlide(1, { source: 'manual' });
  clock.t = 30000;
  st.setSlide(3, { source: 'manual' });
  st.addFlag('a');
  const s = st.snapshot();
  s.skipped.push(99);
  s.flags.push('x');
  s.timeline.push({});
  s.timeline[0].n = 77;
  const s2 = st.snapshot();
  assert.deepEqual(s2.skipped, [2]);
  assert.deepEqual(s2.flags, ['a']);
  assert.equal(s2.timeline.length, 2);
  assert.equal(s2.timeline[0].n, 1);
});

test('flags are appended oldest first; empty ignored', () => {
  const { st } = make({ durationMin: 40, slideCount: 10 });
  st.addFlag('first');
  st.addFlag('');
  st.addFlag('   ');
  st.addFlag('second');
  assert.deepEqual(st.snapshot().flags, ['first', 'second']);
});

test('past the planned end, remaining is 0 and status is behind, never NaN', () => {
  const { st, clock } = make({ durationMin: 5, slideCount: 10 });
  st.setSlide(1, { source: 'manual' });
  clock.t = 9 * MIN;
  st.setSlide(3, { source: 'manual' });
  const s = st.snapshot();
  assert.equal(s.remainingMs, 0);
  assert.equal(s.pacing.status, 'behind');
  assert.equal(s.pacing.minutes, 4);
});

test('clock values are finite and non-negative, before start and with clock skew', () => {
  const { st, clock } = make({ durationMin: 5, slideCount: 10 });
  let s = st.snapshot();
  assert.equal(s.remainingMs, 5 * MIN);
  assert.equal(s.pacing.status, 'on');
  assert.equal(s.pacing.minutes, 0);
  assert.equal(s.current, null);
  clock.t = 100000;
  st.setSlide(2, { source: 'manual' });
  clock.t = 50000;
  s = st.snapshot();
  assert.ok(Number.isFinite(s.remainingMs) && s.remainingMs >= 0);
  assert.ok(Number.isFinite(s.pacing.minutes) && s.pacing.minutes >= 0);
  clock.t = 99 * MIN;
  s = st.snapshot();
  assert.ok(Number.isFinite(s.remainingMs) && s.remainingMs >= 0);
  assert.ok(Number.isFinite(s.pacing.minutes) && s.pacing.minutes >= 0);
});

test('no deck: slideCount 0 gives pacing none and ignores setSlide', () => {
  const st = createPresentationState({ durationMin: 45, slideCount: 0, now: () => 0 });
  assert.deepEqual(st.setSlide(1, { source: 'match' }), { left: null });
  assert.equal(st.snapshot().pacing.status, 'none');
  assert.equal(st.snapshot().pacing.minutes, 0);
});

test('setSlide beyond slideCount is ignored', () => {
  const { st } = make({ durationMin: 10, slideCount: 5 });
  st.setSlide(2, { source: 'manual' });
  assert.deepEqual(st.setSlide(6, { source: 'manual' }), { left: null });
  assert.deepEqual(st.setSlide(0, { source: 'manual' }), { left: null });
  assert.deepEqual(st.setSlide(1.5, { source: 'manual' }), { left: null });
  assert.equal(st.snapshot().current, 2);
});

test('coverage is checked only after 20 s dwell', () => {
  assert.equal(shouldCheckCoverage({ dwellMs: 19999 }), false);
  assert.equal(shouldCheckCoverage({ dwellMs: 20000 }), true);
  assert.equal(shouldCheckCoverage(null), false);
});
