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

// ── Presentation debrief ─────────────────────────────────────────────────────
const { buildDebriefRequest, splitDebrief } = require('../src/prompts');

const PRES_T0 = 1760000000000;
const presSession = {
  kind: 'interview',
  setupKind: 'presentation',
  startedAt: PRES_T0,
  endedAt: PRES_T0 + 600000,
  transcript: [
    { channel: 'you', text: 'Today we look at Big-O.', ts: PRES_T0 + 1000 },
    { channel: 'them', text: 'Why do we drop constants?', ts: PRES_T0 + 200000 },
    { channel: 'you', text: 'Because they stop mattering at scale.', ts: PRES_T0 + 205000 }
  ],
  answers: [{ mode: 'say', prompt: 'Why do we drop constants?', text: 'They vanish as n grows.', ts: PRES_T0 + 201000 }],
  presentation: {
    deckFileName: 'l4.pptx', slideCount: 3, durationMin: 20,
    titles: { 1: 'Intro', 2: 'Big-O intuition', 3: 'Wrap-up' },
    timeline: [
      { n: 1, enterTs: PRES_T0, leaveTs: PRES_T0 + 65000 },
      { n: 2, enterTs: PRES_T0 + 65000, leaveTs: PRES_T0 + 400000 },
      { n: 1, enterTs: PRES_T0 + 400000, leaveTs: PRES_T0 + 410000 },
      { n: 3, enterTs: PRES_T0 + 410000, leaveTs: null }
    ],
    coverage: { 2: { status: 'partial', missing: 'worst case vs average' }, 1: { status: 'covered', missing: '' } },
    skipped: [4]
  }
};

