// Fixes for the failures the v0.2.6 smoke test found (2026-11-02):
//   test 5  - screen questions on publik's fast tier were answered wrongly;
//   test 6  - a Mac user on publik with no audio key of their own got no transcript;
//   test 9  - after a dashboard revoke, the first Reconnect press did nothing visible;
//   test 12 - closing Settings switched a person who picked publik back to an old own key.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

let clients = [];        // every FakeOpenAI constructed: { options, chatRequests, audioRequests }
let audioError = null;   // when set, audio.transcriptions.create rejects with it
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    class FakeOpenAI {
      constructor(options) {
        const rec = { options, chatRequests: [], audioRequests: [] };
        clients.push(rec);
        this.chat = { completions: { create: (req) => { rec.chatRequests.push(req); return Promise.resolve([{ choices: [{ delta: { content: 'ok' } }] }]); } } };
        this.audio = { transcriptions: { create: (req) => { rec.audioRequests.push(req); return audioError ? Promise.reject(audioError) : Promise.resolve({ text: 'hello from the meeting' }); } } };
      }
    }
    FakeOpenAI.toFile = async (buf, name, opts) => ({ name, type: opts && opts.type, size: buf.length });
    return FakeOpenAI;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createLLM } = require('../src/llm');
const { createSTT, publikTranscription, PUBLIK_STT_MODEL } = require('../src/stt');
const publik = require('../src/publik');

test.after(() => { Module._load = originalModuleLoad; });
test.beforeEach(() => { clients = []; audioError = null; });

const PUBLIK_KEY = 'pk_live_' + 'a'.repeat(12) + '_' + 'b'.repeat(32);
const IMAGE = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');

function publikSettings(overrides = {}) {
  return {
    provider: 'publik',
    smart: false,
    sttProvider: 'auto',
    apiKeys: { publik: PUBLIK_KEY },
    publik: { baseUrl: 'https://publikhq.com/api/v1', revoked: false },
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } },
    ...overrides
  };
}

// ---- test 5: a screenshot question goes to a model that can read a screen ----

test('publik fast tier: a question with a screenshot is sent to the smart alias (publik-balanced)', async () => {
  const llm = createLLM(publikSettings());
  assert.equal(llm.model, 'publik-fast');
  assert.equal(llm.visionModel, 'publik-balanced');
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'Which website is open?' }], imageDataUrl: IMAGE, onToken: () => {} });
  const req = clients[0].chatRequests[0];
  assert.equal(req.model, 'publik-balanced');
  assert.equal(req.messages[1].content[1].type, 'image_url', 'the screenshot is still attached');
});

test('publik fast tier: a text-only question stays on publik-fast', async () => {
  const llm = createLLM(publikSettings());
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'What is 17 times 23?' }], onToken: () => {} });
  assert.equal(clients[0].chatRequests[0].model, 'publik-fast');
});

test('publik: the server-provided smart alias is used for screenshots; cleared fields fall back to publik-balanced', async () => {
  const fromServer = createLLM(publikSettings({ models: { publik: { fast: 'publik-fast', smart: 'publik-default' } } }));
  assert.equal(fromServer.visionModel, 'publik-default');
  const cleared = createLLM(publikSettings({ models: { publik: { fast: '', smart: '' } } }));
  assert.equal(cleared.model, 'publik-fast');
  assert.equal(cleared.visionModel, 'publik-balanced');
});

test('publik: Smart on keeps the smart model for screenshots; an own Fast model choice is respected', async () => {
  assert.equal(createLLM(publikSettings({ smart: true })).visionModel, 'publik-balanced');
  const own = createLLM(publikSettings({ models: { publik: { fast: 'gpt-4o', smart: 'publik-balanced' } } }));
  assert.equal(own.model, 'gpt-4o');
  assert.equal(own.visionModel, 'gpt-4o');
});

