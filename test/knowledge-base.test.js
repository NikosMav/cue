const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInterviewContext } = require('../src/interview-context');
const { MODES } = require('../src/prompts');

test('full KB survives category budgets, rolling history and every interview mode', () => {
  const knowledgeBase = 'START\n' + 'Long reference notes.\n'.repeat(1100) + '\nEND: notice period is unconfirmed.';
  for (const question of ['Tell me about a time you failed.', 'Why do you want this role?', 'What is TCP?', 'When can you start?', 'Tell me about yourself.', 'Imagine you joined us.', 'Hello']) {
    const transcript = [{ channel: 'them', text: question }];
    for (const [name, mode] of Object.entries(MODES)) {
      if (mode.coding) continue;
      const context = buildInterviewContext({ knowledgeBase }, name, transcript);
      const system = mode.buildSystem(context, 'Be concise.');
      assert.ok(system.includes(JSON.stringify(knowledgeBase)), `${name}: complete reference missing for ${question}`);
      assert.doesNotMatch(system, /construct a plausible story/i);
      assert.match(system, /Placeholders.*not established facts/);
    }
  }
});

test('KB alone works without a transcript; empty or removed KB is not injected', () => {
  assert.match(buildInterviewContext({ knowledgeBase: 'A reference' }, 'say', []), /A reference/);
  for (const knowledgeBase of ['', '   ', null, undefined]) {
    assert.equal(buildInterviewContext({ knowledgeBase }, 'say', []), null);
  }
});

test('coding-only mode excludes KB even when supplied directly', () => {
  assert.equal(buildInterviewContext({ knowledgeBase: 'PRIVATE_REFERENCE' }, 'leetcode', []), null);
  assert.ok(!MODES.leetcode.buildSystem('PRIVATE_REFERENCE').includes('PRIVATE_REFERENCE'));
});
