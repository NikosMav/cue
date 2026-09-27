const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

// Stand-in for the `ws` package that records what the client sends.
const sockets = [];
class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code) { this.readyState = 3; this.emit('close', code); }
  open() { this.readyState = 1; this.emit('open'); }
  serverEvent(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  sentTypes() { return this.sent.map((e) => e.type); }
}
const wsPath = require.resolve('ws');
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWebSocket };
const { OpenAIRealtimeSTT } = require('../src/stt-streaming');

// 100 ms of 16 kHz mono PCM: a loud tone for speech, zeros for silence.
function chunk(speech) {
  const buf = Buffer.alloc(3200);
  if (speech) for (let i = 0; i < 1600; i++) buf.writeInt16LE(Math.round(6000 * Math.sin(i / 3)), i * 2);
  return buf;
}

async function openSession(options = {}) {
  sockets.length = 0;
  const events = { finals: [], interims: [], errors: [] };
  const stt = new OpenAIRealtimeSTT('key', {
    onTranscript: (t) => events.finals.push(t),
    onInterim: (t) => events.interims.push(t),
    onError: (e) => events.errors.push(e),
    ...options
  });
  await stt.connect();
  const ws = sockets[0];
  ws.open();
  ws.serverEvent({ type: 'session.updated' });
  return { stt, ws, events };
}

test('OpenAI Realtime: interim text accumulates the streamed deltas', async () => {
  const { ws, events } = await openSession();
  for (const delta of [' Tell', ' me', ' about']) {
    ws.serverEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta });
  }
  assert.equal(events.interims.at(-1), 'Tell me about');
});

// gpt-realtime-whisper rejects server turn detection, so the server never
// closes an utterance by itself: without a client commit no transcript
// row is ever produced.
test('OpenAI Realtime: a pause after speech commits the audio so a final transcript arrives', async () => {
  const { stt, ws, events } = await openSession();
  for (let i = 0; i < 10; i++) stt.sendAudio(chunk(true));
  assert.ok(!ws.sentTypes().includes('input_audio_buffer.commit'), 'no commit while still speaking');
  for (let i = 0; i < 10; i++) stt.sendAudio(chunk(false));
  assert.equal(ws.sentTypes().filter((t) => t === 'input_audio_buffer.commit').length, 1);

  ws.serverEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' Hello' });
  ws.serverEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: ' Hello there.' });
  assert.deepEqual(events.finals, ['Hello there.']);
  assert.equal(events.interims.at(-1), '', 'interim clears once the utterance is final');

  for (let i = 0; i < 10; i++) stt.sendAudio(chunk(false));
  assert.equal(ws.sentTypes().filter((t) => t === 'input_audio_buffer.commit').length, 1, 'silence alone is never committed');
});

test('OpenAI Realtime: speech with no pause is still committed after the longest turn', async () => {
  const { stt, ws } = await openSession();
  ws.serverEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' So' });
  for (let i = 0; i < 200; i++) stt.sendAudio(chunk(true)); // 20 s without a pause
  assert.ok(ws.sentTypes().includes('input_audio_buffer.commit'));
});

test('OpenAI Realtime: a long silence is cleared, not committed as a turn', async () => {
  const { stt, ws } = await openSession();
  for (let i = 0; i < 200; i++) stt.sendAudio(chunk(false));
  assert.ok(!ws.sentTypes().includes('input_audio_buffer.commit'));
  assert.ok(ws.sentTypes().includes('input_audio_buffer.clear'));
});

test('OpenAI Realtime: an empty-buffer commit error does not stop streaming', async () => {
  const { ws, events } = await openSession();
  ws.serverEvent({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } });
  assert.deepEqual(events.errors, []);
});

test('OpenAI Realtime: words recognised before listening stops are kept', async () => {
  const { stt, ws, events } = await openSession();
  ws.serverEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' Almost' });
  ws.serverEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' done' });
  stt.disconnect();
  assert.deepEqual(events.finals, ['Almost done']);
});

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