test('other providers: a screenshot never changes the model', async () => {
  const llm = createLLM({ provider: 'openai', smart: false, apiKeys: { openai: 'sk-test' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } } });
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: IMAGE, onToken: () => {} });
  assert.equal(clients[0].chatRequests[0].model, 'gpt-4o-mini');
});

// ---- test 6: publik transcribes for a publik user with no audio key ----

// 0.2.9 (smoke test v0.2.8): with publik as the provider, Auto audio is
// publik only. An old own key is used only when it is picked on the Audio tab.
test('publik never transcribes when it is not the selected provider, its key is revoked or missing, or STT is set explicitly', () => {
  assert.equal(createSTT(publikSettings({ provider: 'anthropic', apiKeys: { publik: PUBLIK_KEY, anthropic: 'sk-ant' } })).available, false);
  assert.equal(createSTT(publikSettings({ publik: { baseUrl: '', revoked: true } })).available, false);
  assert.equal(createSTT(publikSettings({ apiKeys: { publik: '' } })).available, false);
  assert.equal(createSTT(publikSettings({ sttProvider: 'local' })).available, false);
  assert.deepEqual(createSTT(publikSettings({ sttProvider: 'openai' })).providers, []);
});

// ---- test 9: a 401 on a question marks the key revoked ----

test('a 401 from the gateway tells main.js the key on disk is dead (action.revoked)', () => {
  const removed = publik.describeGatewayError({ status: 401, body: { type: 'key_revoked', reprovision: false } });
  assert.deepEqual(removed.action, { kind: 'reconnect', label: 'Reconnect', revoked: 'key_revoked' });
  const invalid = publik.describeGatewayError({ status: 401, body: { type: 'invalid_api_key' } });
  assert.deepEqual(invalid.action, { kind: 'reconnect', label: 'Reconnect', revoked: 'invalid_key' });
  const idle = publik.describeGatewayError({ status: 401, body: { type: 'key_revoked', reprovision: true } });
  assert.deepEqual(idle.action, { kind: 'reprovision' });
});

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

// ---- test 12: closing Settings keeps publik selected ----

const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
function fnSource(name) {
  const start = rendererSrc.indexOf(`async function ${name}()`);
  assert.ok(start > -1, `${name} not found in renderer.js`);
  const end = rendererSrc.indexOf('\n  }\n', start);
  return rendererSrc.slice(start, end + 4);
}

// Runs the real saveSettings source against fake inputs. `typed` is what the
// key fields hold at close; `atOpen` the keys Settings showed when it opened.
async function closeSettingsWith({ settings, publikState, typed = {}, atOpen }) {
  const ids = ['cerebras', 'openai', 'anthropic', 'groq', 'custom', 'gemini', 'deepgram', 'ollama', 'minimax', 'deepseek', 'azure'];
  const values = { '#base-url': '', '#azure-endpoint': '', '#model-fast': '', '#model-smart': '', '#whisper-model': 'base.en', '#whisper-language': 'auto', '#whisper-threads': '0', '#ai-rules': '' };
  for (const id of ids) values[`#key-${id}`] = typed[id] !== undefined ? typed[id] : (settings.apiKeys[id] || '');
  const el = (id) => ({ value: values[id] !== undefined ? values[id] : '', textContent: '', focus() {}, checked: false });
  let saved = null;
  const ctx = vm.createContext({
    $: el, settings, publikState, keysAtOpen: atOpen || { ...settings.apiKeys },
    cue: { settingsSet: async (s) => { saved = JSON.parse(JSON.stringify(s)); return s; } },
    clampOpacity: (x) => x, statusText: () => '', updateSmartTooltip: () => {}, Number
  });
  vm.runInContext(`${fnSource('saveSettings')}\nthis.run = saveSettings;`, ctx);
  assert.equal(await ctx.run(), true);
  return saved;
}

const V024 = () => ({ provider: 'publik', apiKeys: { openai: 'sk-from-0.2.4', publik: '' }, models: { publik: { fast: '', smart: '' } }, localWhisper: {}, slides: {} });
