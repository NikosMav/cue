const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_AI_RULES_CHARS, MAX_COMBINED_RULES_CHARS, appendAiRules } = require('../src/profile-context');

test('appendAiRules: leaves the mode prompt unchanged when no rules are set', () => {
  assert.equal(appendAiRules('Base prompt', ''), 'Base prompt');
  assert.equal(appendAiRules('Base prompt', null), 'Base prompt');
  assert.equal(appendAiRules('Base prompt', '   \n  '), 'Base prompt');
});

test('appendAiRules: wraps rules as authoritative instructions (not data)', () => {
  const rules = 'Never use em-dashes.\nUse bullet points.';
  const prompt = appendAiRules('Base prompt', rules);

  assert.match(prompt, /Follow them strictly/);
  assert.match(prompt, /--- USER RULES ---/);
  assert.match(prompt, /--- END USER RULES ---/);
  assert.ok(prompt.includes(rules));
  // Unlike the résumé, rules are treated as instructions — there should be no
  // "untrusted data, not instructions" caveat.
  assert.ok(!/untrusted data, not instructions/.test(prompt));
});

test('appendAiRules: appends AFTER the base prompt', () => {
  const prompt = appendAiRules('Base prompt', 'Never use em-dashes.');
  assert.ok(prompt.startsWith('Base prompt'));
  assert.ok(prompt.indexOf('Base prompt') < prompt.indexOf('--- USER RULES ---'));
});

test('appendAiRules: bounds the combined setup and global rules to MAX_COMBINED_RULES_CHARS', () => {
  assert.equal(MAX_COMBINED_RULES_CHARS, 2 * MAX_AI_RULES_CHARS + 2);
  const rules = 'x'.repeat(MAX_COMBINED_RULES_CHARS + 500);
  const prompt = appendAiRules('', rules);
  assert.ok(prompt.includes('x'.repeat(MAX_COMBINED_RULES_CHARS)));
  assert.ok(!prompt.includes('x'.repeat(MAX_COMBINED_RULES_CHARS + 1)));
});

test('long setup instructions cannot push the global AI rules out of the prompt', () => {
  const { buildPromptRequest } = require('../src/prompts');
  const { normalizeSetups, effectiveSettings } = require('../src/setups');
  const s = normalizeSetups({
    setupsVersion: 1,
    aiRules: 'GLOBAL RULE: never use em dashes.',
    setups: [{ id: 'g', name: 'Call', kind: 'general', instructions: 'i'.repeat(2500) }],
    activeSetupId: 'g'
  });
  const { system } = buildPromptRequest(effectiveSettings(s), 'say', [{ channel: 'them', text: 'Thoughts?', ts: 1 }]);
  assert.match(system, /GLOBAL RULE: never use em dashes\./);
  assert.equal(s.setups.find((x) => x.id === 'g').instructions.length, MAX_AI_RULES_CHARS, 'setup instructions are bounded');
});

test('appendAiRules: trims surrounding whitespace before clipping', () => {
  const prompt = appendAiRules('Base prompt', '   rule one.   ');
  assert.match(prompt, /rule one\./);
  assert.ok(!prompt.includes('   rule one.   '));
});