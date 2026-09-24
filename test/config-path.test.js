const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveDataDirectory } = require('../src/config-path');
const { mergeProfile } = require('../src/profile-import');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const packaged = path.join(root, 'packaged');
  const data = path.join(root, 'data');
  for (const dir of [source, packaged, data]) fs.mkdirSync(dir);
  return { root, source, packaged, data };
}

test('source and packaged locators resolve to the same data directory independent of APPDATA', t => {
  const { source, packaged, data } = fixture(t);
  const locator = JSON.stringify({ userDataDirectory: data });
  for (const appDirectory of [source, packaged]) {
    fs.writeFileSync(path.join(appDirectory, 'cue-local.json'), locator);
    assert.equal(resolveDataDirectory({ appDirectory, defaultDirectory: '/wrong/profile', env: { APPDATA: '/other/profile' } }), fs.realpathSync(data));
  }
});

test('missing or invalid explicit locations fail instead of quietly starting an empty profile', t => {
  const { source, data } = fixture(t);
  fs.writeFileSync(path.join(source, 'cue-local.json'), JSON.stringify({ userDataDirectory: path.join(data, 'missing') }));
  assert.throws(() => resolveDataDirectory({ appDirectory: source, defaultDirectory: data, env: {} }), /Refusing to start/);
  fs.writeFileSync(path.join(source, 'cue-local.json'), '{broken');
  assert.throws(() => resolveDataDirectory({ appDirectory: source, defaultDirectory: data, env: {} }), /Cannot read Cue data location/);
  assert.equal(resolveDataDirectory({ appDirectory: source, defaultDirectory: source, env: { CUE_DATA_DIR: data } }), fs.realpathSync(data));
});

test('profile import preserves keys and models even when a profile contains blank credential fields', () => {
  const settings = { apiKeys: { openai: 'test-only-key' }, models: { openai: { fast: 'chosen-model' } }, provider: 'openai' };
  const result = mergeProfile(settings, { apiKeys: { openai: '' }, models: {}, provider: 'gemini', resumeText: 'Synthetic CV', includeScreen: false });
  assert.deepEqual(result.apiKeys, settings.apiKeys);
  assert.deepEqual(result.models, settings.models);
  assert.equal(result.provider, 'openai');
  assert.equal(result.resumeText, 'Synthetic CV');
});

test('config CLI uses explicit data directory, preserves keys, and never prints their values', t => {
  const { root, data } = fixture(t);
  const key = 'synthetic-secret-do-not-print';
  const file = path.join(data, 'cue-data.json');
  fs.writeFileSync(file, JSON.stringify({ apiKeys: { openai: key }, provider: 'openai' }));
  const profile = path.join(root, 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ resumeText: 'Synthetic CV', answerLength: 'balanced' }));
  const result = execFileSync(process.execPath, [path.join(__dirname, '../scripts/cue-config.js'), 'import-profile', profile],
    { env: { ...process.env, CUE_DATA_DIR: data }, encoding: 'utf8' });
  assert.ok(!result.includes(key));
  const status = JSON.parse(result);
  assert.equal(status.settingsFile, path.join(data, 'cue-data.json'));
  assert.deepEqual(status.credentialProviders, ['openai']);
  assert.equal(JSON.parse(fs.readFileSync(file)).apiKeys.openai, key);
  assert.equal(fs.readdirSync(path.join(data, 'backups')).length, 1);
});
