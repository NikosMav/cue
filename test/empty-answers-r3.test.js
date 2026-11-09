// Defects from the blind verify of 55c4589 (coordinator, 2026-11-05):
// 1. Screenshot questions (fast tier routed to publik-balanced) got only
//    2,048 tokens of thinking room, below publik-balanced's p99 of 2,691.
//    Every publik-balanced call now gets 4,096; publik-fast text keeps 2,048.
// 2. Saved meeting notes carried "(Cut off: …)". They are trimmed and end
//    with "…", as slide captions are.
// 3. An explicit maxTokens: undefined sent max_tokens NaN to publik.
// 4. When the watchdog or the caption timer gave up, the request kept
//    streaming and publik still billed it. Giving up now aborts it.
// 5. The 40 s busy failsafe was reset by thinking but not by answer tokens.
// 6. The source-text tests failed on a Windows (CRLF) checkout.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const Module = require('node:module');

let created = null;   // the request body cue sent
let options = null;   // the SDK request options cue sent
let chunks = [];
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: (req, opts) => { created = req; options = opts; return Promise.resolve(chunks); } } };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalModuleLoad; });

const { createLLM } = require('../src/llm');
const source = require('./source-text');

function publikSettings(overrides = {}) {
  return {
    provider: 'publik', smart: false,
    apiKeys: { publik: 'pk_test_abcdefghijkl_abcdefghijklmnopqrstuvwxyz012345', openai: 'sk-own' },
    publik: { baseUrl: '' },
    models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' }, openai: { fast: 'gpt-own', smart: 'gpt-own' } },
    ...overrides
  };
}
const text = (t) => ({ choices: [{ delta: { content: t } }] });
const thinking = (t) => ({ choices: [{ delta: { reasoning: t } }] });
const finish = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const IMAGE = 'data:image/jpeg;base64,AAAA';
const ask = (settings, params = {}) => createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {}, ...params });

test.beforeEach(() => { created = null; options = null; chunks = [text('ok'), finish('stop')]; });

// ---- 1. publik-balanced gets 4,096 tokens of thinking room ------------------

test('1: a screenshot question on the fast tier (publik-balanced) gets 4,096 thinking room: 700 -> 4,796', async () => {
  await ask(publikSettings(), { imageDataUrl: IMAGE });
  assert.equal(created.model, 'publik-balanced');
  assert.equal(created.max_tokens, 4796);
});

test('1: every publik-balanced call gets 4,096, also a fast tier set to publik-balanced', async () => {
  await ask(publikSettings({ models: { publik: { fast: 'publik-balanced', smart: 'publik-balanced' } } }));
  assert.equal(created.model, 'publik-balanced');
  assert.equal(created.max_tokens, 700 + 4096);
  await ask(publikSettings({ smart: true }), { imageDataUrl: IMAGE });
  assert.equal(created.max_tokens, 1400 + 4096);
});

test('1: publik-fast text keeps 2,048 (glm p99 628, max 960): 2,748', async () => {
  await ask(publikSettings());
  assert.equal(created.model, 'publik-fast');
  assert.equal(created.max_tokens, 2748);
});

// ---- 2. stored meeting notes never carry the cut-off note --------------------

function notesHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-notes-cut-'));
  const store = createMeetingStore({ file: path.join(dir, 'meetings.json') });
  let clock = 1_000_000;
  const memory = createMeetingMemory({ store, llmFactory: () => createLLM(publikSettings()), now: () => clock, log: () => {}, minTurnsForNotes: 2 });
  memory.onTurn({ channel: 'them', text: 'Ship the pipeline Tuesday?', ts: 1_000_001 });
  memory.onTurn({ channel: 'you', text: 'Yes, and budget is forty thousand.', ts: 1_000_002 });
  clock += 10;
  return { store, memory };
}

// ---- 3. maxTokens: undefined falls back to the default cap ------------------

test('3: an explicit maxTokens: undefined on publik sends the default cap, never NaN', async () => {
  await ask(publikSettings(), { maxTokens: undefined });
  assert.equal(created.max_tokens, 2748);
  await ask(publikSettings(), { maxTokens: undefined, imageDataUrl: IMAGE });
  assert.equal(created.max_tokens, 4796);
  await ask(publikSettings({ smart: true }), { maxTokens: null });
  assert.equal(created.max_tokens, 1400 + 4096);
});

test('3: an own key with maxTokens: undefined also gets the default cap', async () => {
  await ask(publikSettings({ provider: 'openai' }), { maxTokens: undefined });
  assert.equal(created.max_completion_tokens, 700);
});

// ---- 4. giving up cancels the request ----------------------------------------

function fakeTimers() {
  let now = 0; let seq = 0; const due = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; due.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { due.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = until;
    }
  };
}

test('4: the give-up timer aborts the request when it fires, after the last re-arm', async () => {
  const { giveUpTimer } = require('../src/give-up');
  const timers = fakeTimers();
  const guard = giveUpTimer(25000, 'the model stopped responding', timers);
  let rejected = null;
  guard.expired.catch((e) => { rejected = e; });
  timers.advance(20000);
  guard.rearm();
  timers.advance(20000);
  await Promise.resolve();
  assert.equal(guard.signal.aborted, false, 're-armed at 20 s: still waiting at 40 s');
  timers.advance(5000);
  await Promise.resolve();
  assert.equal(guard.signal.aborted, true, 'gave up at 45 s: the request is aborted');
  assert.match(rejected && rejected.message, /the model stopped responding/);

  const settled = giveUpTimer(25000, 'x', timers);
  settled.clear();
  timers.advance(60000);
  assert.equal(settled.signal.aborted, false, 'a settled stream is never aborted');
});

test('4: llm.stream hands cue\'s cancel signal to the provider request', async () => {
  const controller = new AbortController();
  await ask(publikSettings(), { imageDataUrl: IMAGE, signal: controller.signal });
  assert.equal(options && options.signal, controller.signal);
  await ask(publikSettings({ provider: 'openai' }), { signal: controller.signal });
  assert.equal(options && options.signal, controller.signal);
});

// ---- 5. answer tokens also keep the busy failsafe away -----------------------

function busyHarness() {
  const src = source.readSource('renderer/renderer.js');
  const fns = ['  function setBusy(v) {', '  function armBusyFailsafe() {', '  function onAnswerActivity() {'].map((h) => source.fnFrom(src, h)).join('\n');
  const timers = fakeTimers();
  const button = { classList: { toggle() {} } };
  const ctx = vm.createContext({ $: () => button, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  vm.runInContext(`var busy = false; var busyFailsafe = null;\n${fns}\nfunction isBusy() { return busy; }`, ctx);
  return { ctx, timers, src };
}

// ---- 6. source-text tests on a Windows (CRLF) checkout -----------------------

// A real Windows checkout: copy the sources and the source-text test files
// with CRLF line ends and run those tests there.
const out0 = (r) => String(r.stdout || '') + String(r.stderr || '');
