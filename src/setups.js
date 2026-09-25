// Setups: saved preparation for one kind of conversation, plus a shared
// "About me". See docs/superpowers/specs/2026-09-24-setups-and-general-conversations-design.md.
// Pure functions over the settings object. store.js persists the result;
// prompt builders and main.js read the flat view from effectiveSettings(),
// which keeps interview prompts byte-identical to the single-profile days.

const { MAX_AI_RULES_CHARS } = require('./profile-context');

const BUILTIN_SETUP_ID = 'any';
const SETUPS_VERSION = 1;
const KINDS = ['interview', 'general'];
const ABOUT_ME_FIELDS = ['resumeText', 'stories', 'workStyle'];
const SETUP_TEXT_FIELDS = ['conversation', 'notes', 'whyCompany', 'whyLeaving', 'salaryTarget', 'questionsToAsk', 'instructions'];
const INTERVIEW_ONLY_FIELDS = ['whyCompany', 'whyLeaving', 'salaryTarget', 'questionsToAsk'];

// Old top-level fields and where they live now.
const LEGACY_ABOUT_ME = { resumeText: 'resumeText', starStories: 'stories', workStyle: 'workStyle' };
const LEGACY_SETUP = {
  jobDescription: 'conversation', knowledgeBase: 'notes', whyCompany: 'whyCompany',
  whyLeaving: 'whyLeaving', salaryTarget: 'salaryTarget', questionsToAsk: 'questionsToAsk'
};

const str = (value) => (typeof value === 'string' ? value : '');

function newSetupId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makeSetup({ id, name, kind = 'general', saveSessions } = {}) {
  const setup = { id: id || newSetupId(), name: name || 'New setup', kind: KINDS.includes(kind) ? kind : 'general' };
  for (const field of SETUP_TEXT_FIELDS) setup[field] = '';
  setup.saveSessions = typeof saveSessions === 'boolean' ? saveSessions : setup.kind === 'interview';
  return setup;
}

function builtinSetup() {
  return makeSetup({ id: BUILTIN_SETUP_ID, name: 'Any conversation', kind: 'general', saveSessions: false });
}

// Repairs whatever the file or the renderer handed over: known fields only,
// the built-in setup present and general, unique ids, a valid active setup.
function normalizeSetups(settings) {
  const out = { ...settings };
  const aboutMe = settings.aboutMe && typeof settings.aboutMe === 'object' ? settings.aboutMe : {};
  out.aboutMe = Object.fromEntries(ABOUT_ME_FIELDS.map((field) => [field, str(aboutMe[field])]));

  const setups = [];
  const ids = new Set();
  for (const raw of Array.isArray(settings.setups) ? settings.setups : []) {
    if (!raw || typeof raw !== 'object' || !str(raw.id) || ids.has(raw.id)) continue;
    const setup = makeSetup({ id: raw.id, name: str(raw.name).trim() || 'Untitled setup', kind: raw.kind, saveSessions: raw.saveSessions });
    for (const field of SETUP_TEXT_FIELDS) setup[field] = str(raw[field]);
    // The import and the Settings form cap this too; a hand-edited file may not.
    setup.instructions = setup.instructions.slice(0, MAX_AI_RULES_CHARS);
    ids.add(setup.id);
    setups.push(setup);
  }
  const builtinIndex = setups.findIndex((s) => s.id === BUILTIN_SETUP_ID);
  if (builtinIndex === -1) setups.unshift(builtinSetup());
  else setups[builtinIndex] = { ...setups[builtinIndex], name: 'Any conversation', kind: 'general' };

  out.setups = setups;
  out.activeSetupId = setups.some((s) => s.id === settings.activeSetupId) ? settings.activeSetupId : BUILTIN_SETUP_ID;
  return out;
}

// One-time move from the single-profile layout. Pure: store.js writes the result.
function migrateSettings(settings) {
  if (Number(settings && settings.setupsVersion) >= SETUPS_VERSION) {
    return { settings: normalizeSetups(settings), migrated: false };
  }
  const out = { ...settings };
  const aboutMe = {};
  for (const [from, to] of Object.entries(LEGACY_ABOUT_ME)) aboutMe[to] = str(settings[from]);

  const setups = [];
  const hasInterviewMaterial = Object.keys(LEGACY_SETUP).some((field) => str(settings[field]).trim());
  if (hasInterviewMaterial) {
    const setup = makeSetup({ id: 'interview', name: 'Interview', kind: 'interview', saveSessions: settings.saveSessions !== false });
    for (const [from, to] of Object.entries(LEGACY_SETUP)) setup[to] = str(settings[from]);
    // Rules written alongside the interview material belong to it.
    setup.instructions = str(settings.aiRules);
    out.aiRules = '';
    setups.push(setup);
    out.activeSetupId = setup.id;
  } else {
    out.activeSetupId = BUILTIN_SETUP_ID;
  }
  for (const field of [...Object.keys(LEGACY_ABOUT_ME), ...Object.keys(LEGACY_SETUP), 'saveSessions']) delete out[field];
  out.aboutMe = aboutMe;
  out.setups = setups;
  out.setupsVersion = SETUPS_VERSION;
  return { settings: normalizeSetups(out), migrated: true };
}

function activeSetup(settings) {
  const s = migrateSettings(settings || {}).settings;
  return s.setups.find((x) => x.id === s.activeSetupId) || s.setups.find((x) => x.id === BUILTIN_SETUP_ID);
}

// The flat view every consumer reads (prompts, speech vocabulary, warm-up,
// session saving). Works on a legacy file too, without writing it.
function effectiveSettings(settings) {
  const s = migrateSettings(settings || {}).settings;
  const setup = s.setups.find((x) => x.id === s.activeSetupId) || s.setups.find((x) => x.id === BUILTIN_SETUP_ID);
  const interview = setup.kind === 'interview';
  const pick = (field) => (interview || !INTERVIEW_ONLY_FIELDS.includes(field) ? setup[field] : '');
  return {
    ...s,
    resumeText: s.aboutMe.resumeText,
    starStories: s.aboutMe.stories,
    workStyle: s.aboutMe.workStyle,
    jobDescription: setup.conversation,
    knowledgeBase: setup.notes,
    whyCompany: pick('whyCompany'),
    whyLeaving: pick('whyLeaving'),
    salaryTarget: pick('salaryTarget'),
    questionsToAsk: pick('questionsToAsk'),
    aiRules: [setup.instructions.trim(), str(s.aiRules).trim()].filter(Boolean).join('\n\n'),
    saveSessions: !!setup.saveSessions,
    setupKind: setup.kind,
    setupName: setup.name,
    setupId: setup.id
  };
}

function updateSetup(settings, id, patch) {
  const s = migrateSettings(settings || {}).settings;
  if (!s.setups.some((x) => x.id === id)) return s.setups;
  return s.setups.map((x) => (x.id === id ? { ...x, ...patch, id: x.id } : { ...x }));
}

module.exports = {
  BUILTIN_SETUP_ID, SETUPS_VERSION, KINDS, ABOUT_ME_FIELDS, SETUP_TEXT_FIELDS, INTERVIEW_ONLY_FIELDS,
  makeSetup, normalizeSetups, migrateSettings, activeSetup, effectiveSettings, updateSetup
};
