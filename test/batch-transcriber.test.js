const test = require('node:test');
const assert = require('node:assert/strict');
const { BatchTranscriber } = require('../src/batch-transcriber');

// A 16 kHz mono PCM chunk: a tone loud enough for the VAD, or silence.
function pcm(ms, amplitude) {
  const samples = Math.floor(16000 * ms / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin(i / 3)), i * 2);
  return buf;
}
function feed(transcriber, channel, ms, amplitude) {
  for (let t = 0; t < ms; t += 30) transcriber.push(channel, pcm(30, amplitude));
}

test('speech is sent once per utterance, not once per second', async () => {
  const calls = [];
  const out = [];
  const t = new BatchTranscriber({
    transcribe: async (channel, audio) => { calls.push({ channel, ms: audio.length / 32 }); return 'hello there'; },
    onTranscript: (channel, text) => out.push([channel, text])
  });
  t.start();
  feed(t, 'them', 300, 0);       // leading silence
  feed(t, 'them', 3000, 6000);   // three seconds of continuous speech
  feed(t, 'them', 900, 0);       // pause long enough to end the utterance
  await t.drain();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].ms >= 3000, `utterance kept whole (${calls[0].ms}ms)`);
  assert.deepEqual(out, [['them', 'hello there']]);
});

test('silence alone never calls the provider', async () => {
  let calls = 0;
  const t = new BatchTranscriber({ transcribe: async () => { calls++; return 'x'; } });
  t.start();
  feed(t, 'you', 3000, 0);
  await t.drain();
  assert.equal(calls, 0);
});

test('each channel keeps its turns in spoken order even when requests finish out of order', async () => {
  const out = [];
  let n = 0;
  const t = new BatchTranscriber({
    transcribe: async () => {
      const id = ++n;
      await new Promise((resolve) => setTimeout(resolve, id === 1 ? 40 : 0));
      return 'turn ' + id;
    },
    onTranscript: (_channel, text) => out.push(text)
  });
  t.start();
  for (let i = 0; i < 2; i++) { feed(t, 'them', 600, 6000); feed(t, 'them', 900, 0); }
  await t.drain();
  assert.deepEqual(out, ['turn 1', 'turn 2']);
});

test('stop finishes the utterance in progress; later audio is ignored', async () => {
  const out = [];
  const t = new BatchTranscriber({ transcribe: async () => 'last words', onTranscript: (_c, text) => out.push(text) });
  t.start();
  feed(t, 'you', 1200, 6000);
  t.stop();
  feed(t, 'you', 1200, 6000);
  await t.drain();
  assert.deepEqual(out, ['last words']);
});

test('a failed request is reported and does not block the next utterance', async () => {
  const errors = [];
  const out = [];
  let n = 0;
  const t = new BatchTranscriber({
    transcribe: async () => { if (++n === 1) throw new Error('network'); return 'second'; },
    onTranscript: (_c, text) => out.push(text),
    onError: (error, channel) => errors.push([channel, error.message])
  });
  t.start();
  for (let i = 0; i < 2; i++) { feed(t, 'them', 600, 6000); feed(t, 'them', 900, 0); }
  await t.drain();
  assert.deepEqual(errors, [['them', 'network']]);
  assert.deepEqual(out, ['second']);
});

test('empty transcripts are not published', async () => {
  const out = [];
  const t = new BatchTranscriber({ transcribe: async () => '   ', onTranscript: (_c, text) => out.push(text) });
  t.start();
  feed(t, 'them', 600, 6000); feed(t, 'them', 900, 0);
  await t.drain();
  assert.deepEqual(out, []);
});
