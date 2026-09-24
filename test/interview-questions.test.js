const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildInterviewContext, detectCategory, currentQuestion, QUESTION_MERGE_GAP_MS
} = require('../src/interview-context');
const { buildPromptRequest } = require('../src/prompts');

const at = (channel, text, ts) => ({ channel, text, ts });

// ── Full reference context ───────────────────────────────────────────────────
const jobs = Array.from({ length: 6 }, (_, i) =>
  `Company ${i} — Senior Engineer\n- Built service ${i} in Go and Postgres.\n- Mentored engineers.`).join('\n');
const resume = `Jane Doe\n\nSummary\nBackend engineer.\n\nExperience\n${jobs}\n\nSkills\nGo, Kafka\n\nEducation\nBSc Computer Science, 2016\n`;
const profile = {
  resumeText: resume,
  jobDescription: 'Backend role on the payments team.',
  starStories: 'Outage story: fixed Redis exhaustion.',
  whyCompany: 'Payments at scale.',
  whyLeaving: 'Wants larger systems.',
  workStyle: 'Direct feedback.',
  salaryTarget: 'Defer until the offer stage.',
  questionsToAsk: 'What does success look like in 90 days?'
};

test('the whole résumé reaches the model for every question type', () => {
  for (const question of ['How would you design a rate limiter?', 'Why this company?', 'Anything else?']) {
    const ctx = buildInterviewContext(profile, 'say', [at('them', question)]);
    for (let i = 0; i < 6; i++) assert.ok(ctx.includes(`Built service ${i}`), `job ${i} missing for ${question}`);
    assert.match(ctx, /BSc Computer Science/);
  }
});

test('every prep field is included regardless of the detected category', () => {
  const ctx = buildInterviewContext(profile, 'assist', [at('them', 'What is TCP?')]);
  for (const value of Object.values(profile).slice(1)) assert.ok(ctx.includes(value), value);
});

test('the reference block does not depend on the question, so it can be cached', () => {
  const a = buildPromptRequest(profile, 'say', [at('them', 'Why this company?')]);
  const b = buildPromptRequest(profile, 'assist', [at('them', 'What is TCP?')]);
  assert.ok(a.cachePrefix.length > 0);
  assert.equal(a.cachePrefix, b.cachePrefix);
  assert.ok(a.system.startsWith(a.cachePrefix));
  assert.equal(buildPromptRequest(profile, 'leetcode', []).cachePrefix, '');
  assert.equal(buildPromptRequest({}, 'say', []).cachePrefix, '');
});

test('oversized fields are bounded and visibly marked', () => {
  const ctx = buildInterviewContext({ starStories: 'x'.repeat(20000) }, 'say', []);
  assert.match(ctx, /\[…truncated\]/);
  assert.ok(ctx.length < 9000);
});

// ── Question fragments ───────────────────────────────────────────────────────
test('fragments of one question are joined and classified together', () => {
  const t = [
    at('you', 'That makes sense, and that is how we shipped it last year.', 1000),
    at('them', 'So, uh, tell me about a time when', 5000),
    at('them', 'you had to deal with a difficult stakeholder.', 8000)
  ];
  assert.equal(currentQuestion(t), 'So, uh, tell me about a time when you had to deal with a difficult stakeholder.');
  assert.equal(detectCategory(t), 'behavioral');
});

test('a short acknowledgement from the candidate does not split the question', () => {
  const t = [
    at('them', 'We run everything on Kafka here.', 1000),
    at('you', 'Mm-hm.', 2000),
    at('them', 'How would you design the consumer side?', 4000)
  ];
  assert.equal(currentQuestion(t), 'We run everything on Kafka here. How would you design the consumer side?');
});

test('a real answer from the candidate ends the previous question', () => {
  const t = [
    at('them', 'Why do you want to work here?', 1000),
    at('you', 'Because the payments work matches what I have been doing for years.', 5000),
    at('them', 'What is your greatest weakness?', 9000)
  ];
  assert.equal(currentQuestion(t), 'What is your greatest weakness?');
});

test('turns far apart in time, or without timestamps, stay separate', () => {
  assert.equal(currentQuestion([
    at('them', 'First topic.', 0),
    at('them', 'Next question?', QUESTION_MERGE_GAP_MS + 1)
  ]), 'Next question?');
  assert.equal(currentQuestion([{ channel: 'them', text: 'A.' }, { channel: 'them', text: 'B?' }]), 'B?');
});

test('the newest segment decides the category when it is specific', () => {
  const t = [
    at('them', 'Tell me about a time you led a project.', 1000),
    at('them', 'Actually, first: what are your salary expectations?', 3000)
  ];
  assert.equal(detectCategory(t), 'compensation');
});

