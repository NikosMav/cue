const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { CURRENT_GEMINI_DEFAULT } = require('../src/llm');

// Google retired gemini-2.0-flash on 2026-03-03 (deprecated Feb 2026); every
// request against it 404s with a generic "exception parsing response" body —
// this is the root cause behind the cluster of "Error: got status: 404"
// bug reports. Before the fix, four different files each hardcoded their own
// Gemini model id (two still pointing at the dead one), so this scans every
// source file that talks to the Gemini API and fails if a known-retired id
// or a hardcoded id that has drifted from the shared default sneaks back in.
const DEAD_MODEL_IDS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];

const FILES_THAT_CALL_GEMINI = [
  'src/llm.js',
  'src/store.js',
  'src/stt.js',
  'src/stt-streaming.js'
];

test('CURRENT_GEMINI_DEFAULT is not a known-retired Gemini model id', () => {
  assert.ok(!DEAD_MODEL_IDS.includes(CURRENT_GEMINI_DEFAULT), `${CURRENT_GEMINI_DEFAULT} is on the known-dead list`);
});

for (const relPath of FILES_THAT_CALL_GEMINI) {
  test(`${relPath} does not hardcode a retired Gemini model id`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    for (const deadId of DEAD_MODEL_IDS) {
      assert.ok(!source.includes(`'${deadId}'`) && !source.includes(`"${deadId}"`),
        `${relPath} still references retired model ${deadId}`);
    }
  });
}

test('store.js default Gemini models match the shared current default', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/store.js'), 'utf8');
  const match = /gemini:\s*\{\s*fast:\s*'([^']+)',\s*smart:\s*'([^']+)'/.exec(source);
  assert.ok(match, 'could not find the gemini default models block in store.js');
  assert.equal(match[1], CURRENT_GEMINI_DEFAULT);
  assert.equal(match[2], CURRENT_GEMINI_DEFAULT);
});

test('Gemini 2.5 thinking is budgeted so it cannot swallow a short answer', () => {
  const { geminiOutputConfig, resolveEffort } = require('../src/llm');
  assert.deepEqual(geminiOutputConfig('gemini-2.5-flash', 700, 'low'), { maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } });
  assert.deepEqual(geminiOutputConfig('gemini-2.5-flash', 700, 'medium'), { maxOutputTokens: 1724, thinkingConfig: { thinkingBudget: 1024 } });
  assert.equal(geminiOutputConfig('gemini-2.5-pro', 700, 'low').thinkingConfig.thinkingBudget, 128, 'Pro cannot turn thinking off');
  assert.equal(geminiOutputConfig('gemini-2.5-flash-lite', 700, 'low').thinkingConfig.thinkingBudget, 0);
  const newer = geminiOutputConfig('gemini-3-flash', 700, 'low');
  assert.equal(newer.thinkingConfig, undefined, 'unknown models keep their own thinking settings');
  assert.ok(newer.maxOutputTokens > 700);
  assert.deepEqual(geminiOutputConfig('gemma-3', 700, 'low'), { maxOutputTokens: 700 });
  assert.equal(resolveEffort('low', false), 'low');
  assert.equal(resolveEffort('low', true), 'medium');
  assert.equal(resolveEffort('medium', true), 'high');
  assert.equal(resolveEffort('high', true), 'high');
  assert.equal(resolveEffort(undefined, false), 'medium');
});
