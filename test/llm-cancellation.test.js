const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let receivedSignal;
let anthropicBody;
let anthropicOptions;
let anthropicEvents = null; // override the fake stream for one test
const openaiChunks = [{ choices: [{ delta: { content: 'ok' } }] }];
let openaiBody;
let openaiEvents = null; // override the fake stream for one test

class FakeOpenAI {
  constructor() {
    this.chat = { completions: { create: async (body, options) => {
      openaiBody = body;
      receivedSignal = options.signal;
      return openaiEvents || openaiChunks;
    } } };
  }
}
FakeOpenAI.AzureOpenAI = FakeOpenAI;
Module._load = function(request, parent, isMain) {
  if (request === 'openai') return FakeOpenAI;
  if (request === '@anthropic-ai/sdk') return class {
    constructor() {
      this.messages = { create: async (body, options) => {
        anthropicBody = body;
        anthropicOptions = options;
        receivedSignal = options.signal;
        return anthropicEvents || [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }];
      } };
    }
  };
  if (request === '@google/genai') return { GoogleGenAI: class {
    constructor() {
      this.models = { generateContentStream: async request => {
        receivedSignal = request.config.abortSignal;
        return [{ text: 'ok' }];
      } };
    }
  } };
  return originalLoad.call(this, request, parent, isMain);
};
const { createLLM } = require('../src/llm');
test.after(() => { Module._load = originalLoad; });

for (const provider of ['openai', 'custom', 'publik', 'groq', 'minimax', 'azure', 'anthropic', 'gemini', 'ollama']) {
  test(`${provider} passes request cancellation to its transport`, async () => {
    const oldFetch = global.fetch;
    if (provider === 'ollama') global.fetch = async (_url, options) => {
      receivedSignal = options.signal;
      return { ok: true, body: [new TextEncoder().encode('{"message":{"content":"ok"}}\n')] };
    };
    try {
      const signal = new AbortController().signal;
      const llm = createLLM({ provider, apiKeys: { [provider]: 'test-only' },
        baseUrl: 'http://localhost:1234/v1', azureEndpoint: 'https://example.openai.azure.com',
        models: { [provider]: { fast: 'test-model' } } });
      receivedSignal = null;
      const result = await llm.stream({ system: 'test', turns: [{ role: 'user', text: 'test' }], signal, onToken() {} });
      assert.equal(result, 'ok');
      assert.equal(receivedSignal, signal);
    } finally {
      global.fetch = oldFetch;
    }
  });
}

test('Anthropic system prompt marks the stable reference prefix for caching', () => {
  const { anthropicSystem } = require('../src/llm');
  const blocks = anthropicSystem('REFERENCE\n\nMode rules.', 'REFERENCE');
  assert.deepEqual(blocks, [
    { type: 'text', text: 'REFERENCE', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n\nMode rules.' }
  ]);
  assert.equal(anthropicSystem('Mode rules.', ''), 'Mode rules.');
  assert.equal(anthropicSystem('Mode rules.', 'OTHER'), 'Mode rules.');
});

test('a per-request token budget and cache prefix reach the provider', async () => {
  const llm = createLLM({ provider: 'anthropic', apiKeys: { anthropic: 'k' }, models: {} });
  await llm.stream({ system: 'REF\n\nRules', cachePrefix: 'REF', maxTokens: 4096, turns: [{ role: 'user', text: 'q' }], onToken: () => {} });
  assert.equal(anthropicBody.max_tokens, 4096);
  assert.equal(anthropicBody.system[0].cache_control.type, 'ephemeral');
  await llm.stream({ system: 'Rules', turns: [{ role: 'user', text: 'q' }], onToken: () => {} });
  assert.equal(anthropicBody.max_tokens, 700);
  assert.equal(anthropicBody.system, 'Rules');
});

test('several screenshots are sent in order to every image-capable adapter', async () => {
  const shots = ['data:image/png;base64,QUFB', 'data:image/png;base64,QkJC'];
  const anthropic = createLLM({ provider: 'anthropic', apiKeys: { anthropic: 'k' }, models: {} });
  await anthropic.stream({ system: 's', turns: [{ role: 'user', text: 'solve' }], imageDataUrls: shots, onToken: () => {} });
  const content = anthropicBody.messages[0].content;
  assert.deepEqual(content.map(c => c.type), ['image', 'image', 'text']);
  assert.deepEqual(content.slice(0, 2).map(c => c.source.data), ['QUFB', 'QkJC']);
  // The single-image form still works.
  await anthropic.stream({ system: 's', turns: [{ role: 'user', text: 'solve' }], imageDataUrl: shots[0], onToken: () => {} });
  assert.deepEqual(anthropicBody.messages[0].content.map(c => c.type), ['image', 'text']);
});

test('Claude models that think by default get an effort level, thinking room and refusal fallbacks', async () => {
  const opus = createLLM({ provider: 'anthropic', apiKeys: { anthropic: 'k' }, models: { anthropic: { fast: 'claude-opus-5' } } });
  await opus.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], effort: 'low', onToken: () => {} });
  assert.equal(anthropicBody.output_config.effort, 'low');
  assert.ok(anthropicBody.max_tokens > 700, 'room for thinking on top of the answer budget');
  assert.equal(anthropicBody.fallbacks, 'default');
  assert.equal(anthropicOptions.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(anthropicBody.thinking, undefined, 'thinking stays on (adaptive by default)');

  const haiku = createLLM({ provider: 'anthropic', apiKeys: { anthropic: 'k' }, models: {} });
  await haiku.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], effort: 'low', onToken: () => {} });
  assert.equal(anthropicBody.model, 'claude-haiku-4-5');
  assert.equal(anthropicBody.output_config, undefined, 'Haiku 4.5 rejects effort');
  assert.equal(anthropicBody.fallbacks, undefined);
  assert.equal(anthropicBody.max_tokens, 700);
});

