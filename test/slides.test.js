const test = require('node:test');
const assert = require('node:assert');
const {
  hashRGBA,
  hammingDistance,
  shouldEmitSlide,
  createSlideStore,
  clampSlidesConfig,
  buildSlideSystem,
  buildSlideUser
} = require('../src/slides');

function solidRGBA(w, h, r, g, b) {
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255;
  }
  return buf;
}

function halfSplitRGBA(w, h) {
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const left = x < w / 2;
      buf[i * 4] = left ? 0 : 255;
      buf[i * 4 + 1] = left ? 0 : 255;
      buf[i * 4 + 2] = left ? 0 : 255;
      buf[i * 4 + 3] = 255;
    }
  }
  return buf;
}

test('hashRGBA is stable for identical frames', () => {
  const a = hashRGBA(16, 16, solidRGBA(16, 16, 200, 200, 200));
  const b = hashRGBA(16, 16, solidRGBA(16, 16, 200, 200, 200));
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 16);
});

test('hashRGBA differs for clearly different slides', () => {
  const a = hashRGBA(16, 16, solidRGBA(16, 16, 20, 20, 20));
  const b = hashRGBA(16, 16, halfSplitRGBA(16, 16));
  assert.ok(hammingDistance(a, b) > 5);
});

test('hashRGBA returns null for tiny/invalid input', () => {
  assert.strictEqual(hashRGBA(4, 4, Buffer.alloc(64)), null);
  assert.strictEqual(hashRGBA(16, 16, null), null);
});

test('shouldEmitSlide debounces flicker until stable', () => {
  const a = '0'.repeat(16);
  const b = 'f'.repeat(16);
  // first sighting of change: not yet stable
  let r = shouldEmitSlide(a, b, { threshold: 5, stableCount: 0, requiredStable: 2 });
  assert.strictEqual(r.emit, false);
  assert.strictEqual(r.stableCount, 1);
  // second consecutive changed poll: emit
  r = shouldEmitSlide(a, b, { threshold: 5, stableCount: 1, requiredStable: 2 });
  assert.strictEqual(r.emit, true);
  // same slide resets
  r = shouldEmitSlide(a, a, { threshold: 5, stableCount: 1, requiredStable: 2 });
  assert.strictEqual(r.emit, false);
  assert.strictEqual(r.stableCount, 0);
  // first-ever slide emits
  r = shouldEmitSlide(null, b, {});
  assert.strictEqual(r.emit, true);
});

test('slide store caps at maxSlides and clears', () => {
  const s = createSlideStore({ maxSlides: 3 });
  for (let i = 0; i < 5; i++) s.add({ hash: String(i), caption: 'c' + i, txStart: i, txEnd: i });
  assert.strictEqual(s.count(), 3);
  assert.strictEqual(s.list()[0].caption, 'c2');
  s.clear();
  assert.strictEqual(s.count(), 0);
});

test('clampSlidesConfig bounds untrusted settings', () => {
  const c = clampSlidesConfig({ enabled: true, intervalMs: 100, threshold: 99, maxSlides: 9999 });
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.intervalMs, 1500);
  assert.strictEqual(c.threshold, 20);
  assert.strictEqual(c.maxSlides, 200);
});

test('slide prompt builders stay text-only and bounded', () => {
  assert.ok(buildSlideSystem().includes('Caption') || buildSlideSystem().includes('caption') || buildSlideSystem().length > 20);
  const u = buildSlideUser([{ channel: 'them', text: 'hello' }]);
  assert.ok(u.includes('Them: hello'));
});
