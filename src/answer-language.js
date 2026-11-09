// The language cue answers in (Settings → Style → Answer language). Every
// prompt is written with the English rule; applyAnswerLanguage swaps it for
// the chosen language, so English prompts stay byte-identical.

const { STT_LANGUAGES } = require('./stt-language');
const { USER_RULES_INTRO } = require('./profile-context');

const ANSWER_LANGUAGES = [
  ['en', 'English'],
  ['auto', 'Auto (same as the slides and the conversation)'],
  ...STT_LANGUAGES.filter(([code]) => code !== 'auto' && code !== 'en')
];
const CODES = new Set(ANSWER_LANGUAGES.map(([code]) => code));

// The English rules as the prompts have always worded them. prompts.js and
// presentation-prompts.js use these constants, so a swap always finds them.
const ENGLISH_RULE =
  'Always respond in clear, natural English. Never switch to Hindi or any other language unless the user explicitly asks for it. ';
const ENGLISH_RULE_PRESENTATION =
  'Always respond in clear, natural English. Never switch to any other language unless the user explicitly asks for it. ';

function resolveAnswerLanguage(settings) {
  const code = settings && settings.answerLanguage;
  return CODES.has(code) ? code : 'en';
}

// deck: writing slide scripts, where the "conversation" is only the setup's
// description, so the slides decide.
function languageRule(code, deck = false) {
  if (code === 'auto' && deck) {
    return 'Always write in the language the slides and speaker notes are written in, in clear, natural wording. ' +
      'Never switch to any other language unless the user explicitly asks for it. ';
  }
  if (code === 'auto') {
    return 'Always respond in the same language as the slides and the conversation: the language the deck and notes are written in and the people are speaking. ' +
      'If they differ, follow the conversation. Use clear, natural wording, and never switch to any other language unless the user explicitly asks for it. ';
  }
  const found = ANSWER_LANGUAGES.find(([c]) => c === code);
  return 'Always respond in clear, natural ' + found[1] + '. Never switch to any other language unless the user explicitly asks for it. ';
}

// The coding solver writes code in English whatever the answer language.
function codingRule(code) {
  const prose = code === 'auto'
    ? 'in the language of the problem on screen and the conversation'
    : 'in ' + ANSWER_LANGUAGES.find(([c]) => c === code)[1];
  return 'Write the prose (restatement, approach and complexity) ' + prose + '; keep the code, including its identifiers and comments, in English.';
}

// Before the user's own rules, so those still come last and can override it.
function insertRule(system, rule) {
  const at = system.lastIndexOf('\n\n' + USER_RULES_INTRO);
  const text = rule.trim();
  return at < 0 ? system + '\n\n' + text : system.slice(0, at) + '\n\n' + text + system.slice(at);
}

/**
 * The system prompt in the chosen answer language. English returns it
 * unchanged. Otherwise the English rule is replaced; a prompt without one
 * (follow-ups, recaps) gets the rule added, and a coding prompt gets a rule
 * that keeps its code in English.
 */
function applyAnswerLanguage(system, settings, { coding = false, deck = false } = {}) {
  const code = resolveAnswerLanguage(settings);
  if (code === 'en' || typeof system !== 'string') return system;
  if (coding) return insertRule(system, codingRule(code));
  const rule = languageRule(code, deck);
  if (system.includes(ENGLISH_RULE) || system.includes(ENGLISH_RULE_PRESENTATION)) {
    return system.split(ENGLISH_RULE).join(rule).split(ENGLISH_RULE_PRESENTATION).join(rule);
  }
  return insertRule(system, rule);
}

module.exports = {
  ANSWER_LANGUAGES, ENGLISH_RULE, ENGLISH_RULE_PRESENTATION,
  resolveAnswerLanguage, languageRule, applyAnswerLanguage
};
