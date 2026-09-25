// store.js requires electron for app.getPath('userData'); stub it the way
// llm.test.js stubs the openai SDK, pointing userData at a temp directory.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalModuleLoad = Module._load;

// Re-requires src/store.js (and settings-store-core.js) fresh, pointed at
// `dir`, without touching whatever is already on disk there — simulates the
// next app launch reading the same userData directory.
function openStoreAt(dir) {
  const file = path.join(dir, 'cue-data.json');
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => dir } };
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/settings-store-core')];
  const store = require('../src/store');
  Module._load = originalModuleLoad;
  return { store, file, dir, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function loadStore(fileContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-'));
  const file = path.join(dir, 'cue-data.json');
  if (fileContents !== undefined) fs.writeFileSync(file, typeof fileContents === 'string' ? fileContents : JSON.stringify(fileContents, null, 2));
  return openStoreAt(dir);
}

const AVAILABLE = { available: true, appToken: 'pat_cue_x', disclosureVersion: 1 };
const UNAVAILABLE = { available: false, appToken: '', disclosureVersion: 1 };

test('external profile import is seen without restart; an old settings window cannot erase it', () => {
  const { store, file, read } = loadStore({ apiKeys: { openai: 'test-only-key' }, resumeText: 'Original' });
  store.migrateFile();  // As main.js does at launch: back up, then write the setups layout
  const oldWindow = store.redactForRenderer(store.getSettings());
  const imported = { ...read(), aboutMe: { ...read().aboutMe, resumeText: 'Updated profile' } };
  fs.writeFileSync(file, JSON.stringify(imported));
  assert.equal(store.getSettings().aboutMe.resumeText, 'Updated profile');
  assert.throws(() => store.setRendererSettings(oldWindow), /Settings changed outside/);
  assert.equal(read().aboutMe.resumeText, 'Updated profile');
  assert.equal(read().apiKeys.openai, 'test-only-key');
  const refreshed = store.redactForRenderer(store.getSettings());
  refreshed.answerLength = 'balanced';
  store.setRendererSettings(refreshed);
  assert.equal(read().answerLength, 'balanced');
  assert.equal(read().settingsMeta, undefined);
});

test('window movement and gateway updates do not invalidate a settings editor', () => {
  const { store, read } = loadStore({ apiKeys: { openai: 'test-only' } });
  store.migrateFile();
  const view = store.redactForRenderer(store.getSettings());
  store.setSettings({ windowX: 23 });
  store.setPublik({ balanceMicros: 50, apiKey: 'test-gateway-key' });
  store.setRendererSettings({ ...view, answerLength: 'detailed' });
  assert.equal(read().answerLength, 'detailed');
  assert.equal(read().apiKeys.publik, 'test-gateway-key');
  assert.equal(read().windowX, 23);
});

test('corrupt settings fail visibly without replacing existing data with blank defaults', () => {
  const { store, file } = loadStore('{broken-json');
  assert.throws(() => store.getSettings(), /Existing settings were not replaced/);
  assert.throws(() => store.setSettings({ smart: true }), /Existing settings were not replaced/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken-json');
});

test('Windows UTF-8 BOM is accepted without losing saved credentials', () => {
  const { store } = loadStore('\uFEFF' + JSON.stringify({ apiKeys: { openai: 'test-only' } }));
  assert.equal(store.getSettings().apiKeys.openai, 'test-only');
});

test('a failed write reports an error and keeps the original file', () => {
  const { store, file, read } = loadStore({ apiKeys: { openai: 'test-only' }, answerLength: 'brief' });
  store.migrateFile();
  const original = fs.readFileSync(file, 'utf8');
  const write = fs.writeFileSync;
  fs.writeFileSync = () => { throw Object.assign(new Error('test failure'), { code: 'ENOSPC' }); };
  try { assert.throws(() => store.setSettings({ answerLength: 'detailed' }), /Could not save Cue settings/); }
  finally { fs.writeFileSync = write; }
  assert.match(String(store.lastSaveError().message), /test failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(read().apiKeys.openai, 'test-only');
  assert.equal(store.getSettings().answerLength, 'brief');
});

test('old settings default to brief answers; style and screen preferences survive reload', () => {
  const { store, read } = loadStore({ provider: 'openai' });
  store.migrateFile();
  assert.equal(store.getSettings().answerLength, 'brief');
  assert.equal(store.getSettings().includeScreen, true);
  store.setSettings({ answerLength: 'detailed', includeScreen: false });
  const reloaded = loadStore(read()).store.getSettings();
  assert.equal(reloaded.answerLength, 'detailed');
  assert.equal(reloaded.includeScreen, false);
});

test('full interview KB persists across reloads and can be cleared without changing credentials', () => {
  const fixture = loadStore({ apiKeys: { openai: 'test-only-key' } });
  fixture.store.migrateFile();
  const knowledgeBase = 'Reference notes\n'.repeat(1600) + 'Final unknown detail: [X].';
  const setup = { id: 'interview', name: 'Interview', kind: 'interview', conversation: '', notes: knowledgeBase, whyCompany: '', whyLeaving: '', salaryTarget: '', questionsToAsk: '', instructions: '', saveSessions: true };
  fixture.store.setSettings({ setups: [setup], activeSetupId: 'interview' });
  const activeSetup = fixture.read().setups.find((s) => s.id === fixture.read().activeSetupId);
  assert.equal(activeSetup.notes, knowledgeBase);
  const reloaded = loadStore(fixture.read());
  const activeSetupReloaded = reloaded.store.getSettings().setups.find((s) => s.id === reloaded.store.getSettings().activeSetupId);
  assert.equal(activeSetupReloaded.notes, knowledgeBase);
  reloaded.store.setSettings({ setups: reloaded.store.getSettings().setups.map((s) => s.id === 'interview' ? { ...s, notes: '' } : s) });
  const activeSetupCleared = reloaded.read().setups.find((s) => s.id === reloaded.read().activeSetupId);
  assert.equal(activeSetupCleared.notes, '');
  assert.equal(reloaded.read().apiKeys.openai, 'test-only-key');
});

test('never overwrites a user key: an OpenAI user stays on OpenAI, file otherwise unchanged', () => {
  const fixture = { provider: 'openai', apiKeys: { openai: 'sk-proj-user-typed-this' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }, onboarded: true, aiRules: 'no em-dashes' };
  const { store, read } = loadStore(fixture);
  store.migrateFile();

  assert.equal(store.applyPublikDefault(AVAILABLE), false);

  const after = read();
  assert.equal(after.provider, 'openai');
  assert.equal(after.apiKeys.openai, 'sk-proj-user-typed-this');
  assert.equal(after.apiKeys.publik, '');
  assert.equal(after.publik.defaultApplied, true);
  // Every field the user had is still there, byte for byte.
  for (const [k, v] of Object.entries(fixture)) {
    if (k === 'apiKeys' || k === 'models') continue;
    assert.deepEqual(after[k], v, `field ${k} changed`);
  }
  assert.deepEqual(after.models.openai, fixture.models.openai);
});

test('first run (no file) with a token switches to publik; without a token it stays on openai', () => {
  const fresh = loadStore();
  assert.equal(fresh.store.applyPublikDefault(AVAILABLE), true);
  assert.equal(fresh.read().provider, 'publik');
  assert.equal(fresh.read().publik.defaultApplied, true);
  assert.equal(fresh.read().apiKeys.publik, '', 'the default switch never mints or writes a key');

  const noToken = loadStore();
  assert.equal(noToken.store.applyPublikDefault(UNAVAILABLE), false);
  assert.equal(noToken.store.getSettings().provider, 'openai');
  assert.equal(noToken.store.getSettings().publik.defaultApplied, false);
});

test('a Custom provider with a base URL is untouched', () => {
  const { store, read } = loadStore({ provider: 'custom', baseUrl: 'http://127.0.0.1:18789/v1', apiKeys: { custom: '' } });
  store.migrateFile();
  assert.equal(store.applyPublikDefault(AVAILABLE), false);
  assert.equal(read().provider, 'custom');
  assert.equal(read().baseUrl, 'http://127.0.0.1:18789/v1');
});

test('an Ollama user (URL in the key slot) is untouched', () => {
  const { store, read } = loadStore({ provider: 'ollama', apiKeys: { ollama: 'http://localhost:11434' } });
  store.migrateFile();
  assert.equal(store.applyPublikDefault(AVAILABLE), false);
  assert.equal(read().provider, 'ollama');
});

test('the switch happens once per settings file, even if the user later clears their key', () => {
  const { store, read } = loadStore({ provider: 'openai', apiKeys: { openai: 'sk-1' } });
  store.migrateFile();
  assert.equal(store.applyPublikDefault(AVAILABLE), false);
  store.setSettings({ apiKeys: { openai: '' } });
  assert.equal(store.applyPublikDefault(AVAILABLE), false);
  assert.equal(read().provider, 'openai');
});

test('stripRendererPatch drops the publik key and block, keeps everything else', () => {
  const { store } = loadStore();
  const out = store.stripRendererPatch({ provider: 'publik', apiKeys: { publik: 'pk_live_x', openai: 'sk-y' }, publik: { claimUrl: 'https://evil.example', disclosureAccepted: 9 }, aiRules: 'x' });
  assert.deepEqual(out, { provider: 'publik', apiKeys: { openai: 'sk-y' }, aiRules: 'x' });

  // Through setSettings, the way main.js wires settings:set.
  store.setPublik({ apiKey: 'pk_live_real', claimUrl: 'https://publikhq.com/claim/A' });
  store.setSettings(store.stripRendererPatch({ apiKeys: { publik: 'pk_live_forged', openai: 'sk-y' }, publik: { claimUrl: 'https://evil.example' } }));
  assert.equal(store.getSettings().apiKeys.publik, 'pk_live_real');
  assert.equal(store.getSettings().publik.claimUrl, 'https://publikhq.com/claim/A');
  assert.equal(store.getSettings().apiKeys.openai, 'sk-y');
});

test('redactForRenderer never returns the publik key, and reports connected', () => {
  const { store } = loadStore();
  store.setPublik({ apiKey: 'pk_live_' + 'a'.repeat(12) + '_' + 'b'.repeat(32), keyId: 'a'.repeat(12) });
  const view = store.redactForRenderer(store.getSettings());
  assert.equal(view.apiKeys.publik, '');
  assert.equal(view.publik.connected, true);
  assert.equal(view.publik.keyId, 'a'.repeat(12));
  assert.doesNotMatch(JSON.stringify(view), /pk_live_/);
  // The underlying store still has it.
  assert.match(store.getSettings().apiKeys.publik, /^pk_live_/);
});

test('setPublik writes only apiKeys.publik and publik.*', () => {
  const { store, read } = loadStore({ provider: 'openai', apiKeys: { openai: 'sk-keep' } });
  store.migrateFile();
  store.setPublik({ apiKey: 'pk_test_key', installId: 'u-1', balanceMicros: 250000, wallet: { claimState: 'anonymous', balanceMicros: 250000 } });
  const after = read();
  assert.equal(after.apiKeys.openai, 'sk-keep');
  assert.equal(after.apiKeys.publik, 'pk_test_key');
  assert.equal(after.publik.installId, 'u-1');
  assert.equal(after.publik.balanceMicros, 250000);
  assert.deepEqual(after.publik.wallet, { claimState: 'anonymous', balanceMicros: 250000 });
  assert.equal(after.provider, 'openai');
});

test('defaults carry the publik model aliases and the settings file is written 0600 where the OS supports it', () => {
  const { store, file } = loadStore();
  assert.deepEqual(store.getSettings().models.publik, { fast: 'publik-fast', smart: 'publik-balanced' });
  store.setSettings({});
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('opacity is persisted and clamped so the window cannot disappear', () => {
  const { store } = loadStore();
  assert.equal(store.getSettings().opacity, 1);
  assert.equal(store.clampOpacity(0.55), 0.55);
  assert.equal(store.clampOpacity(0), 0.2);
  assert.equal(store.clampOpacity(2), 1);
  assert.equal(store.clampOpacity('nope'), 1);
  store.setSettings({ opacity: 0.01 });
  assert.equal(store.getSettings().opacity, 0.2);
  store.setSettings({ opacity: 0.73 });
  assert.equal(store.getSettings().opacity, 0.73);
});

test('slide-caption app-link consent is tracked per caller, separately from the read/action scope grants', () => {
  const { store, read } = loadStore();
  assert.equal(store.getSlidesConsent('com.publikhq.iris'), undefined);

  store.setSlidesConsent('com.publikhq.iris', 'granted');
  assert.equal(store.getSlidesConsent('com.publikhq.iris'), 'granted');
  assert.equal(store.getSlidesConsent('some-other-caller'), undefined, 'consent is per caller, not global');
  assert.deepEqual(read().applinkSlidesConsent, { 'com.publikhq.iris': 'granted' });

  store.setSlidesConsent('some-other-caller', 'denied');
  assert.equal(store.getSlidesConsent('some-other-caller'), 'denied');
  assert.equal(store.getSlidesConsent('com.publikhq.iris'), 'granted', 'unaffected by a different caller');

  store.clearSlidesConsent('com.publikhq.iris');
  assert.equal(store.getSlidesConsent('com.publikhq.iris'), undefined);
  assert.equal(store.getSlidesConsent('some-other-caller'), 'denied', 'clearing one caller leaves others alone');
});

test('writes are atomic and a crash-corrupted file recovers from the previous generation instead of going blank', () => {
  const { store, file, dir } = loadStore();
  store.setSettings({ apiKeys: { openai: 'sk-previous' } });
  store.setSettings({ apiKeys: { openai: 'sk-previous', anthropic: 'sk-latest' } });
  assert.equal(store.getSettings().apiKeys.anthropic, 'sk-latest');

  // Simulate the crash mid-write that used to permanently blank every key.
  fs.writeFileSync(file, '{"apiKeys":{"ope');

  const { store: reloaded } = openStoreAt(dir);
  const recovered = reloaded.getSettings();
  assert.equal(recovered.apiKeys.openai, 'sk-previous', 'recovered from the .bak generation, not defaulted to blank');
  assert.equal(recovered.apiKeys.anthropic, '', 'the .bak generation predates the anthropic key — correctly the older value, not a crash artifact');
});

test('a rename blocked by another process (antivirus on Windows) still saves, with the previous save in .bak', () => {
  const { store, file } = loadStore({ apiKeys: { openai: 'sk-previous' } });
  store.migrateFile();
  store.setSettings({ answerLength: 'balanced' });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
  try { store.setSettings({ answerLength: 'detailed' }); }
  finally { fs.renameSync = rename; }
  assert.equal(store.lastSaveError(), null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).answerLength, 'detailed');
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).answerLength, 'balanced');
});

test('a deleted data directory is recreated on the next save', () => {
  const { store, dir, read } = loadStore();
  assert.equal(store.lastSaveError(), null);
  fs.rmSync(dir, { recursive: true, force: true }); // the directory disappears out from under a live store
  assert.equal(store.setSettings({ smart: true }).smart, true);
  assert.equal(read().smart, true);
  assert.equal(store.lastSaveError(), null);
});
