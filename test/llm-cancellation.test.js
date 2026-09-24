const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let receivedSignal;
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
      this.messages = { create: async (_body, options) => {
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
