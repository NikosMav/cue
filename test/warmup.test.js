const assert = require('node:assert/strict');
const test = require('node:test');

const { createWarmUp, WARMUP_MIN_INTERVAL_MS, WARMUP_MAX_TOKENS } = require('../src/warmup');
const { buildPromptRequest } = require('../src/prompts');

const profile = { provider: 'openai', resumeText: 'Synthetic CV', knowledgeBase: 'Synthetic notes', answerLength: 'brief' };

function harness({ settings = profile, ready = true, fail = false, busy = false } = {}) {
  const calls = [];
  let clock = 1_000_000;
  const warmUp = createWarmUp({
    getSettings: () => settings,
    createLLM: () => ({ ready, stream: async (params) => { calls.push(params); if (fail) throw new Error('offline'); return 'OK'; } }),
    buildPromptRequest,
    isBusy: () => busy,
    now: () => clock,
    skipProviders: ['publik']
  });
  return { warmUp, calls, advance: (ms) => { clock += ms; } };
}

test('sends one tiny request whose prompt starts with the same reference block as a real answer', async () => {
  const { warmUp, calls } = harness();
  assert.equal(await warmUp('launch'), 'warmed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxTokens, WARMUP_MAX_TOKENS);
  const real = buildPromptRequest(profile, 'say', [{ channel: 'them', text: 'Tell me about yourself', ts: 1 }]);
  assert.ok(real.cachePrefix.length > 0);
  assert.equal(calls[0].cachePrefix, real.cachePrefix);
  assert.ok(calls[0].system.startsWith(real.cachePrefix));
});

test('runs at most once per interval', async () => {
  const { warmUp, calls, advance } = harness();
  await warmUp('launch');
  assert.equal(await warmUp('listening'), 'recent');
  advance(WARMUP_MIN_INTERVAL_MS + 1);
  assert.equal(await warmUp('listening'), 'warmed');
  assert.equal(calls.length, 2);
});

test('never runs on publik, when switched off, over a request in progress, or without a key', async () => {
  assert.equal(await harness({ settings: { ...profile, provider: 'publik' } }).warmUp('launch'), 'disabled');
  assert.equal(await harness({ settings: { ...profile, warmUp: false } }).warmUp('launch'), 'disabled');
  assert.equal(await harness({ busy: true }).warmUp('launch'), 'busy');
  assert.equal(await harness({ ready: false }).warmUp('launch'), 'not-ready');
});

test('a failed warm-up is swallowed: it is only an optimisation', async () => {
  const { warmUp } = harness({ fail: true });
  assert.equal(await warmUp('launch'), 'failed');
});
