const test = require('node:test');
const assert = require('node:assert/strict');
const { acceleratorFromEvent, formatAccelerator } = require('../src/accelerator');

test('key presses become portable accelerators', () => {
  assert.equal(acceleratorFromEvent({ code: 'KeyH', metaKey: true, shiftKey: true }, 'darwin').accelerator, 'CommandOrControl+Shift+H');
  assert.equal(acceleratorFromEvent({ code: 'KeyH', ctrlKey: true, shiftKey: true }, 'win32').accelerator, 'CommandOrControl+Shift+H');
  assert.equal(acceleratorFromEvent({ code: 'ArrowUp', ctrlKey: true, altKey: true }, 'linux').accelerator, 'CommandOrControl+Alt+Up');
  assert.equal(acceleratorFromEvent({ code: 'Enter', metaKey: true }, 'darwin').accelerator, 'CommandOrControl+Return');
  assert.equal(acceleratorFromEvent({ code: 'KeyK', ctrlKey: true }, 'darwin').accelerator, 'Control+K');
  assert.equal(acceleratorFromEvent({ code: 'Slash', ctrlKey: true, shiftKey: true }, 'win32').accelerator, 'CommandOrControl+Shift+/');
  assert.equal(acceleratorFromEvent({ code: 'F8' }, 'win32').accelerator, 'F8');
});

test('lone modifiers wait; plain or Shift-only keys are refused', () => {
  assert.equal(acceleratorFromEvent({ code: 'ShiftLeft', shiftKey: true }, 'darwin').accelerator, null);
  assert.equal(acceleratorFromEvent({ code: 'ShiftLeft', shiftKey: true }, 'darwin').error, undefined);
  assert.ok(acceleratorFromEvent({ code: 'KeyA' }, 'win32').error);
  assert.ok(acceleratorFromEvent({ code: 'KeyA', shiftKey: true }, 'win32').error);
});

test('accelerators are shown with platform labels', () => {
  assert.equal(formatAccelerator('CommandOrControl+Alt+Shift+Up', 'darwin'), '⌘⌥⇧↑');
  assert.equal(formatAccelerator('CommandOrControl+Shift+Backspace', 'win32'), 'Ctrl+Shift+Backspace');
  assert.equal(formatAccelerator('CommandOrControl+Return', 'win32'), 'Ctrl+Enter');
  assert.equal(formatAccelerator('', 'win32'), '');
});
