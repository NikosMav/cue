// Transcription latency through cue's OpenAI realtime client against the real
// API, paced like the app. Per trial:
//   connectMs          socket opened -> session ready
//   firstWordMs        first audio captured -> first live word
//   commitAfterSpeech  speaker stops -> sentence closed by the client
//   finalAfterSpeech   speaker stops -> final transcript line
// Usage: node scripts/dev/bench-transcription.cjs <speech.wav> [--trials 5] [--chunk-samples 960]
// The WAV must be 16 kHz mono 16-bit PCM holding one spoken sentence. The
// OpenAI key comes from cue's settings file and is never printed; each trial
// streams about 6 s of audio to OpenAI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataDirectory } = require('../../src/config-path');
const { OpenAIRealtimeSTT } = require('../../src/stt-streaming');

const USAGE = 'Usage: node scripts/dev/bench-transcription.cjs <speech.wav> [--trials 5] [--chunk-samples 960]';
const wavPath = process.argv[2];
if (!wavPath || wavPath.startsWith('--')) { console.error(USAGE); process.exit(2); }
const numberArg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const TRIALS = numberArg('--trials', 5);
const CHUNK_SAMPLES = numberArg('--chunk-samples', 960);
const CHUNK_BYTES = CHUNK_SAMPLES * 2;
const CHUNK_MS = CHUNK_SAMPLES / 16;
const bytesToMs = (bytes) => bytes / 32; // 16 kHz 16-bit mono

// Same data directory as scripts/cue-config.js.
const fallback = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'cue')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'cue')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cue');
const dataDir = resolveDataDirectory({ appDirectory: path.join(__dirname, '..', '..'), defaultDirectory: fallback });
const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'cue-data.json'), 'utf8').replace(/^﻿/, ''));
const key = (settings.apiKeys || {}).openai;
if (!key) { console.error('No OpenAI key saved in ' + dataDir); process.exit(1); }

const speech = fs.readFileSync(wavPath).subarray(44);
// Latency counts from the last audible sample, not the file's trailing silence.
let voiceEndByte = 0;
for (let i = 0; i < speech.length; i += 2) if (Math.abs(speech.readInt16LE(i)) > 500) voiceEndByte = i + 2;
const expected = process.env.BENCH_EXPECTED_TEXT || '';

function trial() {
  return new Promise((resolve) => {
    const result = {};
    const connectStart = Date.now();
    let speechStart = 0, speechEnd = 0, timer = null, done = false, text = '';
    const stt = new OpenAIRealtimeSTT(key, {
      onInterim: (t) => { if (t && !result.firstWordMs) result.firstWordMs = Date.now() - speechStart; },
      onTranscript: (t) => { result.finalAfterSpeech = Math.round(Date.now() - speechEnd); text = t; finish(); },
      onError: (e) => { result.error = e.message; finish(); }
    });
    const send = stt._sendEvent.bind(stt);
    stt._sendEvent = (event) => {
      if (event.type === 'input_audio_buffer.commit' && speechEnd && !result.commitAfterSpeech) result.commitAfterSpeech = Math.round(Date.now() - speechEnd);
      send(event);
    };
    const handle = stt._handleEvent.bind(stt);
    stt._handleEvent = (event) => {
      handle(event);
      if (event.type !== 'session.updated' || timer) return;
      result.connectMs = Date.now() - connectStart;
      let offset = 0, silentChunks = 0;
      // The first chunk leaves once its last sample is captured, so its audio
      // began one chunk earlier; first-word latency counts from there.
      speechStart = Date.now() - CHUNK_MS;
      const tick = () => {
        if (offset < speech.length) {
          const end = Math.min(offset + CHUNK_BYTES, speech.length);
          // A chunk leaves once its last sample is captured, so the voice
          // ended (end - voiceEndByte) worth of audio before now.
          if (!speechEnd && end >= voiceEndByte) speechEnd = Date.now() - bytesToMs(end - voiceEndByte);
          stt.sendAudio(speech.subarray(offset, end));
          offset = end;
        } else if (silentChunks++ < Math.ceil(5000 / CHUNK_MS)) {
          stt.sendAudio(Buffer.alloc(CHUNK_BYTES));
        }
      };
      tick();
      timer = setInterval(tick, CHUNK_MS);
    };
    const guard = setTimeout(() => { result.error = 'timeout'; finish(); }, 30000);
    function finish() {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(guard);
      stt.disconnect();
      if (expected) result.exact = text === expected;
      resolve(result);
    }
    stt.connect();
  });
}

(async () => {
  const results = [];
  for (let i = 0; i < TRIALS; i++) {
    const r = await trial();
    console.log('trial', i + 1, JSON.stringify(r));
    results.push(r);
  }
  const ok = results.filter((r) => !r.error);
  const median = (k) => {
    const v = ok.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
  };
  console.log(JSON.stringify({
    chunkSamples: CHUNK_SAMPLES,
    trials: TRIALS,
    ok: ok.length,
    exact: expected ? ok.filter((r) => r.exact).length : 'set BENCH_EXPECTED_TEXT',
    medianMs: { connect: median('connectMs'), firstWord: median('firstWordMs'), commitAfterSpeech: median('commitAfterSpeech'), finalAfterSpeech: median('finalAfterSpeech') }
  }, null, 1));
  process.exit(0);
})();
