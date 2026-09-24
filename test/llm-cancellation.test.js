const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let receivedSignal;
let anthropicBody;
const openaiChunks = [{ choices: [{ delta: { content: 'ok' } }] }];

class FakeOpenAI {
  constructor() {
    this.chat = { completions: { create: async (_body, options) => {
      receivedSignal = options.signal;
      return openaiChunks;
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
        receivedSignal = options.signal;
        return [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }];
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
