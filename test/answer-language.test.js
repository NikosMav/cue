const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ANSWER_LANGUAGES, ENGLISH_RULE, ENGLISH_RULE_PRESENTATION, resolveAnswerLanguage, applyAnswerLanguage
} = require('../src/answer-language');
const { STT_LANGUAGES } = require('../src/stt-language');
const { buildPromptRequest, buildDebriefRequest, MODES } = require('../src/prompts');
const { buildEnrichRequest } = require('../src/presentation-prompts');

const at = (channel, text, ts) => ({ channel, text, ts });
const transcript = [at('them', 'Τι είναι ένα API;', 1000), at('you', 'Καλή ερώτηση.', 5000), at('them', 'Και πώς το καλούμε;', 9000)];
const answers = [{ mode: 'say', prompt: '', text: 'Ένα API είναι μια διεπαφή.', ts: 6000 }];
const LAYERS = [{}, { setupKind: 'general' }, { setupKind: 'presentation' }];
const SESSIONS = [
  { kind: 'interview', transcript, answers },
  { kind: 'practice', transcript, answers },
  { kind: 'interview', transcript: [], answers: [] }
];
const ENGLISH_TEXT = 'Always respond in clear, natural English';

// Every system prompt cue sends from text: each mode in each layer, every
// debrief, and the deck enrichment.
function allSystems(extra) {
  const out = [];
  for (const layer of LAYERS) {
    const settings = { answerLength: 'brief', aiRules: 'Keep it short.', ...layer, ...extra };
    for (const mode of Object.keys(MODES)) {
      const r = buildPromptRequest(settings, mode, transcript, 'Τι είναι REST;', { now: 20000, answers });
      out.push({ name: (layer.setupKind || 'interview') + ':' + r.mode, coding: !!MODES[r.mode].coding, request: r });
    }
    for (const session of SESSIONS) {
      out.push({ name: (layer.setupKind || 'interview') + ':debrief:' + session.kind, coding: false, request: buildDebriefRequest(settings, session) });
    }
  }
  const enrich = buildEnrichRequest({
    conversation: 'Εκπαιδευτικό βίντεο', notes: '', titles: ['Α'],
    batch: [{ n: 1, title: 'Α', body: 'x', notes: '', next: '' }],
    ...(extra.answerLanguage ? { answerLanguage: extra.answerLanguage } : {})
  });
  out.push({ name: 'enrich', coding: false, request: enrich });
  return out;
}

test('Answer language offers English, Auto and the speech languages, English first', () => {
  assert.deepEqual(ANSWER_LANGUAGES.slice(0, 2).map(([code]) => code), ['en', 'auto']);
  const speech = STT_LANGUAGES.map(([code]) => code).filter((c) => c !== 'auto' && c !== 'en');
  assert.deepEqual(ANSWER_LANGUAGES.slice(2).map(([code]) => code), speech);
  assert.ok(ANSWER_LANGUAGES.some(([code, name]) => code === 'el' && name === 'Greek'));
  assert.equal(resolveAnswerLanguage({}), 'en');
  assert.equal(resolveAnswerLanguage({ answerLanguage: 'xx' }), 'en');
  assert.equal(resolveAnswerLanguage({ answerLanguage: 'el' }), 'el');
  assert.equal(resolveAnswerLanguage({ answerLanguage: 'auto' }), 'auto');
});

test('English keeps every prompt exactly as before', () => {
  const unset = allSystems({});
  for (const value of ['en', 'unknown']) {
    const set = allSystems({ answerLanguage: value });
    assert.equal(set.length, unset.length);
    set.forEach((item, i) => assert.deepEqual(item.request, unset[i].request, item.name + ' (' + value + ')'));
  }
  // The exact English wording is still there.
  const byName = Object.fromEntries(unset.map((x) => [x.name, x.request.system]));
  assert.ok(byName['interview:assist'].includes(ENGLISH_RULE));
  assert.ok(byName['presentation:assist'].includes(ENGLISH_RULE));
  assert.ok(byName.enrich.includes(ENGLISH_RULE_PRESENTATION));
  assert.equal(applyAnswerLanguage('prompt', {}), 'prompt');
});

