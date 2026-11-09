// Ported from upstream 0.2.10-0.2.13 onto the fork's own main.js and renderer:
// "Thinking…" while a model only reasons, thinking counts as activity for the
// answer watchdog, and giving up on a slide caption cancels its request.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { streamWithWatchdog } = require('../src/stream-watchdog');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const renderer = read('renderer/renderer.js');
const preload = read('preload.js');
const css = read('renderer/styles.css');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the watchdog counts thinking-only chunks as activity and forwards them', async () => {
  const kinds = [];
  // 60 ms of thinking in 15 ms steps, then an answer, under a 40 ms watchdog.
  const result = await streamWithWatchdog(async (params) => {
    for (let i = 0; i < 4; i++) { await sleep(15); params.onActivity('thinking'); }
    params.onToken('done');
    return 'done';
  }, { onToken: () => {}, onActivity: (k) => kinds.push(k) }, 40);
  assert.equal(result, 'done');
  assert.deepEqual(kinds, ['thinking', 'thinking', 'thinking', 'thinking']);
});

test('with no activity at all the watchdog still gives up', async () => {
  await assert.rejects(streamWithWatchdog(() => new Promise(() => {}), { onToken: () => {} }, 30), /timed out/);
});

test('main: "Thinking…" goes to the renderer while only reasoning arrives, at most every 5 s, never after the answer starts', () => {
  assert.match(main, /const THINKING_PING_MS = 5000;/);
  const run = main.slice(main.indexOf('const answer = await streamWithWatchdog(params => llm.stream(params), {'));
  assert.match(run, /onToken: t => \{ answering = true;/);
  assert.match(run, /if \(kind !== 'thinking' \|\| answering\) return;/);
  assert.match(run, /if \(now - lastThinkingAt < THINKING_PING_MS\) return;/);
  assert.match(run, /emit\('llm:thinking', \{\}\);/);
});

test('preload lets the renderer listen to llm:thinking', () => {
  assert.match(preload, /'llm:token', 'llm:thinking', 'llm:done'/);
});

test('renderer: llm:thinking shows one "Thinking…" before any text and keeps the busy failsafe away', () => {
  const handler = renderer.slice(renderer.indexOf("cue.on('llm:thinking'"), renderer.indexOf("cue.on('llm:done'"));
  assert.match(handler, /if \(isStale\(id\) \|\| !aiEl \|\| aiEl\.dataset\.raw\) return;/);
  assert.match(handler, /setBusy\(true\);/);
  assert.match(handler, /if \(aiEl\.querySelector\('\.ai-thinking'\)\) return;/);
  assert.match(handler, /thinking\.textContent = 'Thinking…';/);
  // The first token and the final message re-render the whole bubble.
  assert.match(renderer, /function renderStreaming\(\) \{[\s\S]*?aiEl\.innerHTML = renderMarkdown/);
  assert.match(renderer, /function finalizeAi\(note\) \{[\s\S]*?aiEl\.innerHTML = renderMarkdown\(raw\);/);
  assert.match(css, /\.ai-thinking \{[^}]*font-style: italic;/);
});

test('a slide caption that times out cancels its request and asks for the "…" cut', () => {
  const caption = main.slice(main.indexOf('async function captionSlide('), main.indexOf('async function pollSlides('));
  assert.match(caption, /const guard = giveUpTimer\(STREAM_INACTIVITY_MS, 'slide caption timed out'\);/);
  assert.match(caption, /signal: guard\.signal,/);
  assert.match(caption, /lengthCut: 'ellipsis',/);
  assert.match(caption, /guard\.expired/);
  assert.match(caption, /guard\.clear\(\);/);
});

test('the giveUpTimer aborts its signal when it fires', async () => {
  const { giveUpTimer } = require('../src/give-up');
  const guard = giveUpTimer(20, 'gave up');
  await assert.rejects(guard.expired, /gave up/);
  assert.equal(guard.signal.aborted, true);
});
