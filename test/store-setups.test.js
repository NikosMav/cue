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

test('a one-field patch without settingsMeta switches the setup after another write made the renderer copy stale', () => {
  const { store, read } = loadStore(legacy);
  store.migrateFile();
  const staleView = store.redactForRenderer(store.getSettings());
  // The Smart pill writes through a fresh copy; the panel's copy is now one revision behind.
  store.setRendererSettings({ ...store.redactForRenderer(store.getSettings()), smart: true });
  assert.throws(() => store.setRendererSettings({ activeSetupId: 'any', settingsMeta: staleView.settingsMeta }), /Settings changed outside/);
  const before = read();
  store.setRendererSettings({ activeSetupId: 'any' });
  const after = read();
  assert.equal(after.activeSetupId, 'any');
  assert.equal(after.smart, true);
  assert.deepEqual({ ...after, activeSetupId: before.activeSetupId }, before, 'only activeSetupId changed');
});

test('without a completed migration, a legacy file is never overwritten; changes stay in memory', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { store, file } = loadStore(legacy);
  const original = fs.readFileSync(file, 'utf8');
  store.setSettings({ smart: true });
  store.setSettings({ answerLength: 'detailed' });
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'file on disk unchanged');
  assert.equal(store.getSettings().smart, true, 'change kept in memory');
  assert.equal(store.getSettings().answerLength, 'detailed');
  assert.equal(warn.mock.callCount(), 1, 'one warning per process');
});

test('a failed migrateFile throws, leaves the file as it was and blocks later saves', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { store, file, dir } = loadStore(legacy);
  fs.writeFileSync(path.join(dir, 'backups'), 'not a folder');
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.migrateFile());
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(store.migrationBlocked(), true, 'migrationBlocked() reflects the failed migration');
  store.setSettings({ smart: true });
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'a routine save does not write the new layout without a backup');
  assert.equal(store.getSettings().smart, true);
});

test('after a successful migrateFile, saves write normally', () => {
  const { store, read } = loadStore(legacy);
  assert.equal(store.migrateFile(), true);
  assert.equal(store.migrationBlocked(), false, 'migrationBlocked() clears after a successful migration');
  store.setSettings({ smart: true });
  assert.equal(read().smart, true);
  assert.equal(read().setupsVersion, 1);
});
