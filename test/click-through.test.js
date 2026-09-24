const assert = require('node:assert/strict');
const test = require('node:test');

const { interactiveAt, createClickThrough, placeOnDisplay } = require('../src/click-through');

const bounds = { x: 1000, y: 10, width: 700, height: 600 };
const toolbar = { x: 215, y: 14, width: 270, height: 40 };
const panel = { x: 38, y: 65, width: 624, height: 300 };

test('the pointer is interactive only over a reported UI rectangle, in window coordinates', () => {
  assert.equal(interactiveAt({ x: 1000 + 250, y: 10 + 30 }, bounds, [toolbar, panel]), true);   // on the drag handle
  assert.equal(interactiveAt({ x: 1000 + 300, y: 10 + 200 }, bounds, [toolbar, panel]), true);  // on the panel
  assert.equal(interactiveAt({ x: 1000 + 20, y: 10 + 30 }, bounds, [toolbar, panel]), false);   // transparent gap in the window
  assert.equal(interactiveAt({ x: 1000 + 300, y: 10 + 500 }, bounds, [toolbar, panel]), false); // below the panel
  assert.equal(interactiveAt({ x: 50, y: 50 }, bounds, [toolbar, panel]), false);               // another app entirely
});

function harness() {
  const calls = [];
  let cursor = { x: 0, y: 0 };
  const ct = createClickThrough({
    getCursor: () => cursor,
    getBounds: () => bounds,
    isActive: () => true,
    setIgnore: (ignore) => calls.push(ignore)
  });
  return { ct, calls, move: (x, y) => { cursor = { x: bounds.x + x, y: bounds.y + y }; ct.tick(); } };
}

test('arriving straight on the drag handle turns click-through off without any mouse event from Windows', () => {
  const { ct, calls, move } = harness();
  ct.setRects([toolbar, panel]);
  move(20, 300);   // transparent part of the window
  move(250, 30);   // jump onto the drag handle
  assert.deepEqual(calls, [true, false]);
});

test('click-through changes only when the answer changes, not on every tick', () => {
  const { ct, calls, move } = harness();
  ct.setRects([toolbar, panel]);
  // setRects checks once with the pointer elsewhere: click-through, as at startup.
  move(250, 30); move(260, 31); move(300, 200); move(20, 300); move(21, 301);
  assert.deepEqual(calls, [true, false, true]);
});

test('a dialog covering the window makes the whole window interactive at once', () => {
  const { ct, calls, move } = harness();
  ct.setRects([toolbar, panel]);
  move(20, 500);
  ct.setRects([{ x: 0, y: 0, width: 700, height: 600 }]); // settings scrim opened
  assert.deepEqual(calls, [true, false]);
});

test('an inactive window (hidden or a test override) is left alone', () => {
  const calls = [];
  const ct = createClickThrough({ getCursor: () => ({ x: 1250, y: 40 }), getBounds: () => bounds, isActive: () => false, setIgnore: (v) => calls.push(v) });
  ct.setRects([toolbar]);
  ct.tick();
  assert.deepEqual(calls, []);
});

const primary = { workArea: { x: 0, y: 0, width: 3440, height: 1392 } };
const laptop = { workArea: { x: -1707, y: 0, width: 1707, height: 1019 } };
const size = { width: 700, height: 600 };

test('a position saved on a secondary monitor is restored there, not clamped to the primary', () => {
  assert.deepEqual(placeOnDisplay({ x: -1400, y: 100 }, size, [primary, laptop]), { x: -1400, y: 100 });
});

test('a position that is now off every screen is pulled back onto the nearest one', () => {
  // The laptop was disconnected: -1400 is nowhere, so the primary takes it.
  assert.deepEqual(placeOnDisplay({ x: -1400, y: 100 }, size, [primary]), { x: -600, y: 100 });
  // Below the bottom edge of the primary.
  assert.deepEqual(placeOnDisplay({ x: 500, y: 5000 }, size, [primary, laptop]), { x: 500, y: 1352 });
});
