// LLM answer latency through cue's own request path (createLLM + the spoken
// "assist" prompt) against the real APIs. Per model:
//   first token  request sent -> first streamed text
//   total        request sent -> answer complete
// Usage: node scripts/dev/bench-llm.cjs [--reps 3] [--out results.json]
// Models with no saved key are skipped. Keys come from cue's settings file and
// are never printed. The profile is synthetic (sized like a real one so prompt
// caching is exercised), and nothing of yours is sent. A default run makes about
// 95 requests; each model gets one warm-up request that is not counted.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataDirectory } = require('../../src/config-path');
const { createLLM } = require('../../src/llm');
const { buildPromptRequest } = require('../../src/prompts');

const numberArg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const stringArg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };
const REPS = numberArg('--reps', 3);
const OUT = stringArg('--out');

// Same data directory as scripts/cue-config.js.
const fallback = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'cue')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'cue')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cue');
const directory = resolveDataDirectory({ appDirectory: path.join(__dirname, '..', '..'), defaultDirectory: fallback });
const saved = JSON.parse(fs.readFileSync(path.join(directory, 'cue-data.json'), 'utf8').replace(/^﻿/, ''));
const apiKeys = saved.apiKeys || {};

const roles = ['payments platform', 'ledger service', 'fraud scoring', 'billing engine', 'reconciliation pipeline', 'partner API', 'data warehouse', 'on-call tooling'];
const profile = {
  resumeText: roles.map((r, i) => `Senior backend engineer, team ${i + 1} (${2016 + i}-${2017 + i}): owned the ${r}, written in Go and Postgres with Kafka between services. Cut p99 latency from ${900 - i * 40} ms to ${300 - i * 10} ms by batching writes, adding idempotency keys and moving hot reads to a read replica. Mentored ${2 + i} engineers, ran the incident reviews, and wrote the runbook the whole rotation used. Migrated ${5 + i} services to a shared deployment pipeline and deleted ${1000 + i * 100} lines of dead code.`).join('\n'),
  starStories: roles.map((r, i) => `Story ${i + 1}: the ${r} lost data during a failover. Situation: a leader election raced a write. Task: find and fix it before the next release. Action: reproduced it with a fault-injection test, added a fencing token, replayed the log. Result: zero lost writes in ${6 + i} months, and the test became part of CI.`).join('\n'),
  workStyle: 'Calm, data first, writes things down.',
  jobDescription: 'Backend role on the payments team: Go, Postgres, Kafka, on-call, mentoring, design reviews. '.repeat(6),
  knowledgeBase: 'Team is about twelve engineers. Stack: Go, Postgres, Kafka, Kubernetes. '.repeat(8),
  whyCompany: 'Payments at scale and a strong engineering culture.',
  whyLeaving: 'Want deeper backend ownership.',
  salaryTarget: 'Prefer to discuss later.',
  questionsToAsk: 'What does success look like in six months?',
  aiRules: 'Never use em dashes.',
  answerLength: 'brief'
};
const QUESTIONS = [
  'Tell me about a time you fixed a hard production bug.',
  'Why do you want to work on our payments team?',
  'How would you design an idempotent payment API?',
  'Describe a conflict with a teammate and how you resolved it.',
  'What is the difference between a mutex and a semaphore?',
  'Where do you see yourself in five years?'
];

// smart:false is the Fast tier (low effort for spoken answers); smart:true is
// the Smart tier (one effort level higher).
const CONFIGS = [
  { name: 'openai gpt-4.1-mini (Fast)', provider: 'openai', smart: false, model: 'gpt-4.1-mini' },
  { name: 'openai gpt-4.1 (Smart)', provider: 'openai', smart: true, model: 'gpt-4.1' },
  { name: 'anthropic haiku-4-5 (Fast)', provider: 'anthropic', smart: false, model: 'claude-haiku-4-5' },
  { name: 'anthropic sonnet-5-5 (low effort)', provider: 'anthropic', smart: false, model: 'claude-sonnet-5-5' },
  { name: 'anthropic sonnet-5-5 (Smart)', provider: 'anthropic', smart: true, model: 'claude-sonnet-5-5' }
].filter((c) => {
  if (apiKeys[c.provider]) return true;
  console.error(`skipping ${c.name}: no ${c.provider} key saved in Cue`);
  return false;
});
if (!CONFIGS.length) { console.error('No provider keys saved in Cue.'); process.exit(2); }
for (const c of CONFIGS) {
  c.llm = createLLM({ provider: c.provider, smart: c.smart, apiKeys, models: { [c.provider]: { fast: c.model, smart: c.model } } });
  c.ttft = []; c.total = []; c.words = []; c.errors = 0; c.samples = {};
}

async function once(c, question, keep) {
  const req = buildPromptRequest(profile, 'assist', [{ channel: 'them', text: question, ts: 1000 }], '');
  const start = performance.now();
  let first = null;
  try {
    const text = await c.llm.stream({
      system: req.system, cachePrefix: req.cachePrefix, turns: req.turns, effort: req.effort,
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
      onToken: () => { if (first === null) first = performance.now() - start; }
    });
    if (!keep) return;
    c.ttft.push(first); c.total.push(performance.now() - start); c.words.push(text.trim().split(/\s+/).length);
    if (!c.samples[question]) c.samples[question] = text.trim();
  } catch (error) {
    c.errors++;
    console.error(`  ${c.name}: ${String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, '[key]').slice(0, 160)}`);
  }
}

const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : 'n/a');

(async () => {
  for (const c of CONFIGS) await once(c, QUESTIONS[0], false);
  for (let rep = 0; rep < REPS; rep++) {
    for (const question of QUESTIONS) for (const c of CONFIGS) await once(c, question, true);
    console.error(`round ${rep + 1}/${REPS} done`);
  }
  console.log('model                                    first token (p50 / p90)   total p50   words p50   n   errors');
  for (const c of CONFIGS) {
    console.log(`${c.name.padEnd(40)} ${ms(percentile(c.ttft, 0.5)).padStart(8)} / ${ms(percentile(c.ttft, 0.9)).padStart(8)}   ${ms(percentile(c.total, 0.5)).padStart(9)}   ${String(percentile(c.words, 0.5)).padStart(9)}   ${c.ttft.length}   ${c.errors}`);
  }
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(CONFIGS.map((c) => ({ name: c.name, model: c.model, ttft: c.ttft, total: c.total, words: c.words, samples: c.samples })), null, 2));
    console.error(`wrote ${OUT}`);
  }
})();
