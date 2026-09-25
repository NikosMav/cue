// Imports a prep profile (JSON) into About me and one setup, keeping keys,
// models and every other setup as they are.
const { migrateSettings, makeSetup, BUILTIN_SETUP_ID, INTERVIEW_ONLY_FIELDS } = require('./setups');

const IMPORTED_INTERVIEW_NAME = 'Imported interview';

const GLOBAL_FIELDS = { answerLength: 'string', includeScreen: 'boolean', autoAnswer: 'boolean' };
// Profile key -> About me field. Old single-profile names are accepted.
const ABOUT_ME_KEYS = { resumeText: 'resumeText', starStories: 'stories', stories: 'stories', workStyle: 'workStyle' };
// Profile key -> setup field.
const SETUP_KEYS = {
  jobDescription: 'conversation', conversation: 'conversation', knowledgeBase: 'notes', notes: 'notes',
  whyCompany: 'whyCompany', whyLeaving: 'whyLeaving', salaryTarget: 'salaryTarget', questionsToAsk: 'questionsToAsk',
  aiRules: 'instructions', instructions: 'instructions'
};
const INTERVIEW_HINTS = ['jobDescription', 'whyCompany', 'whyLeaving', 'salaryTarget', 'questionsToAsk'];
const PROFILE_FIELDS = [...new Set([...Object.keys(GLOBAL_FIELDS), ...Object.keys(ABOUT_ME_KEYS), ...Object.keys(SETUP_KEYS), 'kind'])];

function mergeProfile(settings, profile, { setupName, warnings } = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Profile must be a JSON object.');
  const next = migrateSettings(settings || {}).settings;

  for (const [key, type] of Object.entries(GLOBAL_FIELDS)) {
    if (!Object.hasOwn(profile, key)) continue;
    if (typeof profile[key] !== type) throw new Error(`Invalid profile field: ${key}`);
    next[key] = profile[key];
  }
  if (next.answerLength && !['brief', 'balanced', 'detailed'].includes(next.answerLength)) throw new Error('Invalid answer length.');

  next.aboutMe = { ...next.aboutMe };
  for (const [key, field] of Object.entries(ABOUT_ME_KEYS)) {
    if (!Object.hasOwn(profile, key)) continue;
    if (typeof profile[key] !== 'string') throw new Error(`Invalid profile field: ${key}`);
    next.aboutMe[field] = profile[key];
  }

  const setupPatch = {};
  for (const [key, field] of Object.entries(SETUP_KEYS)) {
    if (!Object.hasOwn(profile, key)) continue;
    if (typeof profile[key] !== 'string') throw new Error(`Invalid profile field: ${key}`);
    setupPatch[field] = profile[key];
  }
  if ((setupPatch.instructions || '').length > 2000) throw new Error('Setup instructions exceed 2000 characters.');

  if (Object.keys(setupPatch).length || setupName) {
    const kind = ['interview', 'general'].includes(profile.kind) ? profile.kind
      : INTERVIEW_HINTS.some((k) => Object.hasOwn(profile, k)) ? 'interview' : 'general';
    let name = (setupName || '').trim();
    // Interview material never goes into the built-in "Any conversation"
    // setup: it lands in (or updates) a setup of its own.
    if (!name && next.activeSetupId === BUILTIN_SETUP_ID && kind === 'interview') name = IMPORTED_INTERVIEW_NAME;
    let setup = name
      ? next.setups.find((s) => s.name.toLowerCase() === name.toLowerCase())
      : next.setups.find((s) => s.id === next.activeSetupId);
    if (!setup) {
      setup = makeSetup({ name: name || 'Imported setup', kind });
      next.setups = [...next.setups, setup];
    }
    // Importing without --setup into an active general setup that isn't the
    // built-in one silently writes interview-only fields where effectiveSettings
    // hides them (see settingsForSession / effectiveSettings). Warn instead of
    // failing the import.
    if (!setupName && setup.kind === 'general' && setup.id !== BUILTIN_SETUP_ID &&
        INTERVIEW_ONLY_FIELDS.some((field) => Object.hasOwn(profile, field)) && Array.isArray(warnings)) {
      warnings.push(`Interview-only fields were imported into the general setup "${setup.name}", where they are not used. Use --setup to import into an interview setup.`);
    }
    next.setups = next.setups.map((s) => (s.id === setup.id ? { ...s, ...setupPatch } : s));
    next.activeSetupId = setup.id;
  }
  return migrateSettings(next).settings;
}

module.exports = { PROFILE_FIELDS, mergeProfile };