test('Smart raises the effort one level', async () => {
  const opus = createLLM({ provider: 'anthropic', smart: true, apiKeys: { anthropic: 'k' }, models: { anthropic: { smart: 'claude-opus-5' } } });
  await opus.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], effort: 'low', onToken: () => {} });
  assert.equal(anthropicBody.output_config.effort, 'medium');
});

test('a refusal or an answer lost to the output limit is reported, not shown as an empty answer', async () => {
  const llm = createLLM({ provider: 'anthropic', apiKeys: { anthropic: 'k' }, models: { anthropic: { fast: 'claude-opus-5' } } });
  try {
    anthropicEvents = [{ type: 'message_delta', delta: { stop_reason: 'refusal' } }];
    await assert.rejects(llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {} }), /declined this request/);
    anthropicEvents = [{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }];
    await assert.rejects(llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {} }), /whole output budget/);
    anthropicEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }];
    assert.equal(await llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {} }), 'partial');
  } finally {
    anthropicEvents = null;
  }
});

test('OpenAI gets max_completion_tokens; reasoning models get room to reason and an effort level', async () => {
  const ask = (settings) => createLLM({ apiKeys: { openai: 'k', custom: 'k', groq: 'k' }, baseUrl: 'http://127.0.0.1:9/v1', ...settings })
    .stream({ system: 's', turns: [{ role: 'user', text: 'q' }], effort: 'low', onToken: () => {} });

  await ask({ provider: 'openai', models: { openai: { fast: 'gpt-4.1-mini' } } });
  assert.equal(openaiBody.max_completion_tokens, 700);
  assert.equal(openaiBody.max_tokens, undefined, 'reasoning models reject max_tokens');
  assert.equal(openaiBody.reasoning_effort, undefined);

  for (const model of ['gpt-5-mini', 'o4-mini']) {
    await ask({ provider: 'openai', models: { openai: { fast: model } } });
    assert.equal(openaiBody.max_tokens, undefined, model);
    assert.ok(openaiBody.max_completion_tokens > 700, `${model}: room for reasoning`);
    assert.equal(openaiBody.reasoning_effort, 'low', model);
  }
  await ask({ provider: 'openai', smart: true, models: { openai: { smart: 'gpt-5' } } });
  assert.equal(openaiBody.reasoning_effort, 'medium', 'Smart raises the effort');

  // OpenAI-compatible servers keep the parameter they support.
  for (const provider of ['custom', 'groq']) {
    await ask({ provider, models: { [provider]: { fast: 'o3-lookalike' } } });
    assert.equal(openaiBody.max_tokens, 700, provider);
    assert.equal(openaiBody.max_completion_tokens, undefined, provider);
    assert.equal(openaiBody.reasoning_effort, undefined, provider);
  }
});

test('an OpenAI answer lost entirely to reasoning is reported, not shown as empty', async () => {
  const llm = createLLM({ provider: 'openai', apiKeys: { openai: 'k' }, models: { openai: { fast: 'gpt-5-mini' } } });
  try {
    openaiEvents = [{ choices: [{ delta: {}, finish_reason: 'length' }] }];
    await assert.rejects(llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {} }), /whole output budget/);
    openaiEvents = [{ choices: [{ delta: { content: 'partial' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }];
    assert.equal(await llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {} }), 'partial');
  } finally {
    openaiEvents = null;
  }
});
