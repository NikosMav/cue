// The spoken language of the conversation, one setting for every speech-to-text
// provider. Limited to languages every provider here can transcribe while
// streaming (Deepgram Nova-3 is the narrowest), so no choice fails to connect.

const STT_LANGUAGES = [
  ['auto', 'Auto-detect'],
  ['en', 'English'],
  ['el', 'Greek'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch']
];
const CODES = new Set(STT_LANGUAGES.map(([code]) => code));

/**
 * The language to transcribe. Before this setting existed, cloud providers
 * always used English and Local used its own language choice; an install that
 * never picked one keeps exactly that.
 */
function resolveSttLanguage(settings) {
  const s = settings || {};
  if (CODES.has(s.sttLanguage)) return s.sttLanguage;
  if ((s.sttProvider || 'auto') === 'local') {
    const local = s.localWhisper && s.localWhisper.language;
    return CODES.has(local) ? local : 'auto';
  }
  return 'en';
}

// OpenAI and Groq Whisper detect the language when none is sent.
function whisperLanguage(code) {
  return code && code !== 'auto' ? code : undefined;
}

// Deepgram streaming cannot detect a language; 'multi' transcribes a mix of
// its multilingual set (English and the main European languages) instead.
function deepgramLanguage(code) {
  return code && code !== 'auto' ? code : 'multi';
}

function languageName(code) {
  const found = STT_LANGUAGES.find(([c]) => c === code);
  return found && code !== 'auto' ? found[1] : '';
}

module.exports = { STT_LANGUAGES, resolveSttLanguage, whisperLanguage, deepgramLanguage, languageName };