test('presentation debrief lists the five sections in order and asks for the JSON block', () => {
  const r = buildDebriefRequest({ setupKind: 'presentation' }, presSession);
  const heads = ['## Timing', '## Coverage', '## Audience questions', '## Confusion hotspots', '## Deck changes for next time'];
  let at = -1;
  for (const h of heads) {
    const i = r.system.indexOf(h);
    assert.ok(i > at, h + ' in order');
    at = i;
  }
  assert.match(r.system, /```json/);
  assert.match(r.system, /\[\{"n": /);
  assert.match(r.system, /three to six concrete edits/i);
  assert.match(r.system, /no generic presentation advice/i);
  assert.match(r.system, /never invent questions, times(,| or) reactions/i);
  assert.match(r.system, /"Them" is the audience/);
  assert.equal(r.effort, 'medium');
});

test('presentation debrief user turn carries timeline, coverage, skipped, length and transcript', () => {
  const r = buildDebriefRequest({ setupKind: 'presentation' }, presSession);
  const text = r.turns[0].text;
  assert.match(text, /Planned length: 20 minutes; 3 slides\./);
  assert.match(text, /^1 Intro: 1:05$/m);
  assert.match(text, /^2 Big-O intuition: 5:35$/m);
  assert.match(text, /^1 Intro: 0:10$/m);
  assert.match(text, /^3 Wrap-up: 3:10$/m, 'an open visit runs to the end of the session');
  assert.match(text, /2 Big-O intuition: partial — missing: worst case vs average/);
  assert.doesNotMatch(text, /1 Intro: covered/, 'covered slides are not listed');
  assert.match(text, /Skipped slides: 4\b/);
  assert.match(text, /Length of the conversation: about 3 minutes\./);
  assert.match(text, /Them: Why do we drop constants\?/);
  assert.match(text, /— Slide 2 · Big-O intuition —\n(.*\n)*Them: Why do we drop constants\?/, 'questions sit under the slide they were asked on');
  assert.ok(text.indexOf('— Slide 2') < text.indexOf('Them: Why'));
});

test('presentation debrief carries the deck outline and works without a record', () => {
  const r = buildDebriefRequest({ setupKind: 'presentation', deckOutline: '1. Intro\n2. Big-O intuition' }, presSession);
  assert.match(r.system, /=== Deck outline ===\n1\. Intro\n2\. Big-O intuition/);
  assert.ok(r.cachePrefix && r.system.startsWith(r.cachePrefix));
  const bare = buildDebriefRequest({ setupKind: 'presentation' }, { setupKind: 'presentation', transcript: [], answers: [] });
  assert.match(bare.turns[0].text, /Slide timeline: none recorded/);
  assert.match(bare.turns[0].text, /\(empty\)/);
});

test('presentation debrief notes a missing presenter microphone', () => {
  const s = { ...presSession, transcript: presSession.transcript.filter((t) => t.channel === 'them') };
  assert.match(buildDebriefRequest({ setupKind: 'presentation' }, s).system, /presenter's microphone was not captured/);
  assert.doesNotMatch(buildDebriefRequest({ setupKind: 'presentation' }, presSession).system, /microphone was not captured/);
});

test('splitDebrief returns prose without the block and the parsed questions', () => {
  const text = '## Timing\nRan long.\n\n## Audience questions\n1. Why drop constants?\n\n```json\n[{"n": 2, "question": "Why do we drop constants?"}, {"n": 0, "question": "bad"}, {"n": 3, "question": "  "}, {"n": 3, "question": "' + 'x'.repeat(200) + '"}]\n```\n';
  const { prose, questions } = splitDebrief(text);
  assert.equal(prose, '## Timing\nRan long.\n\n## Audience questions\n1. Why drop constants?');
  assert.deepEqual(questions[0], { n: 2, question: 'Why do we drop constants?' });
  assert.equal(questions.length, 2, 'invalid slide numbers and blank questions are dropped');
  assert.equal(questions[1].question.length, 160);
});

test('splitDebrief without a block returns the prose and no questions', () => {
  assert.deepEqual(splitDebrief('## Timing\nOn time.\n'), { prose: '## Timing\nOn time.', questions: [] });
  assert.deepEqual(splitDebrief('Prose\n```json\nnot json\n```'), { prose: 'Prose', questions: [] });
  assert.deepEqual(splitDebrief(''), { prose: '', questions: [] });
  assert.deepEqual(splitDebrief(undefined), { prose: '', questions: [] });
});

// Speech-to-text cannot tell a mishearing from a slip, so feedback never blames
// the candidate for a name and states a differing fact neutrally.
test('practice feedback and interview debriefs treat transcript names and facts neutrally', () => {
  const feedback = MODES.practiceFeedback.buildSystem('', '');
  const debrief = buildDebriefRequest({ setupKind: 'interview' }, { kind: 'interview', transcript: [{ channel: 'them', text: 'Hi', ts: 1 }], answers: [] }).system;
  const practice = buildDebriefRequest({ setupKind: 'interview' }, { kind: 'practice', transcript: [{ channel: 'them', text: 'Hi', ts: 1 }], answers: [] }).system;
  for (const system of [feedback, debrief, practice]) {
    assert.match(system, /sounds like a name or term in the reference.*use the reference spelling and do not mention it/);
    assert.match(system, /The transcript has .*; your notes say .* worth checking which you said/);
  }
  const general = buildDebriefRequest({ setupKind: 'general' }, { transcript: [], answers: [] }).system;
  assert.doesNotMatch(general, /worth checking which you said/, 'general debriefs are unchanged');
});

test('interview answers do not end with a question back to the interviewer', () => {
  const r = buildPromptRequest({ setupKind: 'interview' }, 'say', [{ channel: 'them', text: 'Tell me about yourself.', ts: 1 }]);
  assert.match(r.system, /Do not end with a question to the interviewer unless they asked whether you have questions/);
  const g = buildPromptRequest({ setupKind: 'general' }, 'say', [{ channel: 'them', text: 'Tell me about yourself.', ts: 1 }]);
  assert.doesNotMatch(g.system, /question to the interviewer/);
});
