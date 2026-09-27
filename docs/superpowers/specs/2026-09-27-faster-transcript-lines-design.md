# Faster transcript lines — design

Date: 2026-09-27. Status: approved design, not yet implemented.

## Problem

Benchmarks of the fixed OpenAI realtime path (cue's own client, real API,
5 of 5 exact transcripts) show:

| Step | Median |
|---|---|
| Speaker starts → first live word | 1.12 s |
| Speaker stops → sentence closed (client commit) | 0.89 s |
| Speaker stops → final transcript line | 1.50 s |

The final line gates everything after it: the joined question, auto-answer
and the answer the user reads. Two client-side costs are inside that time:

- **Chunk size.** The audio worklet sends 4096 samples (256 ms) at a time, so
  every word waits up to 256 ms in the renderer before the main process sees
  it, and pause detection can only react on 256 ms boundaries.
- **Pause length.** A sentence closes after 600 ms of silence.

The main process spends about 0.2 ms of CPU per chunk (0.08% of a core per
channel), so smaller chunks cost nothing that matters.

## Decisions

| Topic | Decision |
|---|---|
| Chunk size | 960 samples (60 ms), exactly two 30 ms VAD frames |
| ScriptProcessor fallback | 1024 samples (its size must be a power of two) |
| Sentence close (OpenAI realtime) | 450 ms of silence (15 frames), from 600 ms |
| Scope | Transcript latency only |

Rejected:
- Smaller chunks only for streaming providers: adds branching for no gain,
  because batch, local Whisper and Deepgram accept any chunk size.
- Shortening the pause only: saves about 0.15 s and nothing on live words.
- Prompt changes: the answer system prompt is byte-identical across
  questions and OpenAI already caches 87–98% of its tokens.
- Freeing memory after pause: five listen/pause cycles settle at a flat
  ~410 MB (no leak); the one-off ~150 MB step is Chromium's capture service
  and GPU buffers.

## 1. Capture

`renderer/audio-worklet-processor.js`: `_bufferSize` 4096 → 960. The
worklet already flushes whenever the buffer fills, so nothing else changes.

`renderer/renderer.js`: both `createScriptProcessor(4096, 1, 1)` fallbacks
(mic and system audio) → `createScriptProcessor(1024, 1, 1)`.

IPC rises from about 4 to about 17 messages per second per channel.

## 2. VAD frame remainder

`src/vad.js` `AdaptiveVAD.processChunk` analyses whole 30 ms frames (480
samples) and silently drops the rest of each chunk: 256 of 4096 samples
today, 64 of 1024 with the fallback. It keeps the leftover bytes and
prepends them to the next chunk, so every sample is analysed once, whatever
the chunk size. `reset()` clears the leftover.

This VAD drives the speech indicator (main.js), the batch utterance
segmenter and the OpenAI commit, so all three become independent of chunk
size.

## 3. Sentence close

`src/stt-streaming.js`: `OPENAI_COMMIT_SILENCE_FRAMES` 20 → 15 (450 ms).
The 15 s longest-turn commit and the silence clear are unchanged.

## 4. Buffers measured in time, not chunks

Two "hold audio while connecting" buffers are counted in chunks and would
shrink with smaller chunks:

- OpenAI realtime `sendAudio`: 80 chunks, commented "5 seconds".
- Gemini Live: `GEMINI_LIVE_MAX_PENDING_CHUNKS = 100`, commented "~10s".

Both become byte budgets computed from 16 kHz 16-bit mono audio: 5 s
(160,000 bytes) and 10 s (320,000 bytes). The oldest chunks are dropped
first, as today.

## 5. Unchanged

Deepgram (sends each chunk as it comes), the batch transcriber and
utterance segmenter (time-based, via the VAD), local Whisper (`push`) and
the audio level log (counts whatever chunks arrive).

## Error handling

No new failure modes. The VAD leftover is at most one frame (959 bytes)
and is dropped on `reset()`, which main.js calls when listening stops.

## Testing

- Unit: VAD analyses a 1024-sample stream exactly like the same audio
  delivered in 480-sample frames (speech start/end at the same frame);
  `reset()` drops the leftover.
- Unit: OpenAI realtime commits after 450 ms of silence, not before.
- Unit: the connection buffers keep the newest 5 s / 10 s of audio for
  both 960-sample and 4096-sample chunks.
- Benchmark (scratch scripts, real API): rerun the transcription latency
  benchmark with 960-sample chunks. Targets: first live word ≤ 0.95 s,
  final line after speech ≤ 1.2 s, exact transcript 5 of 5. Rerun the
  audio-path benchmark: main-process CPU stays under 0.5% of a core per
  channel.
- Live app: transcript lines appear for mic and meeting audio, pause stops
  capture, the speech dot follows speech.

## Risk

A 450 ms pause closes more sentences at hesitations. The question joiner
merges consecutive interviewer lines within 20 s, so answers still see the
whole question; the visible effect is more, shorter lines in the history.

## Results

Measured with `scripts/dev/bench-audio-path.cjs` and
`scripts/dev/bench-transcription.cjs` (Windows TTS sentence, 5 trials, real
OpenAI API, medians).

| Build | Chunk | First live word* | Sentence closed | Final line | Audio path CPU / channel |
|---|---|---|---|---|---|
| Before (600 ms close) | 4096 samples | 1134 ms | 882 ms | 1505 ms | 0.072% |
| After (450 ms close) | 960 samples | 1319 ms | 486 ms | 1021 ms | 0.072% |

\* Counted from when the first chunk was sent; see the corrected comparison below.

The first-word column above counted from when the first chunk was sent,
which hides one chunk of capture time (256 ms before, 60 ms after) and made
the two builds incomparable. Counted from when the audio was captured, on
the same build:

| Chunk | First live word | Final line |
|---|---|---|
| 4096 samples | 1378 ms | 1240 ms |
| 960 samples | 1352 ms | 1097 ms |

First live words are bound by OpenAI's own delay (about 1.3–1.4 s); the gain
from smaller chunks is in the final line.
