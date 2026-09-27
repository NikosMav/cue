const assert = require('node:assert/strict');
const test = require('node:test');
const { AdaptiveVAD } = require('../src/vad');

// 16 kHz mono PCM: [durationMs, isSpeech] parts, a loud tone for speech.
function signal(parts) {
  const samples = parts.reduce((n, [ms]) => n + ms * 16, 0);
  const buf = Buffer.alloc(samples * 2);
  let s = 0;
  for (const [ms, speech] of parts) {
    for (let i = 0; i < ms * 16; i++, s++) {
      if (speech) buf.writeInt16LE(Math.round(6000 * Math.sin(s / 3)), s * 2);
    }
  }
  return buf;
}

class CountingVAD extends AdaptiveVAD {
  constructor(options) { super(options); this.frames = 0; }
  _processFrame(energy) { this.frames++; super._processFrame(energy); }
}

function run(buf, chunkSamples) {
  const events = [];
  const vad = new CountingVAD({
    onSpeechStart: () => events.push('start@' + vad.frames),
    onSpeechEnd: (ms) => events.push('end@' + vad.frames + ':' + ms)
  });
  for (let off = 0; off < buf.length; off += chunkSamples * 2) vad.processChunk(buf.subarray(off, off + chunkSamples * 2));
  return { events, frames: vad.frames };
}

test('every 30 ms frame is analysed once, whatever the chunk size', () => {
  // 3450 ms = 115 whole frames of 480 samples.
  const audio = signal([[600, false], [900, true], [700, false], [450, true], [800, false]]);
  const reference = run(audio, 480); // one frame per chunk: nothing to carry over
  assert.equal(reference.frames, 115);
  assert.equal(reference.events.length, 4, 'two utterances: start and end each');
  for (const chunkSamples of [960, 1024, 4096]) {
    assert.deepEqual(run(audio, chunkSamples), reference, `${chunkSamples}-sample chunks`);
  }
});

test('reset() drops a partial frame instead of joining it to new audio', () => {
  const vad = new CountingVAD({});
  vad.processChunk(Buffer.alloc(1024 * 2)); // 2 frames, 64 samples left over
  vad.reset();
  vad.processChunk(Buffer.alloc(416 * 2)); // 64 + 416 would make a frame
  assert.equal(vad.frames, 2);
});

test('processChunk accepts an ArrayBuffer (as IPC delivers audio) like a Buffer', () => {
  const vad = new CountingVAD({});
  const ab = new ArrayBuffer(960 * 2); // two whole frames
  vad.processChunk(ab);
  assert.equal(vad.frames, 2);
});
