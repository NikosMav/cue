const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalModuleLoad = Module._load;

function loadStore(fileContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-setups-'));
  const file = path.join(dir, 'cue-data.json');
  if (fileContents !== undefined) fs.writeFileSync(file, typeof fileContents === 'string' ? fileContents : JSON.stringify(fileContents, null, 2));
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => dir } };
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  const id = require.resolve('../src/store');
  delete require.cache[id];
  const store = require('../src/store');
  Module._load = originalModuleLoad;
  return { store, file, dir, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const legacy = {
  provider: 'openai', apiKeys: { openai: 'test-only-key' }, models: { openai: { fast: 'f', smart: 's' } },
  resumeText: 'Synthetic CV', jobDescription: 'Backend role', knowledgeBase: 'Notes', aiRules: 'Rule.', saveSessions: true
};

test('migrateFile backs up the old file, then writes the setups layout once', () => {
  const { store, dir, read } = loadStore(legacy);
  assert.equal(store.migrateFile(), true);
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^before-setups-/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'backups', backups[0]), 'utf8')), legacy);
  const saved = read();
  assert.equal(saved.setupsVersion, 1);
  assert.equal(saved.aboutMe.resumeText, 'Synthetic CV');
  assert.equal(saved.setups.find((s) => s.id === 'interview').conversation, 'Backend role');
  assert.equal(saved.apiKeys.openai, 'test-only-key');
  assert.equal('jobDescription' in saved, false);
  assert.equal(store.migrateFile(), false, 'second run is a no-op');
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
});

test('an unreadable file is left untouched by migrateFile', () => {
  const { store, file } = loadStore('{ not json');
  assert.throws(() => store.migrateFile());
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('without migrateFile, reading a legacy file still yields the setups shape and writes nothing', () => {
  const { store, read } = loadStore(legacy);
  const s = store.getSettings();
  assert.equal(s.activeSetupId, 'interview');
  assert.equal(read().jobDescription, 'Backend role', 'file not rewritten by a read');
});

test('a fresh install starts with only the built-in setup active', () => {
  const { store } = loadStore();
  const s = store.getSettings();
  assert.deepEqual(s.setups.map((x) => x.id), ['any']);
  assert.equal(s.activeSetupId, 'any');
  assert.equal('resumeText' in s, false);
});

test('saving from the renderer normalizes setups and cannot drop the built-in one', () => {
  const { store, read } = loadStore(legacy);
  store.migrateFile();
  const current = store.redactForRenderer(store.getSettings());
  store.setRendererSettings({ ...current, setups: [{ id: 'interview', name: 'Interview', kind: 'interview' }], activeSetupId: 'interview' });
  const saved = read();
  assert.deepEqual(saved.setups.map((x) => x.id), ['any', 'interview']);
  assert.equal(saved.apiKeys.openai, 'test-only-key');
});
