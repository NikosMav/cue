const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// renderer.js is a browser script with no harness, so guard the shape of the
// capture:state handler by inspection. It once called startMic() twice (a
// leftover duplicate line); the guard inside startMic() can't catch that
// because the second call lands while the first is still awaiting
// getUserMedia, so two capture pipelines fed the "you" channel — every slice
// of speech arrived twice and Deepgram/Gemini could not transcribe the mic.
test('capture:state handler starts the mic exactly once and startMic is re-entrancy safe', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/renderer.js'), 'utf8');
  const start = src.indexOf("cue.on('capture:state'");
  assert.ok(start > -1, 'capture:state handler not found');
  const end = src.indexOf("cue.on('", start + 10);
  const handler = src.slice(start, end > -1 ? end : undefined);
  assert.equal((handler.match(/\bstartMic\(\)/g) || []).length, 1, 'capture:state must call startMic() exactly once');
  assert.match(src, /const gen = \+\+micGen;[\s\S]*?if \(gen !== micGen \|\| micStream\)/, 'startMic must drop a superseded getUserMedia result');
  assert.match(src, /function stopMic\(\) \{\s*micGen\+\+;/, 'stopMic must invalidate an in-flight startMic');
});
