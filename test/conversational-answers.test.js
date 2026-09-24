const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPromptRequest, MODES } = require('../src/prompts');
const { detectCategory } = require('../src/interview-context');

const them = text => ({ channel: 'them', text });
const settings = {
  resumeText: 'Alex moved from support to software development.',
  starStories: 'Fixed a duplicate import by adding an idempotency check. No measured impact available.',
  workStyle: 'Wants to deepen technical expertise. Management goals are unconfirmed.',
  salaryTarget: 'Prefer to discuss the scope before compensation.'
};

test('current conversational questions are classified independently of an earlier STAR question', () => {
  const cases = [
    ['How did you change to this position?', 'experience'],
    ['How do you see yourself in five years?', 'motivation'],
    ['What was your biggest and most important decision?', 'behavioral'],
    ['What was the most important bug you fixed?', 'behavioral'],
    ['What are your salary expectations?', 'compensation'],
    ['What is TCP?', 'technical'],
    ['Anything else?', 'general']
  ];
  for (const [question, expected] of cases) {
    assert.equal(detectCategory([them('Tell me about a time you failed.'), them(question)]), expected, question);
  }
});

test('selected and typed questions select their own reference context', () => {
  for (const mode of ['ask', 'answerThis']) {
    const request = buildPromptRequest(settings, mode,
      [them('Tell me about a time you failed.')], 'What are your salary expectations?');
    assert.equal(request.category, 'compensation');
    assert.match(request.system, /Prefer to discuss the scope before compensation/);
    assert.doesNotMatch(request.system, /Fixed a duplicate import/);
  }
});

test('request remains consistent when new speech and changed preferences arrive during capture', () => {
  const transcript = [them('How do you see yourself in five years?')];
  const prefs = { ...settings, answerLength: 'brief' };
  const request = buildPromptRequest(prefs, 'say', transcript);
  transcript[0].text = 'What are your salary expectations?';
  prefs.answerLength = 'detailed';
  assert.equal(request.category, 'motivation');
  assert.match(request.turns[0].text, /five years/);
  assert.doesNotMatch(request.turns[0].text, /salary expectations/);
  assert.match(request.system, /40–70 words/);
});

test('spoken modes use selectable length without old mandatory STAR expansion', () => {
  for (const mode of ['assist', 'say', 'ask', 'answerThis']) {
    const brief = MODES[mode].buildSystem(null, '', 'brief');
    assert.match(brief, /40–70 words/);
    assert.match(brief, /then stop/);
    assert.doesNotMatch(brief, /Action \(2–3 sentences|complete STAR answer|2–5 sentences/);
    assert.match(MODES[mode].buildSystem(null, '', 'balanced'), /70–110 words/);
    assert.match(MODES[mode].buildSystem(null, '', 'detailed'), /120–180 words/);
    assert.equal(MODES[mode].buildSystem(null, '', 'invalid'), brief);
  }
});

test('conversation-only skips images, while coding retains the screen and excludes personal notes', () => {
  const prefs = { ...settings, includeScreen: false, knowledgeBase: 'PRIVATE_REFERENCE' };
  for (const mode of ['assist', 'ask']) {
    assert.equal(buildPromptRequest(prefs, mode, []).needsScreen, false);
    assert.equal(buildPromptRequest({}, mode, []).needsScreen, true);
  }
  const coding = buildPromptRequest(prefs, 'leetcode', []);
  assert.equal(coding.needsScreen, true);
  assert.doesNotMatch(coding.system, /PRIVATE_REFERENCE|40–70 words/);
  assert.match(coding.system, /solution in a fenced code block/);
});
