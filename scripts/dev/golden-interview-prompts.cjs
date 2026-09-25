// Writes test/fixtures/interview-prompts.json: today's system prompts for an
// interview profile, used to prove interview setups stay byte-identical.
const fs = require('node:fs');
const path = require('node:path');
const { buildPromptRequest, buildDebriefRequest } = require('../../src/prompts');

const profile = {
  resumeText: 'Synthetic CV: backend engineer, five years, Go and Postgres.',
  starStories: 'Story A: fixed duplicate imports with an idempotency key.',
  workStyle: 'Calm, data first.',
  jobDescription: 'Backend role on the payments team.',
  knowledgeBase: 'Notes: team size unconfirmed.',
  whyCompany: 'Payments at scale.',
  whyLeaving: 'Want deeper backend work.',
  salaryTarget: 'Prefer to discuss later.',
  questionsToAsk: 'What does success look like in six months?',
  aiRules: 'Never use em dashes.',
  answerLength: 'balanced'
};
const t = [{ channel: 'them', text: 'Tell me about a time you fixed a hard bug.', ts: 1000 }, { channel: 'you', text: 'Sure.', ts: 3000 }];
const modes = ['assist', 'say', 'followup', 'recap', 'ask', 'answerThis', 'practiceQuestion', 'practiceFeedback'];
const out = {};
for (const mode of modes) out[mode] = buildPromptRequest(profile, mode, t, 'Why this company?').system;
out.debrief = buildDebriefRequest(profile, { kind: 'interview', transcript: t, answers: [] }).system;
fs.mkdirSync(path.join(__dirname, '../../test/fixtures'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '../../test/fixtures/interview-prompts.json'), JSON.stringify({ profile, transcript: t, prompts: out }, null, 2));
console.log('wrote', Object.keys(out).length, 'prompts');
