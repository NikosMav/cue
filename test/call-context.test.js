const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPromptRequest } = require('../src/prompts');
const { appendAiRules } = require('../src/profile-context');
const { detectCategory } = require('../src/interview-context');

const at = (channel, text, ts) => ({ channel, text, ts });
const MINUTE = 60000;

// A call as speech-to-text delivers it: many short lines and back-channels.
function longCall(lines, { start = 0, step = 4000 } = {}) {
  const turns = [];
  for (let i = 0; i < lines; i++) {
    turns.push(at(i % 3 === 2 ? 'you' : 'them', i % 3 === 2 ? 'Mhm' : 'Line ' + i + ' of the call, with some ordinary detail.', start + i * step));
  }
  return turns;
}

const userTurn = (request) => request.turns[request.turns.length - 1].text;
const interview = { answerLength: 'balanced' };
const general = { setupKind: 'general', answerLength: 'balanced' };

test('assist and say see more than the last few lines of a fragmented call', () => {
  const turns = [at('them', 'The fee includes preparation time.', 0), ...longCall(40, { start: 1000 })];
  for (const settings of [interview, general]) {
    for (const mode of ['assist', 'say']) {
      assert.match(userTurn(buildPromptRequest(settings, mode, turns, '', { now: 200000 })), /The fee includes preparation time\./, mode);
    }
  }
});

test('the spoken window is bounded and keeps the latest lines', () => {
  const turns = longCall(3000);
  const text = userTurn(buildPromptRequest(interview, 'assist', turns, '', { now: turns[turns.length - 1].ts }));
  assert.ok(text.length < 30000, 'assist context stays bounded: ' + text.length);
  assert.match(text, /Line 2998 of the call/);
  assert.doesNotMatch(text, /Line 0 of the call/);
});

test('follow-up questions and recaps see the whole call', () => {
  const turns = longCall(600);
  for (const settings of [interview, general]) {
    for (const mode of ['followup', 'recap']) {
      const text = userTurn(buildPromptRequest(settings, mode, turns, '', { now: turns[turns.length - 1].ts }));
      assert.match(text, /Line 0 of the call/, mode);
      assert.match(text, /Line 597 of the call/, mode);
    }
  }
});

test('a very long transcript keeps its start and end', () => {
  const turns = longCall(3000);
  const text = userTurn(buildPromptRequest(interview, 'recap', turns));
  assert.ok(text.length < 62000, 'recap context stays bounded: ' + text.length);
  assert.match(text, /Line 0 of the call/);
  assert.match(text, /Line 2998 of the call/);
  assert.match(text, /middle of the conversation omitted/);
});

test('requests carry the time since the conversation started', () => {
  const turns = [at('them', 'Hello, thanks for joining.', 10 * MINUTE), at('them', 'Any more questions?', 36 * MINUTE)];
  for (const settings of [interview, general]) {
    for (const mode of ['assist', 'say', 'followup', 'answerThis', 'ask']) {
      const text = userTurn(buildPromptRequest(settings, mode, turns, 'Any more questions?', { now: 36 * MINUTE + 30000 }));
      assert.match(text, /Time since the conversation started: about 26 minutes\./, mode);
    }
  }
  assert.match(userTurn(buildPromptRequest(interview, 'say', [at('them', 'Hi', 1000)], '', { now: 20000 })), /under a minute/);
  assert.doesNotMatch(userTurn(buildPromptRequest(interview, 'say', [at('them', 'Hi')], '', { now: 20000 })), /Time since/);
});

test('earlier suggestions cover the last six spoken answers', () => {
  const answers = Array.from({ length: 7 }, (_, i) => ({ mode: 'assist', prompt: '', text: 'Suggestion number ' + i + '.' }));
  const text = userTurn(buildPromptRequest(interview, 'assist', [at('them', 'So, where was I?', 1000)], '', { answers, now: 2000 }));
  assert.doesNotMatch(text, /Suggestion number 0\./);
  for (let i = 1; i < 7; i++) assert.match(text, new RegExp('Suggestion number ' + i + '\\.'));
  assert.match(text, /do not suggest again a question/);
});

test('spoken prompts handle monologues, commitments and misheard terms', () => {
  for (const settings of [interview, general]) {
    for (const mode of ['assist', 'say']) {
      const { system } = buildPromptRequest(settings, mode, [at('them', 'Let me tell you how we work.', 1000)]);
      assert.match(system, /NO QUESTION/, mode);
      assert.match(system, /Do not open by thanking them, praising what they said, or restating it\./, mode);
      assert.match(system, /Never accept or agree to an offer/, mode);
      assert.match(system, /speech-to-text and may mishear names and terms/, mode);
      assert.match(system, /A length set in the user's rules replaces this default\./, mode);
    }
  }
});

test('assist and say restate the key checks right before the request', () => {
  for (const settings of [interview, general]) {
    for (const mode of ['assist', 'say']) {
      const text = userTurn(buildPromptRequest(settings, mode, [at('them', 'Let me tell you how we work.', 1000)], '', { now: 2000 }));
      assert.match(text, /Before you write: .*ask or request nothing.*already asked, answered or said.*Do not accept, endorse or agree to an offer.*length/s, mode);
    }
  }
});

test('follow-up questions skip what was already asked or answered', () => {
  for (const settings of [interview, general]) {
    assert.match(buildPromptRequest(settings, 'followup', [at('them', 'Hi', 1000)]).system, /already asked or answered/);
  }
});

test('user rules override the default length', () => {
  assert.match(appendAiRules('Base prompt.', 'Keep every suggestion to 1-2 short lines.'), /override any default tone, length or formatting/);
});

test('a real interview debrief opens with a call summary; practice runs do not', () => {
  const { buildDebriefRequest } = require('../src/prompts');
  const transcript = [at('them', 'We can start on 350 per day.', 0), at('you', 'I will review it and reply within the week.', 38 * MINUTE)];
  const real = buildDebriefRequest(interview, { kind: 'interview', transcript, answers: [] });
  assert.match(real.system, /## Summary[\s\S]*## Agreements and decisions[\s\S]*## Next steps[\s\S]*## Figures[\s\S]*## Open questions[\s\S]*## Questions asked/);
  assert.match(real.system, /never from \[cue suggested\] lines or the reference material/);
  assert.match(real.turns[0].text, /^Length of the conversation: about 38 minutes\./);
  const practice = buildDebriefRequest(interview, { kind: 'practice', transcript, answers: [] });
  assert.doesNotMatch(practice.system, /## Agreements and decisions|## Figures/);
});

test('"Any more questions?" is recognised as the closing questions moment', () => {
  assert.equal(detectCategory([at('them', 'Any more questions?')]), 'compensation');
  assert.equal(detectCategory([at('them', 'Do you have any other questions for me?')]), 'compensation');
});
