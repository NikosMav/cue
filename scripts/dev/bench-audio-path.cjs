// Main-process CPU per audio chunk while listening with OpenAI realtime:
// level metering and the speech-indicator VAD (main.js routeAudio), then the
// realtime client's VAD, 16->24 kHz resample, base64 and JSON framing.
// Offline: the socket is a stub, nothing is sent anywhere.
// Usage: node scripts/dev/bench-audio-path.cjs [--chunk-samples 960]
const { EventEmitter } = require('node:events');

const wsPath = require.resolve('ws');
let bytesOut = 0;
class StubSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')); }
  send(data) { bytesOut += data.length; }
  close() {}
}
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: StubSocket };

const { OpenAIRealtimeSTT } = require('../../src/stt-streaming');
const { AdaptiveVAD } = require('../../src/vad');
const { rms16 } = require('../../src/wav');

const flag = process.argv.indexOf('--chunk-samples');
const CHUNK_SAMPLES = flag > 0 ? Number(process.argv[flag + 1]) : 960;
const CHUNK_MS = CHUNK_SAMPLES / 16;

// About 3 s of tone-like speech, then about 3 s of near silence, repeating.
function makeChunk(index) {
  const buf = Buffer.alloc(CHUNK_SAMPLES * 2);
  const speech = Math.floor((index * CHUNK_MS) / 3000) % 2 === 0;
  for (let s = 0; s < CHUNK_SAMPLES; s++) {
    const t = index * CHUNK_SAMPLES + s;
    const v = speech ? 5000 * Math.sin(t / 3) + 800 * Math.sin(t / 17) : 40 * Math.sin(t);
    buf.writeInt16LE(Math.round(v), s * 2);
  }
  return buf;
}

(async () => {
  const stt = new OpenAIRealtimeSTT('bench', {});
  await stt.connect();
  await new Promise((resolve) => setImmediate(resolve));
  stt._handleEvent({ type: 'session.updated' });
  const indicatorVad = new AdaptiveVAD({});
  const chunks = Array.from({ length: Math.ceil(60000 / CHUNK_MS) }, (_, i) => makeChunk(i));
  const handle = (buf) => { rms16(buf); indicatorVad.processChunk(buf); stt.sendAudio(buf); };

  for (let i = 0; i < 400; i++) handle(chunks[i % chunks.length]); // JIT warm-up
  bytesOut = 0;

  const N = 5000;
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    handle(chunks[i % chunks.length]);
    times.push(Number(process.hrtime.bigint() - t0) / 1000);
  }
  times.sort((a, b) => a - b);
  const at = (p) => +times[Math.floor(p * (N - 1))].toFixed(1);
  const mean = times.reduce((a, b) => a + b, 0) / N;
  console.log(JSON.stringify({
    chunkSamples: CHUNK_SAMPLES,
    chunkMs: CHUNK_MS,
    usPerChunk: { mean: +mean.toFixed(1), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: +times[N - 1].toFixed(1) },
    cpuPctOfOneCorePerChannel: +((mean / (CHUNK_MS * 1000)) * 100).toFixed(3),
    uploadKbpsPerChannel: +((bytesOut * 8) / 1000 / ((N * CHUNK_MS) / 1000)).toFixed(1)
  }, null, 1));
  process.exit(0);
})();
