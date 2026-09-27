# Faster Transcript Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the time from a speaker stopping to their transcript line appearing from about 1.5 s to about 1.1 s, and first live words from about 1.1 s to about 0.9 s.

**Architecture:** The renderer's capture worklet sends 60 ms chunks instead of 256 ms ones. The main-process VAD (`src/vad.js`) carries partial frames between chunks so its result no longer depends on chunk size. The OpenAI realtime client closes a sentence after 450 ms of silence instead of 600 ms. The two "hold audio while connecting" buffers are sized in seconds instead of chunks. Two benchmark scripts in `scripts/dev/` measure the result before and after.

**Tech Stack:** Electron 33, plain Node/JS, `node:test`, `ws`. No new dependencies.

Spec: `docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md`.

## Global Constraints

- Chunk size: 960 samples (60 ms at 16 kHz), exactly two 30 ms VAD frames. ScriptProcessor fallback: 1024 samples.
- OpenAI realtime sentence close: 450 ms of silence, `OPENAI_COMMIT_SILENCE_FRAMES = 15`. The 15 s longest-turn commit and the silence clear stay as they are.
- Connection buffers: OpenAI realtime keeps the newest 5 s (160,000 bytes), Gemini Live the newest 10 s (320,000 bytes) of 16 kHz 16-bit mono audio.
- Benchmark targets (real API, 960-sample chunks): first live word ≤ 0.95 s, final line after speech ≤ 1.2 s, 5 of 5 exact transcripts; main-process audio path under 0.5% of a core per channel.
- No UI animations may be added (all were removed in d33caca).
- Never print API keys or the settings file. Benchmarks read the key from cue's settings file, resolved through `src/config-path.js`.
- No new npm dependencies. Tests: `npm test` (runs `node --test test/*.test.js`).
- Close any running cue before `npm test`: `test/applink.test.js` fails with `EADDRINUSE` while cue holds its named pipe. PowerShell: `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -match 'GitHub\\cue' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The working tree uses CRLF line endings (`core.autocrlf=true`); keep edited files CRLF.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/dev/bench-audio-path.cjs` (new) | Offline benchmark: main-process CPU per audio chunk |
| `scripts/dev/bench-transcription.cjs` (new) | Real-API benchmark: live-word and final-line latency |
| `src/vad.js` | Carry partial frames between chunks; `reset()` drops them |
| `src/stt-streaming.js` | Time-sized connection buffers; 450 ms sentence close |
| `renderer/audio-worklet-processor.js` | 960-sample chunks |
| `renderer/renderer.js` | 1024-sample ScriptProcessor fallbacks |
| `test/vad.test.js`, `test/audio-worklet.test.js` (new) | Tests |
| `test/stt-openai-realtime.test.js`, `test/stt-gemini-live.test.js` | New tests for buffers and the 450 ms close |
| `docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md` | Results section (before/after numbers) |
| `docs/fork-changes.md` | Record today's fixes and this change |

---

### Task 1: Benchmark scripts and baseline

**Files:**
- Create: `scripts/dev/bench-audio-path.cjs`
- Create: `scripts/dev/bench-transcription.cjs`
- Modify: `docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md` (append a Results section)

**Interfaces:**
- Produces:
  - `node scripts/dev/bench-audio-path.cjs [--chunk-samples N]` prints JSON `{ chunkSamples, chunkMs, usPerChunk: { mean, p50, p95, p99, max }, cpuPctOfOneCorePerChannel, uploadKbpsPerChannel }`.
  - `node scripts/dev/bench-transcription.cjs <speech.wav> [--trials N] [--chunk-samples N]` prints one line per trial, then JSON `{ chunkSamples, trials, ok, exact, medianMs: { connect, firstWord, commitAfterSpeech, finalAfterSpeech } }`. Set `BENCH_EXPECTED_TEXT` to count exact transcripts.

- [ ] **Step 1: Write `scripts/dev/bench-audio-path.cjs`**

```js
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
```

- [ ] **Step 2: Write `scripts/dev/bench-transcription.cjs`**

```js
// Transcription latency through cue's OpenAI realtime client against the real
// API, paced like the app. Per trial:
//   connectMs          socket opened -> session ready
//   firstWordMs        first audio sent -> first live word
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
      speechStart = Date.now();
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
```

- [ ] **Step 3: Create the speech sample (Windows TTS, not committed)**

Run in PowerShell:

