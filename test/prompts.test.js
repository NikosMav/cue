const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../src/prompts');

test('assist mode gives a direct answer in first person', () => {
  const system = MODES.assist.buildSystem(null);
  const text = system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  // System prompt must instruct to answer in first person with no preamble
  assert.match(text, /first person/i);
  assert.match(text, /no preamble|preamble/i);
});

test('say mode produces a spoken answer not a question', () => {
  const system = MODES.say.buildSystem(null);
  const text = system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /say out loud|in first person/i);
  // Must instruct to write actual spoken words (not meta-instructions)
  assert.match(text, /actual words|Write the|2.5 sentences/i);
});

test('leetcode mode ignores context block and returns coding prompt', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /competitive programmer|coding problem/i);
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'leetcode should not include context block');
});

test('followup mode returns a bullet list', () => {
  const system = MODES.followup.buildSystem(null);
  assert.match(system, /bullet list|bullets/i);
});

// MODES.recap is the interview layer; recaps of other conversations use the
// General layer (see general-layer.test.js).
test('recap is grounded in the transcript', () => {
  const system = MODES.recap.buildSystem(null);
  assert.match(system, /actually said|only what is in the transcript/i, 'recap must be grounded in the transcript');
  assert.match(system, /generic/i, 'recap must forbid generic filler');
  assert.equal(MODES.recap.transcriptRequired, true, 'recap needs a transcript to be meaningful');
  // Modes that also take a screenshot can run on an empty transcript.
  assert.ok(!MODES.assist.transcriptRequired);
  assert.ok(!MODES.ask.transcriptRequired);
  assert.ok(!MODES.leetcode.transcriptRequired);
});

test('recap user turn carries the real conversation', () => {
  const transcript = [
    { channel: 'them', text: 'We shipped the Terraform pipeline on Tuesday.', ts: 1 },
    { channel: 'you', text: 'How long did the deploy take?', ts: 2 }
  ];
  const turn = MODES.recap.build({ transcript, userText: '' });
  assert.match(turn, /Them: We shipped the Terraform pipeline on Tuesday\./);
  assert.match(turn, /You: How long did the deploy take\?/);
});

test('all modes have a build function', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});

// ── AI rules ────────────────────────────────────────────────────────────────
const RULES = 'Never use em-dashes.\nReply in 2-3 short bullet points.\nUse a casual tone.';

test('every non-leetcode mode injects AI rules into its system prompt', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (mode.coding) continue;
    const withRules = mode.buildSystem(null, RULES);
    assert.match(withRules, /--- USER RULES ---/, `${name}.buildSystem should append USER RULES block`);
    assert.ok(withRules.includes(RULES), `${name}.buildSystem should include the user's rules verbatim`);
  }
});

test('every non-leetcode mode returns the base prompt unchanged when no rules are set', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (mode.coding) continue;
    const without = mode.buildSystem(null, '');
    const blank = mode.buildSystem(null, null);
    assert.ok(!without.includes('USER RULES'), `${name} should not include USER RULES when aiRules is empty`);
    assert.ok(!blank.includes('USER RULES'), `${name} should not include USER RULES when aiRules is null`);
  }
});

test('leetcode mode never applies AI rules (coding answers stay strict)', () => {
  const withRules = MODES.leetcode.buildSystem(null, RULES);
  assert.ok(!withRules.includes('USER RULES'), 'leetcode must not include USER RULES');
  assert.ok(!withRules.includes(RULES), 'leetcode must not leak user rules into the prompt');
  assert.match(withRules, /competitive programmer/);
});
// ── Presentation layer ───────────────────────────────────────────────────────
const { buildPromptRequest } = require('../src/prompts');

test('presentation say prompt is pitched to the audience and carries slide context', () => {
  const settings = { setupKind: 'presentation', jobDescription: '2nd-year CS', deckOutline: '1. Intro\n2. Big-O — Count steps', answerLength: 'brief' };
  const slide = { n: 2, title: 'Big-O', body: 'Count steps', notes: 'phone book', points: ['Drop constants'] };
  const r = buildPromptRequest(settings, 'say', [{ channel: 'them', text: 'Why drop constants?', ts: 1 }], '', { slides: { current: slide, neighbours: [], relevant: [] } });
  assert.match(r.system, /=== Deck outline ===\n1\. Intro\n2\. Big-O — Count steps/);
  assert.match(r.system, /"Them" is the audience/);
  assert.match(r.system, /\(not in your material: verify before stating\)/);
  assert.match(r.turns[0].text, /Current slide \(2\):/);
  assert.ok(r.cachePrefix && r.system.startsWith(r.cachePrefix));
});

