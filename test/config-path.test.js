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
  assert.equal(result.aboutMe.resumeText, 'Synthetic CV');
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
  assert.ok(Array.isArray(status.setups));
  assert.ok(status.aboutMeFields.includes('resumeText'));
  assert.ok(!result.includes('Synthetic CV'), 'status never prints field contents');
});

test('profile import fills About me and a named setup, creating it and making it active', () => {
  const settings = { apiKeys: { openai: 'test-only-key' }, setupsVersion: 1, setups: [], activeSetupId: 'any' };
  const result = mergeProfile(settings, {
    resumeText: 'Synthetic CV', starStories: 'Story', jobDescription: 'Backend role', knowledgeBase: 'Notes',
    aiRules: 'Be brief.', answerLength: 'balanced'
  }, { setupName: 'Acme interview' });
  const setup = result.setups.find((s) => s.name === 'Acme interview');
  assert.equal(setup.kind, 'interview');
  assert.equal(setup.conversation, 'Backend role');
  assert.equal(setup.notes, 'Notes');
  assert.equal(setup.instructions, 'Be brief.');
  assert.equal(result.activeSetupId, setup.id);
  assert.deepEqual(result.aboutMe, { resumeText: 'Synthetic CV', stories: 'Story', workStyle: '' });
  assert.equal(result.answerLength, 'balanced');
  assert.equal(result.apiKeys.openai, 'test-only-key');
});

test('re-importing into an existing setup updates it instead of adding a second one', () => {
  let s = mergeProfile({ setupsVersion: 1, setups: [] }, { jobDescription: 'v1' }, { setupName: 'Acme interview' });
  s = mergeProfile(s, { jobDescription: 'v2' }, { setupName: 'acme INTERVIEW' });
  const matches = s.setups.filter((x) => x.name === 'Acme interview');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].conversation, 'v2');
});

test('an interview profile imported without --setup never lands in the built-in "Any conversation" setup', () => {
  const settings = { setupsVersion: 1, setups: [], activeSetupId: 'any' };
  let s = mergeProfile(settings, { resumeText: 'Synthetic CV', jobDescription: 'Backend role', whyCompany: 'Mission' });
  const builtin = s.setups.find((x) => x.id === 'any');
  assert.equal(builtin.conversation, '');
  assert.equal(builtin.whyCompany, '');
  const imported = s.setups.filter((x) => x.name === 'Imported interview');
  assert.equal(imported.length, 1);
  assert.equal(imported[0].kind, 'interview');
  assert.equal(imported[0].conversation, 'Backend role');
  assert.equal(imported[0].whyCompany, 'Mission');
  assert.equal(s.activeSetupId, imported[0].id);
  assert.equal(s.aboutMe.resumeText, 'Synthetic CV');
  // A second import reuses that setup, even after switching back to the built-in one.
  s = mergeProfile({ ...s, activeSetupId: 'any' }, { jobDescription: 'Platform role' });
  assert.equal(s.setups.filter((x) => x.name === 'Imported interview').length, 1);
  assert.equal(s.setups.find((x) => x.name === 'Imported interview').conversation, 'Platform role');
  assert.equal(s.setups.find((x) => x.id === 'any').conversation, '');
});

test('a general profile imported without --setup still fills the active built-in setup', () => {
  const s = mergeProfile({ setupsVersion: 1, setups: [], activeSetupId: 'any' }, { notes: 'Team notes' });
  assert.equal(s.setups.find((x) => x.id === 'any').notes, 'Team notes');
  assert.equal(s.setups.length, 1);
});

test('mergeProfile warns when interview-only fields land in a general setup with no --setup given', () => {
  const settings = {
    setupsVersion: 1,
    setups: [{ id: 'g', name: 'Team sync', kind: 'general' }],
    activeSetupId: 'g'
  };
  const warnings = [];
  const result = mergeProfile(settings, { whyCompany: 'Mission' }, { warnings });
  assert.equal(result.setups.find((s) => s.id === 'g').whyCompany, 'Mission', 'the field is still imported');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Team sync/);
  assert.match(warnings[0], /general setup/);
  assert.match(warnings[0], /--setup/);
});

test('mergeProfile does not warn when the target setup is an interview setup', () => {
  const settings = {
    setupsVersion: 1,
    setups: [{ id: 'i', name: 'Acme interview', kind: 'interview' }],
    activeSetupId: 'i'
  };
  const warnings = [];
  mergeProfile(settings, { whyCompany: 'Mission' }, { warnings });
  assert.equal(warnings.length, 0);
});

test('mergeProfile does not warn when --setup is given, even for a general target', () => {
  const settings = {
    setupsVersion: 1,
    setups: [{ id: 'g', name: 'Team sync', kind: 'general' }],
    activeSetupId: 'g'
  };
  const warnings = [];
  mergeProfile(settings, { whyCompany: 'Mission' }, { setupName: 'Team sync', warnings });
  assert.equal(warnings.length, 0);
});

test('import-profile refuses a --setup flag without a name and changes nothing', t => {
  const { root, data } = fixture(t);
  const file = path.join(data, 'cue-data.json');
  fs.writeFileSync(file, JSON.stringify({ apiKeys: { openai: 'k' }, provider: 'openai' }));
  const before = fs.readFileSync(file, 'utf8');
  const profile = path.join(root, 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ jobDescription: 'Backend role' }));
  const run = (args) => { try { execFileSync(process.execPath, [path.join(__dirname, '../scripts/cue-config.js'), ...args], { env: { ...process.env, CUE_DATA_DIR: data }, encoding: 'utf8', stdio: 'pipe' }); return null; } catch (e) { return e; } };
  const missingName = run(['import-profile', profile, '--setup']);
  assert.ok(missingName, 'must fail');
  assert.match(String(missingName.stderr), /--setup needs a setup name/);
  const flagFirst = run(['import-profile', '--setup', 'Acme', profile]);
  assert.ok(flagFirst, 'must fail');
  assert.match(String(flagFirst.stderr), /Usage: node scripts\/cue-config\.js import-profile/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