```powershell
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile("$env:TEMP\cue-bench-speech.wav", $fmt)
$s.Speak("Tell me about a time you debugged a difficult problem in production.")
$s.Dispose()
```

Expected: `%TEMP%\cue-bench-speech.wav` exists (about 138 KB).

- [ ] **Step 4: Run the baseline on the current code (4096-sample chunks, 600 ms close)**

```bash
node scripts/dev/bench-audio-path.cjs --chunk-samples 4096
BENCH_EXPECTED_TEXT="Tell me about a time you debugged a difficult problem in production." node scripts/dev/bench-transcription.cjs "$TEMP/cue-bench-speech.wav" --trials 5 --chunk-samples 4096
```

Expected, roughly (measured 2026-09-27): audio path ~0.2 ms per chunk, ~0.08% of a core; transcription `ok: 5`, `exact: 5`, `firstWord` ~1120, `commitAfterSpeech` ~890, `finalAfterSpeech` ~1500.

- [ ] **Step 5: Record the baseline in the spec**

Append to `docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md`, using the numbers you measured:

```markdown
## Results

Measured with `scripts/dev/bench-audio-path.cjs` and
`scripts/dev/bench-transcription.cjs` (Windows TTS sentence, 5 trials, real
OpenAI API, medians).

| Build | Chunk | First live word | Sentence closed | Final line | Audio path CPU / channel |
|---|---|---|---|---|---|
| Before (600 ms close) | 4096 samples | <firstWord> ms | <commitAfterSpeech> ms | <finalAfterSpeech> ms | <cpuPctOfOneCorePerChannel>% |
```

Replace each `<…>` with the measured value before committing.

- [ ] **Step 6: Commit**

```bash
git add scripts/dev/bench-audio-path.cjs scripts/dev/bench-transcription.cjs docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md
git commit -m "chore: benchmarks for the audio path and transcription latency" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: VAD analyses every sample, whatever the chunk size

**Files:**
- Modify: `src/vad.js` (`constructor`, `processChunk`, `reset`)
- Create: `test/vad.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AdaptiveVAD#processChunk(pcmBuffer: Buffer)` analyses every 30 ms frame of the concatenated stream exactly once; up to 959 bytes are kept for the next call. `AdaptiveVAD#reset()` also drops that leftover. Public API unchanged.

- [ ] **Step 1: Write the failing tests** in `test/vad.test.js`

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/vad.test.js`
Expected: FAIL. The first test reports different frame counts for 1024 and 4096 (for example 107 instead of 115). The second counts 3 frames instead of 2, or passes by accident; the first failure is enough.

- [ ] **Step 3: Implement the leftover in `src/vad.js`**

In the constructor, directly under `// State machine` and its three counters, add:

```js
    this._leftover = Buffer.alloc(0); // samples short of a whole frame, analysed with the next chunk
```

Replace the whole `processChunk` method with:

```js
  // Process a chunk of Int16 PCM audio. Samples that do not fill a whole frame
  // are kept and analysed with the next chunk, so the result does not depend
  // on how the audio is chunked.
  processChunk(pcmBuffer) {
    const frameBytes = this.frameSize * 2;
    const buf = this._leftover.length ? Buffer.concat([this._leftover, pcmBuffer]) : pcmBuffer;
    let offset = 0;
    while (offset + frameBytes <= buf.length) {
      this._processFrame(this._computeRMS(buf.subarray(offset, offset + frameBytes)));
      offset += frameBytes;
    }
    this._leftover = Buffer.from(buf.subarray(offset)); // a copy: callers may reuse their buffer
  }
```

In `reset()`, after `this.noiseFloor = 80;`, add:

```js
    this._leftover = Buffer.alloc(0);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/vad.test.js test/utterance-segmenter.test.js test/batch-transcriber.test.js test/stt-openai-realtime.test.js`
Expected: all pass (the segmenter, batch transcriber and realtime client use this VAD).

- [ ] **Step 5: Commit**

