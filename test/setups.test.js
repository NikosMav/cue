const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUILTIN_SETUP_ID, SETUPS_VERSION, makeSetup, normalizeSetups, migrateSettings, activeSetup, effectiveSettings, updateSetup
} = require('../src/setups');

const legacy = {
  provider: 'openai',
  apiKeys: { openai: 'test-only-key' },
  models: { openai: { fast: 'm-fast', smart: 'm-smart' } },
  resumeText: 'Synthetic CV',
  starStories: 'Story A',
  workStyle: 'Calm',
  jobDescription: 'Backend role',
  knowledgeBase: 'Notes K',
  whyCompany: 'Mission',
  whyLeaving: 'Growth',
  salaryTarget: 'Defer',
  questionsToAsk: 'Q1',
  aiRules: 'Never use em dashes.',
  saveSessions: true,
  answerLength: 'balanced'
};

test('a new setup defaults to saving only for interviews', () => {
  assert.equal(makeSetup({ kind: 'interview' }).saveSessions, true);
  assert.equal(makeSetup({ kind: 'general' }).saveSessions, false);
  assert.equal(makeSetup({ kind: 'bogus' }).kind, 'general');
  assert.equal(makeSetup({ kind: 'general', saveSessions: true }).saveSessions, true);
});

test('migration moves personal material to About me and interview material to an "Interview" setup', () => {
  const { settings, migrated } = migrateSettings(legacy);
  assert.equal(migrated, true);
  assert.equal(settings.setupsVersion, SETUPS_VERSION);
  assert.deepEqual(settings.aboutMe, { resumeText: 'Synthetic CV', stories: 'Story A', workStyle: 'Calm' });
  const interview = settings.setups.find((s) => s.id === 'interview');
  assert.equal(interview.name, 'Interview');
  assert.equal(interview.kind, 'interview');
  assert.equal(interview.conversation, 'Backend role');
  assert.equal(interview.notes, 'Notes K');
  assert.equal(interview.instructions, 'Never use em dashes.');
  assert.equal(interview.saveSessions, true);
  assert.equal(settings.activeSetupId, 'interview');
  assert.equal(settings.aiRules, '');
  for (const f of ['resumeText', 'starStories', 'workStyle', 'jobDescription', 'knowledgeBase', 'whyCompany', 'whyLeaving', 'salaryTarget', 'questionsToAsk', 'saveSessions']) {
    assert.equal(f in settings, false, f + ' should be removed');
  }
  assert.deepEqual(settings.apiKeys, legacy.apiKeys);
  assert.deepEqual(settings.models, legacy.models);
  assert.equal(settings.answerLength, 'balanced');
  assert.ok(settings.setups.some((s) => s.id === BUILTIN_SETUP_ID));
});

test('migration without interview material keeps AI rules global and activates "Any conversation"', () => {
  const { settings } = migrateSettings({ resumeText: 'CV only', aiRules: 'No em dashes.' });
  assert.equal(settings.aiRules, 'No em dashes.');
  assert.equal(settings.activeSetupId, BUILTIN_SETUP_ID);
  assert.deepEqual(settings.setups.map((s) => s.id), [BUILTIN_SETUP_ID]);
  assert.equal(settings.aboutMe.resumeText, 'CV only');
});

test('migration is idempotent', () => {
  const once = migrateSettings(legacy).settings;
  const twice = migrateSettings(once);
  assert.equal(twice.migrated, false);
  assert.deepEqual(twice.settings, once);
});

test('normalization repairs a missing built-in setup, duplicates and a dangling active id', () => {
  const s = normalizeSetups({
    setupsVersion: 1,
    setups: [makeSetup({ id: 'a', name: 'A', kind: 'interview' }), { id: 'a', name: 'dup' }, null],
    activeSetupId: 'gone'
  });
  assert.deepEqual(s.setups.map((x) => x.id), [BUILTIN_SETUP_ID, 'a']);
  assert.equal(s.activeSetupId, BUILTIN_SETUP_ID);
  assert.deepEqual(s.aboutMe, { resumeText: '', stories: '', workStyle: '' });
});

test('the built-in setup always stays general with its fixed name', () => {
  const s = normalizeSetups({ setupsVersion: 1, setups: [{ id: BUILTIN_SETUP_ID, name: 'Renamed', kind: 'interview' }] });
  const builtin = s.setups[0];
  assert.equal(builtin.kind, 'general');
  assert.equal(builtin.name, 'Any conversation');
});

test('effective settings project About me and the active setup onto the flat fields', () => {
  const migrated = migrateSettings(legacy).settings;
  const e = effectiveSettings(migrated);
  assert.equal(e.resumeText, 'Synthetic CV');
  assert.equal(e.starStories, 'Story A');
  assert.equal(e.jobDescription, 'Backend role');
  assert.equal(e.knowledgeBase, 'Notes K');
  assert.equal(e.whyCompany, 'Mission');
  assert.equal(e.aiRules, 'Never use em dashes.');
  assert.equal(e.saveSessions, true);
  assert.equal(e.setupKind, 'interview');
  assert.equal(e.setupName, 'Interview');
});

test('a general setup hides interview-only fields and combines its instructions with global rules', () => {
  const s = normalizeSetups({
    setupsVersion: 1,
    aiRules: 'Global rule.',
    aboutMe: { resumeText: 'CV' },
    setups: [{ id: 'g', name: 'Team sync', kind: 'general', conversation: 'Weekly sync', notes: 'N', whyCompany: 'hidden', instructions: 'Be brief.' }],
    activeSetupId: 'g'
  });
  const e = effectiveSettings(s);
  assert.equal(e.whyCompany, '');
  assert.equal(e.jobDescription, 'Weekly sync');
  assert.equal(e.aiRules, 'Be brief.\n\nGlobal rule.');
  assert.equal(e.saveSessions, false);
  assert.equal(e.setupKind, 'general');
});

test('effective settings read a legacy file without writing it (compatibility path)', () => {
  const e = effectiveSettings(legacy);
  assert.equal(e.setupKind, 'interview');
  assert.equal(e.jobDescription, 'Backend role');
  assert.equal(legacy.jobDescription, 'Backend role', 'input not mutated');
});

test('activeSetup falls back to the built-in setup', () => {
  assert.equal(activeSetup({ setupsVersion: 1, setups: [], activeSetupId: 'x' }).id, BUILTIN_SETUP_ID);
});

test('updateSetup patches one setup and returns a new array', () => {
  const s = migrateSettings(legacy).settings;
  const next = updateSetup(s, 'interview', { saveSessions: false });
  assert.notEqual(next, s.setups);
  assert.equal(next.find((x) => x.id === 'interview').saveSessions, false);
  assert.equal(s.setups.find((x) => x.id === 'interview').saveSessions, true);
});
