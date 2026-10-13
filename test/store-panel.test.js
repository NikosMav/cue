const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalModuleLoad = Module._load;

function loadStore(fileContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-panel-'));
  const file = path.join(dir, 'cue-data.json');
  if (fileContents !== undefined) fs.writeFileSync(file, JSON.stringify(fileContents, null, 2));
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => dir } };
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  const id = require.resolve('../src/store');
  delete require.cache[id];
  const store = require('../src/store');
  Module._load = originalModuleLoad;
  return store;
}

test('defaults carry empty windowBounds and an 18px answer text size', () => {
  const store = loadStore();
  const s = store.getSettings();
  assert.deepEqual(s.windowBounds, {});
  assert.equal(s.answerTextPx, 18);
});

test('a renderer patch cannot write windowBounds', () => {
  const store = loadStore();
  assert.ok(store.RENDERER_READ_ONLY.includes('windowBounds'));
  assert.equal('windowBounds' in store.stripRendererPatch({ windowBounds: { 1: { x: 0 } }, answerTextPx: 20 }), false);
  store.setSettings({ windowBounds: { 1: { x: 1, y: 2, width: 500, height: 400 } } });
  store.setRendererSettings({ windowBounds: { 1: { x: 9, y: 9, width: 9, height: 9 } } });
  assert.deepEqual(store.getSettings().windowBounds[1], { x: 1, y: 2, width: 500, height: 400 });
});

test('answerTextPx is normalised on save', () => {
  const store = loadStore();
  assert.equal(store.setSettings({ answerTextPx: 40 }).answerTextPx, 32);
  assert.equal(store.setSettings({ answerTextPx: 'big' }).answerTextPx, 18);
  assert.equal(store.setSettings({ answerTextPx: 22 }).answerTextPx, 22);
  assert.equal(store.setRendererSettings({ answerTextPx: 10 }).answerTextPx, 14);
});
