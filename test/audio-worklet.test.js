const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Runs renderer/audio-worklet-processor.js in a stand-in AudioWorkletGlobalScope.
function loadProcessor() {
  const registered = {};
  const context = {
    AudioWorkletProcessor: class {
      constructor() { this.port = { posted: [], postMessage(data) { this.posted.push(data); } }; }
    },
    registerProcessor: (name, cls) => { registered[name] = cls; },
    Float32Array,
    Int16Array,
    Math
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer/audio-worklet-processor.js'), 'utf8'), context);
  return new registered['cue-audio-processor']();
}

test('the capture worklet posts 60 ms chunks (960 samples at 16 kHz)', () => {
  const proc = loadProcessor();
  const quantum = new Float32Array(128).fill(0.25); // one Web Audio render quantum
  for (let i = 0; i < 30; i++) proc.process([[quantum]], [], {}); // 3840 samples
  assert.deepEqual(proc.port.posted.map((b) => new Int16Array(b).length), [960, 960, 960, 960]);
});

test('the ScriptProcessor fallbacks use 1024 samples, the smallest power of two above 60 ms', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/renderer.js'), 'utf8');
  const sizes = [...src.matchAll(/createScriptProcessor\((\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(sizes, [1024, 1024]);
});