test('presentation prompts build without a deck and omit slide sections', () => {
  const r = buildPromptRequest({ setupKind: 'presentation' }, 'say', [{ channel: 'them', text: 'Is this recorded?', ts: 1 }]);
  assert.doesNotMatch(r.system, /Deck outline/);
  assert.doesNotMatch(r.turns[0].text, /Current slide/);
});

test('presentation followup asks check-understanding questions', () => {
  const r = buildPromptRequest({ setupKind: 'presentation' }, 'followup', []);
  assert.match(r.system, /check understanding|questions the presenter could ask the audience/i);
});

test('the presentation transcript window is 6,000 characters', () => {
  const long = Array.from({ length: 200 }, (_, i) => ({ channel: i % 2 ? 'you' : 'them', text: 'word '.repeat(40) + i, ts: i * 1000 }));
  for (const mode of ['say', 'assist']) {
    const text = buildPromptRequest({ setupKind: 'presentation' }, mode, long, '', { now: 200000 }).turns[0].text;
    const lines = text.split('\n').filter((l) => /^(Them|You): /.test(l));
    const window = lines.reduce((sum, l) => sum + l.length + 1, 0);
    assert.ok(window <= 6000, mode + ' transcript window ' + window);
    assert.ok(window > 5500, mode + ' window uses the budget: ' + window);
    assert.ok(text.includes('word '.repeat(40) + '199'), mode + ' keeps the latest turn');
  }
});

test('presentation slide context comes before the transcript, with neighbours and relevant slides', () => {
  const slides = {
    current: { n: 5, title: 'Hash maps', body: 'Buckets and keys', notes: 'Use the coat-check analogy', points: ['O(1) average'] },
    neighbours: [{ n: 4, title: 'Arrays', points: ['Contiguous'] }, { n: 6, title: 'Collisions', points: ['Chaining', 'Probing'] }],
    relevant: [{ n: 12, title: 'Trees', points: ['Ordered keys'] }]
  };
  const t = [{ channel: 'them', text: 'What happens when two keys collide?', ts: 1000 }];
  for (const mode of ['say', 'assist', 'answerThis', 'ask']) {
    const text = buildPromptRequest({ setupKind: 'presentation' }, mode, t, 'What happens when two keys collide?', { slides, now: 5000 }).turns[0].text;
    assert.match(text, /Current slide \(5\):[\s\S]*Hash maps[\s\S]*Buckets and keys[\s\S]*coat-check[\s\S]*O\(1\) average/, mode);
    assert.match(text, /Neighbouring slides:[\s\S]*4\. Arrays[\s\S]*6\. Collisions/, mode);
    assert.match(text, /Possibly relevant slides:[\s\S]*12\. Trees/, mode);
    assert.ok(text.indexOf('Current slide') < text.indexOf('What happens when two keys collide?'), mode + ' slides before the conversation');
  }
});

test('presentation layer keeps coding and practice modes on their interview definitions', () => {
  assert.match(buildPromptRequest({ setupKind: 'presentation' }, 'leetcode', []).system, /competitive programmer/);
  assert.equal(buildPromptRequest({ setupKind: 'presentation' }, 'say', [{ channel: 'them', text: 'What is Big-O?', ts: 1 }]).category, 'question');
});

test('presentation recap covers slides and open audience questions, never interview framing', () => {
  for (const mode of ['assist', 'say', 'followup', 'recap', 'ask', 'answerThis']) {
    const { system, turns } = buildPromptRequest({ setupKind: 'presentation', jobDescription: 'Intro to algorithms' }, mode, [{ channel: 'them', text: 'Can you repeat that?', ts: 1 }], 'Can you repeat that?');
    assert.doesNotMatch(system, /\bcandidate\b|\binterviewer\b|job interview/i, mode);
    assert.doesNotMatch(turns[0].text, /\bcandidate\b|\binterviewer\b|job interview/i, mode);
  }
  const r = buildPromptRequest({ setupKind: 'presentation' }, 'recap', [{ channel: 'you', text: 'Today: sorting.', ts: 1 }]);
  assert.match(r.system, /by slide/i);
  assert.match(r.system, /still open/i);
});