```bash
git add src/vad.js test/vad.test.js
git commit -m "fix: the VAD analyses every sample, whatever the chunk size" -m "processChunk dropped the samples that did not fill a whole 30 ms frame: 256 of every 4096, about 6% of the audio, so speech detection depended on how the renderer chunked it. The remainder now carries over to the next chunk, and reset() drops it." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Connection buffers sized in seconds

**Files:**
- Modify: `src/stt-streaming.js` (constants near the top, `OpenAIRealtimeSTT#sendAudio`, `GEMINI_LIVE_MAX_PENDING_CHUNKS`, `GeminiLiveSTT#sendAudio`)
- Test: `test/stt-openai-realtime.test.js`, `test/stt-gemini-live.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (module-internal): `PCM_BYTES_PER_SECOND = 32000`; `queueBounded(queue: Array<Buffer|ArrayBuffer>, chunk, maxBytes: number): void` pushes `chunk`, then drops the oldest entries while the total `byteLength` exceeds `maxBytes` (always keeping the newest); `OPENAI_MAX_PENDING_BYTES = 5 * PCM_BYTES_PER_SECOND`; `GEMINI_LIVE_MAX_PENDING_BYTES = 10 * PCM_BYTES_PER_SECOND` (replaces `GEMINI_LIVE_MAX_PENDING_CHUNKS`).

- [ ] **Step 1: Write the failing OpenAI test**

Append to `test/stt-openai-realtime.test.js`:

```js
test('OpenAI Realtime: audio sent while connecting keeps the newest 5 s, whatever the chunk size', async () => {
  for (const samples of [960, 4096]) {
    sockets.length = 0;
    const stt = new OpenAIRealtimeSTT('key', {});
    await stt.connect();
    const bytes = samples * 2;
    const total = Math.ceil((8 * 32000) / bytes); // 8 s spoken before the session is ready
    for (let i = 0; i < total; i++) stt.sendAudio(Buffer.alloc(bytes, i % 256));
    const ws = sockets[0];
    ws.open();
    ws.serverEvent({ type: 'session.updated' });
    const appended = ws.sent.filter((e) => e.type === 'input_audio_buffer.append').map((e) => Buffer.from(e.audio, 'base64'));
    const sourceBytes = (appended.reduce((n, b) => n + b.length, 0) * 2) / 3; // 16 -> 24 kHz is exactly 3/2 here
    assert.ok(sourceBytes <= 5 * 32000 && sourceBytes > 5 * 32000 - bytes, `${samples}-sample chunks kept ${sourceBytes} bytes`);
    assert.equal(appended.at(-1).readInt16LE(0), Buffer.alloc(2, (total - 1) % 256).readInt16LE(0), 'the newest audio is kept');
    stt.disconnect();
  }
});
```

- [ ] **Step 2: Write the failing Gemini Live test**

Append to `test/stt-gemini-live.test.js`:

```js
test('audio buffered while connecting keeps the newest 10 s, whatever the chunk size', async () => {
  for (const samples of [960, 4096]) {
    const { stt, genai } = make('ok');
    const bytes = samples * 2;
    const total = Math.ceil((14 * 32000) / bytes); // 14 s before the session is up
    for (let i = 0; i < total; i++) stt.sendAudio(Buffer.alloc(bytes, i % 256));
    await stt.connect();
    const sent = genai.sessions[0].sent.filter((s) => s.audio).map((s) => Buffer.from(s.audio.data, 'base64'));
    const sentBytes = sent.reduce((n, b) => n + b.length, 0);
    assert.ok(sentBytes <= 10 * 32000 && sentBytes > 10 * 32000 - bytes, `${samples}-sample chunks kept ${sentBytes} bytes`);
    assert.equal(sent.at(-1)[0], (total - 1) % 256, 'the newest audio is kept');
    stt.disconnect();
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/stt-openai-realtime.test.js test/stt-gemini-live.test.js`
Expected: the two new tests FAIL. OpenAI keeps 80 chunks (153,600 bytes with 960-sample chunks, 655,360 with 4096). Gemini keeps 100 chunks (192,000 bytes with 960-sample chunks).

- [ ] **Step 4: Implement in `src/stt-streaming.js`**

Directly after the `OPENAI_MAX_TURN_MS` line near the top, add:

```js

// 16 kHz, 16-bit mono: what the renderer captures and every provider is sent.
const PCM_BYTES_PER_SECOND = 32000;
const OPENAI_MAX_PENDING_BYTES = 5 * PCM_BYTES_PER_SECOND;

// Holds audio while a socket (re)connects, dropping the oldest chunks beyond
// maxBytes. Sized in time, not chunks, so it does not depend on chunk size.
function queueBounded(queue, chunk, maxBytes) {
  queue.push(chunk);
  let bytes = 0;
  for (const c of queue) bytes += c.byteLength;
  while (bytes > maxBytes && queue.length > 1) bytes -= queue.shift().byteLength;
}
```

In `OpenAIRealtimeSTT#sendAudio`, replace:

```js
      // Buffer audio until session is ready (max 5 seconds worth)
      this._pendingAudio.push(pcmBuffer);
      if (this._pendingAudio.length > 80) this._pendingAudio.shift();
      return;
```

with:

```js
      // Buffer audio until the session is ready (the newest 5 s)
      queueBounded(this._pendingAudio, pcmBuffer, OPENAI_MAX_PENDING_BYTES);
      return;
```

Replace:

```js
const GEMINI_LIVE_MAX_PENDING_CHUNKS = 100; // ~10s of 100ms chunks while (re)connecting
```

with:

```js
const GEMINI_LIVE_MAX_PENDING_BYTES = 10 * PCM_BYTES_PER_SECOND; // the newest 10 s while (re)connecting
```

In `GeminiLiveSTT#sendAudio`, replace:

```js
      this._pendingAudio.push(Buffer.from(pcmBuffer));
      if (this._pendingAudio.length > GEMINI_LIVE_MAX_PENDING_CHUNKS) this._pendingAudio.shift();
      return;
```

with:

```js
      queueBounded(this._pendingAudio, Buffer.from(pcmBuffer), GEMINI_LIVE_MAX_PENDING_BYTES);
      return;
```

Check that nothing else still uses the old name: `grep -n "GEMINI_LIVE_MAX_PENDING_CHUNKS\|length > 80" src/stt-streaming.js` prints nothing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/stt-openai-realtime.test.js test/stt-gemini-live.test.js test/stt-streaming-disconnect.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/stt-streaming.js test/stt-openai-realtime.test.js test/stt-gemini-live.test.js
git commit -m "fix: audio held while connecting is sized in seconds, not chunks" -m "OpenAI realtime kept 80 chunks and Gemini Live 100 while a socket (re)connected, sized for 64 ms and 100 ms chunks. Both now keep the newest 5 s and 10 s of audio whatever the chunk size, ahead of the move to 60 ms chunks." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 60 ms chunks and a 450 ms sentence close

**Files:**
- Modify: `renderer/audio-worklet-processor.js:8`
- Modify: `renderer/renderer.js` (the two `createScriptProcessor(4096, 1, 1)` calls, around lines 724 and 822)
- Modify: `src/stt-streaming.js` (`OPENAI_COMMIT_SILENCE_FRAMES`)
- Create: `test/audio-worklet.test.js`
- Test: `test/stt-openai-realtime.test.js`

**Interfaces:**
- Consumes: Task 2 (the VAD is chunk-size independent) and Task 3 (time-sized buffers).
- Produces: the renderer posts 960-sample Int16 chunks on `mic:pcm` / `system:pcm` (1024 with the ScriptProcessor fallback); OpenAI realtime commits after 15 silent 30 ms frames.

- [ ] **Step 1: Write the failing worklet tests** in `test/audio-worklet.test.js`

```js
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
```

- [ ] **Step 2: Write the failing sentence-close test**

Append to `test/stt-openai-realtime.test.js`:

```js
// 60 ms of 16 kHz mono PCM, as the capture worklet sends it.
function chunk60(speech) {
  const buf = Buffer.alloc(1920);
  if (speech) for (let i = 0; i < 960; i++) buf.writeInt16LE(Math.round(6000 * Math.sin(i / 3)), i * 2);
  return buf;
}

test('OpenAI Realtime: a sentence closes after 450 ms of silence, not before', async () => {
  const { stt, ws } = await openSession();
  for (let i = 0; i < 10; i++) stt.sendAudio(chunk60(true));
  for (let i = 0; i < 7; i++) stt.sendAudio(chunk60(false)); // 420 ms of silence
  assert.ok(!ws.sentTypes().includes('input_audio_buffer.commit'), 'still inside the pause');
  stt.sendAudio(chunk60(false)); // 480 ms: past 450 ms
  assert.equal(ws.sentTypes().filter((t) => t === 'input_audio_buffer.commit').length, 1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/audio-worklet.test.js test/stt-openai-realtime.test.js`
Expected: FAIL. The worklet posts nothing (4096 samples not reached), the fallbacks are `[4096, 4096]`, and no commit is sent at 480 ms (600 ms needed).

- [ ] **Step 4: Implement**

`renderer/audio-worklet-processor.js`, replace:

```js
    this._bufferSize = 4096; // accumulate before sending (matches old ScriptProcessor)
```

with:

```js
    this._bufferSize = 960; // 60 ms at 16 kHz: two 30 ms VAD frames, so words and pauses reach the main process quickly
```

`renderer/renderer.js`: change both `createScriptProcessor(4096, 1, 1)` calls (mic, around line 724, and system audio, around line 822) to `createScriptProcessor(1024, 1, 1)`.

`src/stt-streaming.js`, replace:

```js
const OPENAI_COMMIT_SILENCE_FRAMES = 20; // 30 ms frames: 600 ms
```

with:

```js
const OPENAI_COMMIT_SILENCE_FRAMES = 15; // 30 ms frames: 450 ms
```

- [ ] **Step 5: Run the full suite**

Close any running cue first (see Global Constraints), then run: `npm test`
Expected: all tests pass (447 before this plan, plus 7 new: 2 VAD, 2 buffer, 2 worklet, 1 sentence close).

- [ ] **Step 6: Commit**

```bash
git add renderer/audio-worklet-processor.js renderer/renderer.js src/stt-streaming.js test/audio-worklet.test.js test/stt-openai-realtime.test.js
git commit -m "perf: 60 ms audio chunks and a 450 ms sentence close" -m "The capture worklet sent 256 ms of audio at a time, so every word and every pause waited in the renderer before transcription saw it, and OpenAI realtime closed a sentence only after 600 ms of silence. Chunks are now 60 ms (1024 samples with the ScriptProcessor fallback) and a sentence closes after 450 ms." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Measure, check the live app, document

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md` (Results table)
- Modify: `docs/fork-changes.md`

**Interfaces:**
- Consumes: the scripts from Task 1 and the behaviour from Tasks 2–4.
- Produces: documentation only.

- [ ] **Step 1: Benchmark the new build**

```bash
node scripts/dev/bench-audio-path.cjs --chunk-samples 960
BENCH_EXPECTED_TEXT="Tell me about a time you debugged a difficult problem in production." node scripts/dev/bench-transcription.cjs "$TEMP/cue-bench-speech.wav" --trials 5 --chunk-samples 960
```

Expected: `cpuPctOfOneCorePerChannel` < 0.5; `ok: 5`, `exact: 5`, `firstWord` ≤ 950, `finalAfterSpeech` ≤ 1200. If a target is missed, stop and report the numbers instead of tuning constants.

- [ ] **Step 2: Add the "After" row to the Results table in the spec**

```markdown
| After (450 ms close) | 960 samples | <firstWord> ms | <commitAfterSpeech> ms | <finalAfterSpeech> ms | <cpuPctOfOneCorePerChannel>% |
```

Replace each `<…>` with the measured value.

- [ ] **Step 3: Check the live app**

Close any running cue, then start it from the repo with `npm start`. Press the listen button and say a sentence, pause, and say another. Expected:
- each sentence appears as a transcript line in the history about a second after you stop;
- the live dot turns bright green while you speak;
- the pause button stops listening at once (dot grey, "not listening").

If you are an agent without a microphone, ask the user to do this check and report back what they saw.

- [ ] **Step 4: Update `docs/fork-changes.md`**

In the "Cleanup" bullet, delete `` `rms16`, `` from the list (it was restored).

At the end of the `## Changes` list (after the "Setups" bullet, before `## Validation and limits`), add:

```markdown
- Listening works again after the 2026-09-25 upstream sync: the merged audio
  level log called `rms16`, which the fork had removed, so every audio chunk
  threw in the main process and Electron's error dialog (hidden behind the
  overlay) froze it — no transcript, an unresponsive listen button and a
  laggy window. `rms16` is back in `src/wav.js`, with a test that `main.js`
  imports only what `src/wav.js` exports.
- OpenAI realtime transcription (`gpt-realtime-whisper`) rejects server turn
  detection, so cue closes each sentence itself: its VAD commits the audio
  after a 450 ms pause, or after 15 s of speech without one; long silences are
  cleared instead of transcribed. The live line shows the whole sentence so
  far, and words already heard are kept when listening stops.
- No UI animations. Every running animation repainted the whole glass window,
  blur included, at the display refresh rate (35–50% of a core on the GPU
  process while listening); state is shown by colour instead.
- Audio reaches the main process in 60 ms chunks instead of 256 ms, and the
  VAD carries partial frames between chunks, so live words and final lines
  arrive sooner. `scripts/dev/bench-audio-path.cjs` and
  `scripts/dev/bench-transcription.cjs` measure both; results are in
  `docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-faster-transcript-lines-design.md docs/fork-changes.md
git commit -m "docs: faster transcript lines results; record the listening fixes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
