// Follow-ups to the empty-answers fix (coordinator, 2026-11-05):
// 1. A reasoning model can think for 90 s before it writes. Show "Thinking…"
//    in the answer area while only reasoning chunks arrive, never the
//    reasoning text, and replace it with the first answer token or with the
//    honest message.
// 2. A slide caption cut at its cap is trimmed and ends with "…", never with
//    the chat answer's "(Cut off: …)" note. The 25 s total timer stays.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('vm');
const Module = require('node:module');

let created = null;
let chunks = [];
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: (req) => { created = req; return Promise.resolve(chunks); } } };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalModuleLoad; });

const { createLLM } = require('../src/llm');
const { readSource, fnFrom } = require('./source-text'); // CRLF-safe (Windows checkouts)
const mainSrc = readSource('main.js');
const rendererSrc = readSource('renderer/renderer.js');
const preloadSrc = readSource('preload.js');

const settings = {
  provider: 'publik', smart: false,
  apiKeys: { publik: 'pk_test_abcdefghijkl_abcdefghijklmnopqrstuvwxyz012345' },
  publik: { baseUrl: '' },
  models: { publik: { fast: 'publik-fast', smart: 'publik-balanced' } }
};
const text = (t) => ({ choices: [{ delta: { content: t } }] });
const thinking = (t) => ({ choices: [{ delta: { reasoning: t, reasoning_details: [{ type: 'reasoning.text', text: t }] } }] });
const finish = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }] });
const IMAGE = 'data:image/jpeg;base64,AAAA';

test.beforeEach(() => { created = null; chunks = [text('ok'), finish('stop')]; });

// ---- 1. "Thinking…" ---------------------------------------------------------

test('llm: each chunk reports its kind, so cue can tell thinking from answering', async () => {
  chunks = [thinking('a'), { choices: [{ delta: { reasoning_content: 'b' } }] }, text('Answer.'), finish('stop')];
  const kinds = [];
  await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {}, onActivity: (k) => kinds.push(k) });
  assert.deepEqual(kinds, ['thinking', 'thinking', 'text', 'other']);
});

test('preload: the renderer may listen to llm:thinking', () => {
  assert.match(preloadSrc, /'llm:thinking'/);
});

function rendererHarness() {
  class El {
    constructor(tag) { this.tagName = tag; this.className = ''; this.textContent = ''; this.children = []; this.parentNode = null; this.dataset = {}; this.html = ''; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
    remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      for (const c of this.children) { if (c.className.split(' ').includes(cls)) return c; const r = c.querySelector(sel); if (r) return r; }
      return null;
    }
    set innerHTML(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this.html = v; }
    get innerHTML() { return this.html; }
    get shown() { return this.html + this.children.map((c) => c.textContent + (c.children.length ? c.shown : '')).join(''); }
  }
  const fns = ['  function showThinking() {', '  function clearThinking() {', '  function appendToken(t) {', '  function finalizeAi() {']
    .map((h) => fnFrom(rendererSrc, h)).join('\n');
  const ctx = vm.createContext({
    document: { createElement: (t) => new El(t) }, renderMarkdown: (raw) => `<p>${raw}</p>`, startAi: () => { throw new Error('no bubble'); },
    scrollAnswerToEnd: () => {} // follow-the-answer scrolling (test/answer-area-ui.test.js)
  });
  vm.runInContext(`var aiEl = null, caretEl = null;\n${fns}\nfunction newBubble() { aiEl = document.createElement('div'); aiEl.className = 'ai-text'; aiEl.dataset.raw = ''; caretEl = document.createElement('span'); caretEl.className = 'ai-caret'; aiEl.appendChild(caretEl); return aiEl; }`, ctx);
  return ctx;
}

// ---- 2. slide captions ------------------------------------------------------

test('a slide caption cut at its cap is trimmed and ends with "…", with no cut-off note', async () => {
  chunks = [thinking('look'), text('Q3 revenue grew 12%, '), finish('length')];
  const got = [];
  const caption = await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis', onToken: (t) => got.push(t) });
  assert.equal(caption, 'Q3 revenue grew 12%…');
  assert.ok(!got.join('').includes('Cut off'));
  assert.equal(created.model, 'publik-balanced');
  assert.equal(created.max_tokens, 300 + 4096);
});

test('a whole slide caption is unchanged', async () => {
  chunks = [text('Q3 revenue grew 12%.'), finish('stop')];
  const caption = await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: IMAGE, maxTokens: 300, lengthCut: 'ellipsis', onToken: () => {} });
  assert.equal(caption, 'Q3 revenue grew 12%.');
});
