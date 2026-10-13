// Pure presentation state: current slide, pacing, skips, flags, coverage trigger.
const FLICK_MS = 8000;
const COVERAGE_MIN_DWELL_MS = 20000;
const ON_TRACK_FRACTION = 0.15;

function shouldCheckCoverage(left) {
  return !!left && left.dwellMs >= COVERAGE_MIN_DWELL_MS;
}

function createPresentationState({ durationMin, slideCount, now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const count = Number.isInteger(slideCount) && slideCount > 0 ? slideCount : 0;
  const mins = Number(durationMin);
  const durationMs = (Number.isFinite(mins) && mins > 0 ? mins : 0) * 60000;

  let startTs = null;
  let current = null;
  let enterTs = null;
  let offDeck = false;
  const visited = new Set(); // slides with a completed visit >= FLICK_MS
  const skipped = new Set();
  const timeline = [];
  const flags = [];

  function start() {
    if (startTs === null) startTs = clock();
  }

  function setSlide(n, _opts) {
    if (!count || !Number.isInteger(n) || n < 1 || n > count) return { left: null };
    start();
    if (n === current) {
      offDeck = false;
      return { left: null };
    }
    const t = clock();
    let left = null;
    if (current !== null) {
      const open = timeline[timeline.length - 1];
      open.leaveTs = t;
      const dwellMs = Math.max(0, t - enterTs);
      left = { n: current, enterTs, leaveTs: t, dwellMs };
      if (dwellMs >= FLICK_MS) visited.add(current);
      if (n > current) {
        for (let k = current + 1; k < n; k++) if (!visited.has(k)) skipped.add(k);
      }
    }
    skipped.delete(n);
    current = n;
    enterTs = t;
    offDeck = false;
    timeline.push({ n, enterTs: t, leaveTs: null });
    return { left };
  }

  function setOffDeck(flag) {
    offDeck = !!flag;
  }

  function addFlag(text) {
    const s = typeof text === 'string' ? text.trim() : '';
    if (s) flags.push(s);
  }

  function pacing(remainingMs) {
    if (!count) return { status: 'none', minutes: 0 };
    if (current === null || !durationMs) return { status: 'on', minutes: 0 };
    let remainingSlides = 1;
    for (let k = current + 1; k <= count; k++) if (!visited.has(k)) remainingSlides++;
    const expected = durationMs / count;
    const margin = remainingMs - remainingSlides * expected;
    const minutes = Math.round(Math.abs(margin) / 60000);
    if (Math.abs(margin) <= ON_TRACK_FRACTION * durationMs) return { status: 'on', minutes };
    return { status: margin > 0 ? 'ahead' : 'behind', minutes };
  }

  function snapshot() {
    const remainingMs = startTs === null
      ? durationMs
      : Math.min(durationMs, Math.max(0, startTs + durationMs - clock()));
    return {
      current,
      slideCount: count,
      offDeck,
      remainingMs,
      pacing: pacing(remainingMs),
      skipped: [...skipped].sort((a, b) => a - b),
      flags: flags.slice(),
      timeline: timeline.map((v) => ({ n: v.n, enterTs: v.enterTs, leaveTs: v.leaveTs })),
    };
  }

  return { start, setSlide, setOffDeck, addFlag, snapshot };
}

module.exports = {
  createPresentationState, shouldCheckCoverage, FLICK_MS, COVERAGE_MIN_DWELL_MS, ON_TRACK_FRACTION,
};