test('common questions are labelled sensibly', () => {
  const cases = [
    ['What is your greatest weakness?', 'behavioral'],
    ['What is your biggest strength?', 'behavioral'],
    ['Have you ever used Kubernetes in production?', 'experience'],
    ['Have you ever had a conflict with a teammate?', 'behavioral'],
    ['How do you prioritize when everything is urgent?', 'situational'],
    ['Can you walk me through how a hash map works?', 'technical']
  ];
  for (const [question, expected] of cases) assert.equal(detectCategory([at('them', question)]), expected, question);
});

test('say and assist restate a question joined from several segments', () => {
  const t = [at('them', 'Tell me about a time when', 1000), at('them', 'you missed a deadline.', 3000)];
  for (const mode of ['say', 'assist']) {
    const { turns } = buildPromptRequest({}, mode, t);
    assert.match(turns[0].text, /current question.*"Tell me about a time when you missed a deadline\."/);
  }
  const single = buildPromptRequest({}, 'say', [at('them', 'Why us?', 1000)]);
  assert.doesNotMatch(single.turns[0].text, /current question/);
});

test('the coding solver gets room for a complete solution', () => {
  assert.ok(buildPromptRequest({}, 'leetcode', []).maxTokens >= 4000);
  assert.equal(buildPromptRequest({}, 'say', []).maxTokens, undefined);
});

// ── Follow-ups and session memory ────────────────────────────────────────────
test('"Answer this" sees recent conversation so follow-up questions resolve', () => {
  const t = [
    at('them', 'Tell me about the payments migration.', 1000),
    at('you', 'We moved reconciliation from a nightly batch to Kafka consumers.', 5000)
  ];
  const { turns } = buildPromptRequest({}, 'answerThis', t, 'Why did you choose that approach?');
  assert.match(turns[0].text, /nightly batch to Kafka/);
  assert.match(turns[0].text, /"Why did you choose that approach\?"/);
});

test('earlier spoken answers are offered for consistency; coding answers are not', () => {
  const answers = [
    { mode: 'leetcode', prompt: '', text: 'def two_sum(): pass' },
    { mode: 'answerThis', prompt: 'Tell me about yourself.', text: 'I build payment systems in Go.' }
  ];
  const { turns } = buildPromptRequest({}, 'say', [at('them', 'Tell me more about that.', 1000)], '', { answers });
  assert.match(turns[0].text, /I build payment systems in Go/);
  assert.doesNotMatch(turns[0].text, /two_sum/);
  assert.doesNotMatch(buildPromptRequest({}, 'say', []).turns[0].text, /suggested earlier/);
});

test('a typed question right after a coding answer continues the coding thread', () => {
  const answers = [
    { mode: 'answerThis', prompt: 'Why us?', text: 'Spoken answer.' },
    { mode: 'leetcode', prompt: '', text: 'Solution A (O(n^2))' },
    { mode: 'codeFollowup', prompt: 'Make it O(n).', text: 'Solution B (O(n))' }
  ];
  const request = buildPromptRequest({ knowledgeBase: 'PRIVATE', aiRules: 'Use emoji.' }, 'ask', [], 'What if the array is sorted?', { answers });
  assert.equal(request.mode, 'codeFollowup');
  assert.equal(request.needsScreen, true);
  assert.ok(request.maxTokens >= 4000);
  assert.equal(request.category, null);
  assert.deepEqual(request.turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(request.turns[1].text, /Solution A/);
  assert.equal(request.turns[2].text, 'Make it O(n).');
  assert.match(request.turns[3].text, /Solution B/);
  assert.equal(request.turns[4].text, 'What if the array is sorted?');
  assert.doesNotMatch(request.system + JSON.stringify(request.turns), /Spoken answer|PRIVATE|Use emoji/);
});

test('without a preceding coding answer, a typed question stays a normal question', () => {
  const answers = [{ mode: 'leetcode', text: 'code' }, { mode: 'ask', prompt: 'x', text: 'y' }];
  assert.equal(buildPromptRequest({}, 'ask', [], 'What is TCP?', { answers }).mode, 'ask');
  assert.equal(buildPromptRequest({}, 'ask', [], 'What is TCP?').mode, 'ask');
  assert.equal(buildPromptRequest({}, 'say', [], '', { answers: [{ mode: 'leetcode', text: 'c' }] }).mode, 'say');
});

test('the coding solver knows several screenshots are parts of one problem', () => {
  assert.match(buildPromptRequest({}, 'leetcode', []).system, /several screenshots.*same problem/);
});