test('Greek replaces the English rule in every prompt that has one, and adds it where there was none', () => {
  const english = allSystems({});
  const greek = allSystems({ answerLanguage: 'el' });
  greek.forEach((item, i) => {
    const before = english[i].request.system;
    const after = item.request.system;
    assert.ok(!after.includes(ENGLISH_TEXT), item.name + ' still says English');
    if (item.coding) {
      assert.match(after, /Write the prose \(restatement, approach and complexity\) in Greek; keep the code, including its identifiers and comments, in English\./, item.name);
      assert.ok(after.startsWith(before), item.name + ': the coding prompt is only extended');
    } else {
      assert.ok(after.includes('Always respond in clear, natural Greek. Never switch to any other language unless the user explicitly asks for it.'), item.name);
    }
    // The reference block is still a cacheable prefix.
    assert.equal(item.request.cachePrefix, english[i].request.cachePrefix, item.name);
    if (item.request.cachePrefix) assert.ok(after.startsWith(item.request.cachePrefix), item.name);
  });
  // Assist, ask, recap, follow-ups, audience answers, enrichment and debriefs are all covered.
  const names = greek.map((x) => x.name);
  for (const n of ['interview:assist', 'interview:ask', 'interview:recap', 'interview:followup', 'presentation:answerThis',
    'presentation:recap', 'presentation:followup', 'presentation:debrief:interview', 'general:debrief:interview', 'interview:debrief:interview', 'enrich']) {
    assert.ok(names.includes(n), n);
  }
});

test('Auto answers in the language of the slides and the conversation', () => {
  for (const item of allSystems({ answerLanguage: 'auto' })) {
    const s = item.request.system;
    assert.ok(!s.includes(ENGLISH_TEXT), item.name);
    if (item.coding) assert.match(s, /in the language of the problem on screen and the conversation; keep the code, including its identifiers and comments, in English\./, item.name);
    else if (item.name === 'enrich') assert.match(s, /Always write in the language the slides and speaker notes are written in/);
    else assert.match(s, /Always respond in the same language as the slides and the conversation/, item.name);
  }
});

test('an added language rule sits before the user\'s own rules', () => {
  const settings = { setupKind: 'presentation', aiRules: 'Use short sentences.', answerLanguage: 'el' };
  for (const mode of ['followup', 'recap']) {
    const { system } = buildPromptRequest(settings, mode, transcript, '', { now: 20000 });
    const rule = system.indexOf('natural Greek');
    const rules = system.indexOf('--- USER RULES ---');
    assert.ok(rule > 0 && rules > rule, mode);
  }
  // Without user rules it closes the prompt.
  const { system } = buildPromptRequest({ answerLanguage: 'de' }, 'recap', transcript, '', { now: 20000 });
  assert.ok(system.trimEnd().endsWith('Never switch to any other language unless the user explicitly asks for it.'));
});

test('the coding solver keeps its code in English and ignores the user rules as before', () => {
  for (const mode of ['leetcode', 'codeFollowup']) {
    const en = buildPromptRequest({ aiRules: 'Be casual.' }, mode, [], 'faster?', { answers: [{ mode: 'leetcode', text: 'x' }] }).system;
    const el = buildPromptRequest({ aiRules: 'Be casual.', answerLanguage: 'el' }, mode, [], 'faster?', { answers: [{ mode: 'leetcode', text: 'x' }] }).system;
    assert.ok(el.startsWith(en), mode);
    assert.doesNotMatch(el, /Be casual/, mode);
    assert.match(el, /keep the code, including its identifiers and comments, in English/, mode);
  }
});

test('Auto writes slide scripts in the language of the slides, not of the setup description', () => {
  const { system } = buildEnrichRequest({ conversation: 'Training videos for new staff', notes: '', titles: ['Α'], batch: [{ n: 1, title: 'Α', body: 'x', notes: '' }], answerLanguage: 'auto' });
  assert.match(system, /Always write in the language the slides and speaker notes are written in/);
  assert.doesNotMatch(system, /follow the conversation/);
});

test('a profile import can set the answer language, and rejects an unknown one', () => {
  const { mergeProfile } = require('../src/profile-import');
  assert.equal(mergeProfile({}, { answerLanguage: 'el' }).answerLanguage, 'el');
  assert.throws(() => mergeProfile({}, { answerLanguage: 'klingon' }), /Invalid answer language/);
});

test('Greek scripts are trimmed at Greek question marks too, English trimming is unchanged', () => {
  const { parseEnrichResponse } = require('../src/presentation-prompts');
  const sentence = (i) => 'Ερώτηση νούμερο ' + i + ' για το μάθημα μας σήμερα εδώ;';
  const greek = Array.from({ length: 20 }, (_, i) => sentence(i)).join(' ');
  const reply = (script) => JSON.stringify([{ n: 1, script, points: ['p'], questions: [], keyIdea: 'k' }]);
  const [g] = parseEnrichResponse(reply(greek), [1], { scriptLength: 'short' });
  const words = g.script.split(/\s+/).length;
  assert.ok(words <= Math.round(80 * 1.15) && words > 40, String(words));
  assert.ok(g.script.endsWith(';'), 'cut after a whole question');
  const english = 'One two three; four five six. '.repeat(30).trim();
  const [e] = parseEnrichResponse(reply(english), [1], { scriptLength: 'short' });
  assert.ok(e.script.endsWith('six.'), 'a semicolon in English is not a sentence end');
});
