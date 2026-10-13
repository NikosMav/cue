const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// main.js and preload.js need Electron to run, so the window wiring is
// guarded by inspecting their source.
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function body(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  const end = main.indexOf('\n}', start);
  return main.slice(start, end);
}

test('main uses the panel layout helpers', () => {
  assert.match(main, /require\('\.\/src\/panel-layout'\)/);
  assert.match(body('createWindow'), /boundsForDisplay\(/);
});

test('no moved handler resets the window to a fixed size', () => {
  assert.doesNotMatch(main, /width: W, height: H/);
  assert.doesNotMatch(main, /const W = 700, H = 600/);
  const moved = main.match(/win\.on\('moved',[\s\S]*?\n {2}\}\);/g) || [];
  for (const handler of moved) assert.doesNotMatch(handler, /setBounds|setSize/);
});

test('moves and resizes save bounds per display, debounced 500 ms', () => {
  assert.match(main, /win\.on\('moved', scheduleBoundsSave\)/);
  assert.match(main, /win\.on\('resized', scheduleBoundsSave\)/);
  assert.match(body('scheduleBoundsSave'), /setTimeout\(saveWindowBounds, 500\)/);
  const save = body('saveWindowBounds');
  assert.match(save, /windowState\.hidden/);
  assert.match(save, /windowState\.overlayRestore/);
  assert.match(save, /displayForBounds\(/);
  assert.match(save, /store\.setSettings\(\{ windowBounds \}\)/);
});

test('displays are passed primary first', () => {
  assert.match(body('displaysPrimaryFirst'), /\[primary, \.\.\.screen\.getAllDisplays\(\)\.filter\(\(d\) => d\.id !== primary\.id\)\]/);
  assert.match(body('createWindow'), /displaysPrimaryFirst\(\)/);
});

test('legacy windowX/windowY migrate to windowBounds and are cleared', () => {
  assert.match(body('createWindow'), /windowBounds: \{ \.\.\.previous, \[display\.id\]: bounds \}, windowX: null, windowY: null/);
});

test('the window keeps a 420x300 minimum', () => {
  assert.match(body('createWindow'), /win\.setMinimumSize\(MIN_SIZE\.width, MIN_SIZE\.height\)/);
});

test('window IPC is registered', () => {
  for (const ch of ['window:resize-start', 'window:resize-end', 'window:set-hidden', 'window:overlay']) {
    assert.match(main, new RegExp(`ipcMain\\.on\\('${ch}'`), ch);
  }
});

test('resize polls the cursor every 16 ms and stops on a destroyed window', () => {
  const start = main.slice(main.indexOf("ipcMain.on('window:resize-start'"));
  const handler = start.slice(0, start.indexOf('\n});'));
  assert.match(handler, /windowState\.hidden\) return/);
  assert.match(handler, /screen\.getCursorScreenPoint\(\)/);
  assert.match(handler, /clampBounds\(/);
  assert.match(handler, /isDestroyed\(\)\) \{ stopResize\(\)/);
  assert.match(handler, /, 16\)/);
});

test('hide and overlay sizes use restoreHeight and growForOverlay', () => {
  assert.match(body('setWindowHidden'), /restoreHeight\(/);
  assert.match(body('setWindowOverlay'), /growForOverlay\(/);
});

test('preload exposes the window bridge', () => {
  assert.match(preload, /resizeStart: \(\) => ipcRenderer\.send\('window:resize-start'\)/);
  assert.match(preload, /resizeEnd: \(\) => ipcRenderer\.send\('window:resize-end'\)/);
  assert.match(preload, /setHidden: \(hidden, headerHeight\) => ipcRenderer\.send\('window:set-hidden', \{ hidden: !!hidden, headerHeight: Number\(headerHeight\) \}\)/);
  assert.match(preload, /setOverlay: \(open\) => ipcRenderer\.send\('window:overlay', !!open\)/);
});

test('window protections are unchanged', () => {
  assert.match(main, /win\.setContentProtection\(true\)/);
  assert.match(main, /win\.setAlwaysOnTop\(true, 'screen-saver', 1\)/);
  assert.match(main, /winOptions\.type = 'toolbar'/);
  assert.match(main, /win\.showInactive\(\)/);
});
