// Writes test/fixtures/prompts-before-presentation.json: the full prompt
// requests (system, user turns, category, cache prefix) of every interview and
// general mode, plus the interview and general debriefs (including the
// microphone-not-captured and empty branches), for fixed inputs. Captured before the
// presentation layer was added; test/prompts-guard.test.js proves the
// interview and general layers stay byte-identical.
// Run: node scripts/dev/capture-prompts.js
const fs = require('node:fs');
const path = require('node:path');
const { buildPromptRequest, buildDebriefRequest, MODES } = require('../../src/prompts');

const NOW = 1760000000000;
const T0 = NOW - 7 * 60000;

const interview = {
  setupKind: 'interview',
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

const general = {
  setupKind: 'general',
  resumeText: 'Synthetic CV: platform lead.',
  starStories: 'Led the API migration.',
  workStyle: 'Direct, written first.',
  jobDescription: 'Weekly platform sync; I lead the API work.',
  knowledgeBase: 'Release is Friday.',
  whyCompany: '',
  whyLeaving: '',
  salaryTarget: '',
  questionsToAsk: '',
  aiRules: 'Keep it short.',
  answerLength: 'detailed'
};

// Two "them" segments within the merge window so say/assist restate the
// joined question; a "you" turn; a final question.
const transcript = [
  { channel: 'them', text: 'Thanks for joining.', ts: T0 },
  { channel: 'you', text: 'Happy to be here, thanks for having me.', ts: T0 + 5000 },
  { channel: 'them', text: 'Quick one before we move on,', ts: T0 + 60000 },
  { channel: 'them', text: 'tell me about a time you fixed a hard bug?', ts: T0 + 63000 }
];

const answers = [
  { mode: 'say', prompt: 'Thanks for joining.', text: 'Thanks, glad to be here.', ts: T0 + 6000 },
  { mode: 'leetcode', prompt: '', text: 'def solve(): pass', ts: T0 + 30000 }
];

const theirTurns = transcript.filter(t => t.channel === 'them');

const codingAnswers = [{ mode: 'leetcode', prompt: '', text: 'def solve(): return 1', ts: T0 + 30000 }];

const modes = Object.keys(MODES);

function capture(settings) {
  const out = {};
  for (const mode of modes) {
    out[mode] = buildPromptRequest(settings, mode, transcript, 'Why did you pick Postgres?', { now: NOW, answers });
    out[mode + ':empty'] = buildPromptRequest(settings, mode, [], '', { now: NOW });
  }
  out['ask:afterCoding'] = buildPromptRequest(settings, 'ask', transcript, 'Can you make it faster?', { now: NOW, answers: codingAnswers });
  out.debrief = buildDebriefRequest(settings, { kind: 'interview', transcript, answers });
  out['debrief:practice'] = buildDebriefRequest(settings, { kind: 'practice', transcript, answers });
  // The microphone-not-captured branch, and an empty session.
  out['debrief:noUser'] = buildDebriefRequest(settings, { kind: 'interview', transcript: theirTurns, answers });
  out['debrief:empty'] = buildDebriefRequest(settings, { kind: 'interview', transcript: [], answers: [] });
  return out;
}

const fixture = {
  inputs: { now: NOW, interview, general, transcript, answers, codingAnswers, userText: 'Why did you pick Postgres?', askAfterCoding: 'Can you make it faster?' },
  interview: capture(interview),
  general: capture(general)
};

const file = path.join(__dirname, '../../test/fixtures/prompts-before-presentation.json');
fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', Object.keys(fixture.interview).length + Object.keys(fixture.general).length, 'requests to', path.relative(process.cwd(), file));
