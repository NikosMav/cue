const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPromptRequest, buildDebriefRequest } = require('../src/prompts');
const { migrateSettings, effectiveSettings } = require('../src/setups');
const { detectGeneralCategory } = require('../src/interview-context');
const golden = require('./fixtures/interview-prompts.json');

const modes = ['assist', 'say', 'followup', 'recap', 'ask', 'answerThis', 'practiceQuestion', 'practiceFeedback'];

test('an interview setup produces byte-identical prompts to the single-profile version', () => {
  const settings = effectiveSettings(migrateSettings(golden.profile).settings);
  assert.equal(settings.setupKind, 'interview');
  for (const mode of modes) {
    assert.equal(buildPromptRequest(settings, mode, golden.transcript, 'Why this company?').system, golden.prompts[mode], mode);
  }
  assert.equal(buildDebriefRequest(settings, { kind: 'interview', transcript: golden.transcript, answers: [] }).system, golden.prompts.debrief);
});

function generalSettings() {
  const s = migrateSettings({ setupsVersion: 1 }).settings;
  s.aboutMe = { resumeText: 'Synthetic CV', stories: '', workStyle: '' };
  s.setups = [...s.setups, { id: 'g', name: 'Team sync', kind: 'general', conversation: 'Weekly platform sync; I lead the API work.', notes: 'Release is Friday.', instructions: '' }];
  s.activeSetupId = 'g';
  return effectiveSettings(s);
}

const INTERVIEW_WORDS = /\bcandidate\b|\binterviewer\b|\bhire\b|job interview|mock interview/i;

test('general setups never frame the user as a candidate', () => {
  const settings = generalSettings();
  // Two segments within the merge window: say/assist restate the joined point.
  const t = [{ channel: 'them', text: 'Quick one before we wrap,', ts: 1000 }, { channel: 'them', text: 'where are we on the API migration?', ts: 4000 }];
  for (const mode of ['assist', 'say', 'followup', 'recap', 'ask', 'answerThis']) {
    const { system, turns } = buildPromptRequest(settings, mode, t, 'Where are we on the API migration?');
    assert.doesNotMatch(system, INTERVIEW_WORDS, mode + ' system');
    assert.doesNotMatch(turns[turns.length - 1].text, INTERVIEW_WORDS, mode + ' user turn');
  }
  assert.match(buildPromptRequest(settings, 'say', t).turns[0].text, /The current point \(joined from consecutive speech segments\): "Quick one before we wrap, where are we on the API migration\?"/);
});

test('the general layer carries the situation instruction and the setup description', () => {
  const { system } = buildPromptRequest(generalSettings(), 'say', [{ channel: 'them', text: 'Thoughts?', ts: 1 }]);
  assert.match(system, /Work out what kind of conversation this is/);
  assert.match(system, /Do not assume anyone is being evaluated/);
  assert.match(system, /This conversation and the user's role ===\nWeekly platform sync/);
  assert.match(system, /Notes for this conversation/);
});

test('general recap lists decisions and action items; follow-up targets the other participants', () => {
  const settings = generalSettings();
  assert.match(buildPromptRequest(settings, 'recap', []).system, /Decisions made[\s\S]*Action items/);
  assert.match(buildPromptRequest(settings, 'followup', []).system, /raise with the other participants/);
});

test('general debrief reviews decisions, action items and the user\'s contributions', () => {
  const { system, turns } = buildDebriefRequest(generalSettings(), { kind: 'interview', transcript: [{ channel: 'you', text: 'I will ship Friday.', ts: 1 }], answers: [] });
  assert.match(system, /## Decisions[\s\S]*## Action items[\s\S]*## Your contributions/);
  assert.doesNotMatch(system, INTERVIEW_WORDS);
  assert.match(turns[0].text, /^Conversation transcript:/);
});

test('general answers get a situation-neutral label', () => {
  const at = (text) => [{ channel: 'them', text, ts: 1 }];
  assert.equal(detectGeneralCategory(at('Should we go with option B?')), 'decision');
  assert.equal(detectGeneralCategory(at('Any update on the release?')), 'update');
  assert.equal(detectGeneralCategory(at('What do you think about the schema?')), 'question');
  assert.equal(detectGeneralCategory(at('Sounds good.')), 'general');
  assert.equal(buildPromptRequest(generalSettings(), 'say', at('Should we go with option B?')).category, 'decision');
});
