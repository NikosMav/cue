const assert = require('node:assert/strict');
const test = require('node:test');
const {
  layoutMode, clampBounds, defaultBounds, boundsForDisplay, displayForBounds,
  answerScale, growForOverlay, restoreHeight
} = require('../src/panel-layout');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const LAPTOP = { id: 1, workArea: WA };
const MONITOR = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

test('layoutMode switches at 760', () => {
  assert.equal(layoutMode(759), 'narrow');
  assert.equal(layoutMode(760), 'wide');
});
test('clampBounds enforces the minimum and keeps the window on the work area', () => {
  assert.deepEqual(clampBounds({ x: 10, y: 10, width: 100, height: 100 }, WA), { x: 10, y: 10, width: 420, height: 300 });
  assert.deepEqual(clampBounds({ x: 1800, y: 900, width: 3000, height: 2000 }, WA), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(clampBounds({ x: 1700, y: 900, width: 640, height: 560 }, WA), { x: 1280, y: 480, width: 640, height: 560 });
});
test('defaultBounds is 640x560 at the top centre', () => {
  assert.deepEqual(defaultBounds(WA), { x: 640, y: 6, width: 640, height: 560 });
});
test('boundsForDisplay keeps a saved size per display', () => {
  const saved = { 1: { x: 100, y: 50, width: 700, height: 500 }, 2: { x: 2000, y: 100, width: 1100, height: 900 } };
  assert.deepEqual(boundsForDisplay(saved, [LAPTOP, MONITOR], null), saved[1]);
  assert.deepEqual(boundsForDisplay({ 2: saved[2] }, [LAPTOP, MONITOR], null), saved[2]);
});
test('a window saved on an unplugged monitor opens on the nearest display, clamped', () => {
  const b = boundsForDisplay({ 2: { x: 2000, y: 100, width: 2400, height: 1300 } }, [LAPTOP], null);
  assert.ok(b.x >= 0 && b.x + b.width <= 1920 && b.y >= 0 && b.y + b.height <= 1040);
  assert.equal(b.width, 1920);
});
test('legacy windowX/windowY becomes a 640x560 window at that spot', () => {
  assert.deepEqual(boundsForDisplay({}, [LAPTOP], { windowX: 300, windowY: 40 }), { x: 300, y: 40, width: 640, height: 560 });
  assert.deepEqual(boundsForDisplay(null, [LAPTOP], null), defaultBounds(WA));
});
test('displayForBounds picks the display holding the centre, else the nearest', () => {
  assert.equal(displayForBounds({ x: 2000, y: 100, width: 600, height: 400 }, [LAPTOP, MONITOR]), MONITOR);
  assert.equal(displayForBounds({ x: 5000, y: 100, width: 600, height: 400 }, [LAPTOP, MONITOR]), MONITOR);
  assert.equal(displayForBounds({ x: -900, y: 100, width: 600, height: 400 }, [LAPTOP, MONITOR]), LAPTOP);
});
test('answerScale clamps to 14..32 and defaults to 18', () => {
  assert.equal(answerScale(10), 14); assert.equal(answerScale(40), 32); assert.equal(answerScale(21.4), 21);
  assert.equal(answerScale('x'), 18); assert.equal(answerScale(undefined), 18);
});
test('growForOverlay grows small windows to 760x640 and never shrinks big ones', () => {
  assert.deepEqual(growForOverlay({ x: 100, y: 50, width: 500, height: 400 }, WA), { x: 100, y: 50, width: 760, height: 640 });
  assert.deepEqual(growForOverlay({ x: 100, y: 50, width: 1000, height: 900 }, WA), { x: 100, y: 50, width: 1000, height: 900 });
  assert.deepEqual(growForOverlay({ x: 1600, y: 700, width: 500, height: 300 }, WA), { x: 1160, y: 400, width: 760, height: 640 });
});
test('restoreHeight brings back the saved height only', () => {
  assert.deepEqual(restoreHeight({ x: 0, y: 0, width: 640, height: 560 }, { x: 50, y: 60, width: 700, height: 44 }), { x: 50, y: 60, width: 700, height: 560 });
});
test('boundsForDisplay ignores malformed saved entries', () => {
  assert.deepEqual(boundsForDisplay({ 1: {} }, [LAPTOP], null), defaultBounds(WA));
  assert.deepEqual(boundsForDisplay({ 1: { x: 5 } }, [LAPTOP], { windowX: 300, windowY: 40 }), { x: 300, y: 40, width: 640, height: 560 });
  assert.deepEqual(boundsForDisplay({ 9: { x: 5, width: 700 } }, [LAPTOP], null), defaultBounds(WA));
  assert.deepEqual(boundsForDisplay({ 1: { x: 5, y: 'a', width: 700, height: 500 } }, [LAPTOP], null), defaultBounds(WA));
  assert.deepEqual(boundsForDisplay({ 1: { x: 5 }, 2: { x: 2000, y: 100, width: 1100, height: 900 } }, [LAPTOP, MONITOR], null), { x: 2000, y: 100, width: 1100, height: 900 });
});
test('boundsForDisplay with no displays falls back to a default work area', () => {
  assert.deepEqual(boundsForDisplay(null, [], null), { x: 0, y: 0, width: 640, height: 560 });
  assert.deepEqual(boundsForDisplay({ 1: { x: 100, y: 50, width: 700, height: 500 } }, [], null), { x: 100, y: 50, width: 700, height: 500 });
  assert.deepEqual(boundsForDisplay(null, undefined, { windowX: 9000, windowY: 40 }), { x: 640, y: 40, width: 640, height: 560 });
});
