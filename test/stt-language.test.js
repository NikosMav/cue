const test = require('node:test');
const assert = require('node:assert/strict');
const { STT_LANGUAGES, resolveSttLanguage, whisperLanguage, deepgramLanguage, languageName } = require('../src/stt-language');
const { createStreamingSTT } = require('../src/stt-streaming');
const { transcribeGeminiWith } = require('../src/stt');

const cb = { onTranscript() {}, onInterim() {}, onError() {}, onStatusChange() {} };

test('an install that never chose a language keeps its old behaviour', () => {
  assert.equal(resolveSttLanguage({}), 'en', 'cloud providers were always English');
  assert.equal(resolveSttLanguage({ sttProvider: 'deepgram' }), 'en');
  assert.equal(resolveSttLanguage({ sttProvider: 'local', localWhisper: { language: 'auto' } }), 'auto');
  assert.equal(resolveSttLanguage({ sttProvider: 'local', localWhisper: { language: 'en' } }), 'en');
  assert.equal(resolveSttLanguage({ sttProvider: 'local' }), 'auto');
});

test('a chosen language applies to every provider; unknown values fall back', () => {
  for (const provider of ['auto', 'openai', 'deepgram', 'local', 'groq']) {
    assert.equal(resolveSttLanguage({ sttProvider: provider, sttLanguage: 'el' }), 'el', provider);
  }
  assert.equal(resolveSttLanguage({ sttLanguage: 'xx' }), 'en');
  assert.ok(STT_LANGUAGES.some(([code]) => code === 'el'));
});

test('auto-detect maps to each provider\'s own way of detecting', () => {
  assert.equal(whisperLanguage('auto'), undefined, 'Whisper detects when no language is sent');
  assert.equal(whisperLanguage('el'), 'el');
  assert.equal(deepgramLanguage('auto'), 'multi', 'Deepgram streaming has no detection; multi is its mixed mode');
  assert.equal(deepgramLanguage('el'), 'el');
  assert.equal(languageName('el'), 'Greek');
  assert.equal(languageName('auto'), '');
});

test('streaming providers are created with the chosen language', () => {
  const deepgram = createStreamingSTT({ sttProvider: 'deepgram', sttLanguage: 'el', apiKeys: { deepgram: 'd' } }, 'them', cb);
  assert.equal(deepgram.instance.language, 'el');
  const openai = createStreamingSTT({ sttProvider: 'openai', sttLanguage: 'auto', apiKeys: { openai: 'o' } }, 'them', cb);
  assert.equal(openai.instance.language, undefined, 'auto sends no language to OpenAI Realtime');
  const legacy = createStreamingSTT({ sttProvider: 'openai', apiKeys: { openai: 'o' } }, 'them', cb);
  assert.equal(legacy.instance.language, 'en');
});

test('batch Gemini gets the chosen language as a hint, and none on auto-detect', async () => {
  const calls = [];
  const ai = { models: { generateContent: async (req) => { calls.push(req); return { candidates: [{ content: { parts: [{ audioTranscription: { text: 'γεια' } }] } }] }; } } };
  const wav = Buffer.from('RIFF');
  assert.equal(await transcribeGeminiWith(ai, wav, 10 ** 13, 'el'), 'γεια');
  assert.match(calls[0].contents[0].parts[0].text, /The speech is in Greek/);
  await transcribeGeminiWith(ai, wav, 10 ** 13, 'auto');
  assert.deepEqual(calls[1].contents[0].parts.map((p) => Object.keys(p)[0]), ['inlineData']);
});
