// Byte-identical guard for the interview and general prompt layers. The
// fixture was written by scripts/dev/capture-prompts.js before the
// presentation layer existed; every request rebuilt here from the stored
// inputs must match it exactly (system, user turns, category, cache prefix).
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPromptRequest, buildDebriefRequest, MODES } = require('../src/prompts');
const fixture = require('./fixtures/prompts-before-presentation.json');

const { now, transcript, answers, codingAnswers, userText, askAfterCoding } = fixture.inputs;

function rebuild(settings) {
  const out = {};
  for (const mode of Object.keys(MODES)) {
    out[mode] = buildPromptRequest(settings, mode, transcript, userText, { now, answers });
    out[mode + ':empty'] = buildPromptRequest(settings, mode, [], '', { now });
  }
  out['ask:afterCoding'] = buildPromptRequest(settings, 'ask', transcript, askAfterCoding, { now, answers: codingAnswers });
  out.debrief = buildDebriefRequest(settings, { kind: 'interview', transcript, answers });
  out['debrief:practice'] = buildDebriefRequest(settings, { kind: 'practice', transcript, answers });
  return JSON.parse(JSON.stringify(out));
}

for (const layer of ['interview', 'general']) {
  test(layer + ' prompts are byte-identical to the pre-presentation capture', () => {
    const actual = rebuild(fixture.inputs[layer]);
    assert.deepEqual(Object.keys(actual), Object.keys(fixture[layer]));
    for (const key of Object.keys(fixture[layer])) {
      assert.deepEqual(actual[key], fixture[layer][key], layer + ' ' + key);
    }
  });
}
