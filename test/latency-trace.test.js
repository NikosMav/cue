const test = require('node:test');
const assert = require('node:assert/strict');
const { LatencyTrace } = require('../src/latency-trace');

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('an auto answer logs each step of the pipeline', () => {
  const c = clock();
  const lines = [];
  const trace = new LatencyTrace({ enabled: true, now: c.now, log: (l) => lines.push(l) });
  trace.commit('them'); c.advance(600);
  trace.final('them'); c.advance(1200);
  trace.fire(); trace.start(7, 'answerThis', true); c.advance(500);
  trace.token(7); c.advance(100);
  trace.token(7); c.advance(1900);
  trace.done(7);
  assert.deepEqual(lines, ['[latency] answerThis (auto) | commit>final 600ms | final>fire 1200ms | start>first 500ms | first>done 2000ms | commit>first 2300ms']);
});

test('a manual answer reports final>start, and the candidate channel is ignored', () => {
  const c = clock();
  const lines = [];
  const trace = new LatencyTrace({ enabled: true, now: c.now, log: (l) => lines.push(l) });
  trace.commit('them'); c.advance(400);
  trace.final('them'); c.advance(100);
  trace.commit('you'); trace.final('you'); c.advance(900);
  trace.start(1, 'say', false); c.advance(300);
  trace.token(1); trace.done(1);
  assert.match(lines[0], /say \(manual\) \| commit>final 400ms \| final>start 1000ms \| start>first 300ms/);
});

test('the event-loop delay is reported per answer and then reset', () => {
  const lines = [];
  let resets = 0;
  const loopDelay = { max: 250e6, reset: () => { resets++; } };
  const trace = new LatencyTrace({ enabled: true, log: (l) => lines.push(l), loopDelay });
  trace.start(1, 'say', false); trace.done(1);
  assert.match(lines[0], /\| loop max 250ms$/);
  assert.equal(resets, 1);
});

test('disabled, or a stale request id, logs nothing', () => {
  const lines = [];
  const off = new LatencyTrace({ enabled: false, log: (l) => lines.push(l) });
  off.start(1, 'say', false); off.token(1); off.done(1);
  const on = new LatencyTrace({ enabled: true, log: (l) => lines.push(l) });
  on.start(2, 'say', false); on.done(1);
  assert.deepEqual(lines, []);
});

test('main takes presentation frames from the renderer and grabs only as a fallback', () => {
  const fs = require('fs');
  const main = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const poll = main.slice(main.indexOf('async function pollPresentation()'), main.indexOf('\n}\n', main.indexOf('async function pollPresentation()')));
  assert.match(poll, /if \(rendererFrames\.active\) return;/);
  assert.match(main, /ipcMain\.on\('frames:frame'/);
  assert.match(main, /thumbnailSize: \{ width: 0, height: 0 \}/, 'the source lookup skips thumbnails');
  const preload = fs.readFileSync(require('path').join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /'frames:start', 'frames:stop'/);
});
