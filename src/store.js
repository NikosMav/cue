// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { normalizeBaseUrl } = require('./openai-compatible');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

const { MAX_AI_RULES_CHARS } = require('./profile-context');

const DEFAULTS = {
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  // Meeting (system) audio. macOS has no way to capture system audio except through
  // a ScreenCaptureKit display-capture session, and the OS then shows its
  // screen-recording indicator in the menu bar and lists cue under Control Center's
  // "Currently Sharing" for the whole call -- inside the very frame the user is
  // screen-sharing. cue's promise is to be invisible, so on macOS this is opt-in;
  // on Windows/Linux loopback capture carries no such indicator, so it stays on.
  meetingAudio: process.platform !== 'darwin',
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '' , azure: '', publik: '' },
  azureEndpoint: '',
  // publik API (packaged-build default). apiKeys.publik holds the minted key;
  // everything here is state the main process owns — the renderer only reads
  // a redacted view of it through publik:state and can never write it.
  publik: {
    installId: '',            // uuid minted locally before the first provision; idempotency key server-side
    keyId: '',                // pk_live_<this>_… — safe to show
    baseUrl: '',              // '' = build default; the provisioning response's base_url wins
    claimUrl: '',             // where "Link this computer" goes until the install is claimed
    claimCode: '',
    claimState: '',           // 'anonymous' | 'claimed' — last seen from the gateway
    starterMicros: 0,         // granted at mint; shown as "$X of free starter usage"
    balanceMicros: null,      // last known available balance (headers or GET /wallet)
    balanceAt: 0,
    wallet: null,             // last GET /wallet, normalised (src/publik.js normalizeWallet)
    disclosureAccepted: 0,    // disclosureVersion the user accepted; 0 = not yet
    defaultApplied: false,    // provider was switched to publik once, automatically
    revoked: false,           // last call was 401 → Reconnect re-mints
    disconnected: false,      // 401 key_revoked with reprovision:false → user removed this computer
    cardShown: false,         // the first-run card (CONTRACT §12.1) was shown for the current starter grant
    lastError: ''
  },
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  knowledgeBase: '',     // Full interview reference; never clipped like resume sections.
  // Tab 3: Interview Prep
  starStories: '',       // 3-5 behavioral STAR stories in plain English
  whyCompany: '',        // Why do you want to work here?
  whyLeaving: '',        // Why are you leaving your current job?
  workStyle: '',         // How you work, decision-making style, values
  // Tab 4: Q&A
  salaryTarget: '',      // e.g. "$150k-$180k base + equity"
  questionsToAsk: '',    // Questions to ask the interviewer
  // Tab 5: Style — custom response rules
  // The user writes how the AI should write: e.g. "no em-dashes", "use bullet
  // points", "casual tone". Applied to every LLM mode EXCEPT LeetCode (kept
  // strict for coding problems).
  aiRules: '',
  answerLength: 'brief', // Spoken answers: brief, balanced, detailed.
  includeScreen: true,  // Assist/Ask can run with conversation only.
  autoAnswer: false,
  // Saved sessions (transcript + answers per interview), on by default and
  // switched off in the Sessions panel; sessionsExportDir optionally keeps a
  // Markdown copy of each.
  saveSessions: true,
  sessionsExportDir: '',
  practiceVoice: true,  // Read practice questions aloud with the system voice.
  // Global shortcut overrides by action id (src/shortcuts.js); '' clears one.
  // Written only through setShortcutOverrides so a reset can remove a key.
  shortcuts: {},    // Answer the interviewer's question as soon as they finish, without a key press.
  // Window position
  windowX: null,
  windowY: null,
  models: {
    openai: { fast: 'gpt-4.1-mini', smart: 'gpt-4.1' },
    // Kept in sync with CURRENT_ANTHROPIC_DEFAULT_FAST/_SMART in src/llm.js —
    // claude-3-5-haiku-latest/claude-3-5-sonnet-latest (the previous defaults
    // here) were retired by Anthropic and 404 on every request. This is the
    // block createLLM() actually reads by default (settings.models[provider],
    // not src/llm.js's DEFAULT_MODELS, which only backstops a missing entry) —
    // llm.js's DEAD_ANTHROPIC_MODEL_RE self-heal additionally migrates any
    // settings file already saved with the old dead ids.
    anthropic: { fast: 'claude-haiku-4-5', smart: 'claude-opus-5' },
    // Kept in sync with CURRENT_GEMINI_DEFAULT in src/llm.js — gemini-2.0-flash
    // (the previous default here) was retired by Google on 2026-03-03 and 404s
    // on every request. gemini-2.5-flash is current and free-tier available.
    // Same model for both tiers: Smart gives it a thinking budget (src/llm.js).
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    // Tier aliases, never upstream slugs; the provisioning response overrides them.
    publik: { fast: 'publik-fast', smart: 'publik-balanced' }
  }
};

// Fields the renderer may never write. settings:set passes patches through
// stripRendererPatch; settings:get hands out redactForRenderer's view.
const RENDERER_READ_ONLY = ['publik', 'shortcuts', 'settingsMeta', 'windowX', 'windowY'];

let data = null;
let hasSavedFile = false;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      if (k === 'aiRules' && typeof over[k] === 'string') {
        out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
      } else {
        out[k] = over[k];
      }
    }
  }
  return out;
}

function load() {
  // Read the current file: profile tools and another process may have changed it.
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings object');
    data = deepMerge(DEFAULTS, saved);
    hasSavedFile = true;
  } catch (error) {
    if (error.code === 'ENOENT' && !hasSavedFile) data = deepMerge(DEFAULTS, {});
    else throw new Error(`Cannot read Cue settings at ${FILE}. Existing settings were not replaced.`);
  }
  return data;
}
// 0600: the file holds every BYO key and now a publik key. A no-op on Windows.
function save() {
  const temporary = `${FILE}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, FILE);
    hasSavedFile = true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best effort for our temporary file */ }
    data = null;
    throw new Error(`Could not save Cue settings at ${FILE}. Your previous file was kept.`);
  }
}

function revision(settings) {
  const editable = stripRendererPatch(settings);
  delete editable.windowX;
  delete editable.windowY;
  return crypto.createHash('sha256').update(JSON.stringify(editable)).digest('hex');
}

function setRendererSettings(patch) {
  const current = load();
  if (patch.settingsMeta && patch.settingsMeta.revision !== revision(current)) {
    throw new Error('Settings changed outside this window. Click Reload saved settings before making further edits.');
  }
  return module.exports.setSettings(stripRendererPatch(patch));
}

// Called by main.js at launch, before the window exists. publik becomes the
// selected provider only where nothing works today: a build that carries an
// app token, a settings file that has never been switched automatically, and
// no key typed into the currently selected provider. A user who has ever
// pasted a key keeps exactly what they had.
function applyPublikDefault(build) {
  load();
  if (!build || !build.available || data.publik.defaultApplied) return false;
  const current = data.provider;
  const hasOwnKey = !!(data.apiKeys && data.apiKeys[current]);
  const hasCustomEndpoint = current === 'custom' && !!data.baseUrl;
  data.publik = { ...data.publik, defaultApplied: true };
  if (hasOwnKey || hasCustomEndpoint) { save(); return false; }
  data.provider = 'publik';
  save();
  return true;
}

function stripRendererPatch(patch) {
  const out = { ...(patch || {}) };
  for (const k of RENDERER_READ_ONLY) delete out[k];
  if (out.apiKeys && typeof out.apiKeys === 'object') { out.apiKeys = { ...out.apiKeys }; delete out.apiKeys.publik; }
  return out;
}

// What the renderer gets from settings:get: the same object minus the key.
function redactForRenderer(s) {
  return {
    ...s,
    settingsMeta: {
      file: FILE,
      revision: revision(s),
      keyProviders: Object.entries(s.apiKeys || {}).filter(([, value]) => typeof value === 'string' && value.trim()).map(([name]) => name)
    },
    apiKeys: { ...(s.apiKeys || {}), publik: '' },
    publik: { ...(s.publik || {}), connected: !!(s.apiKeys && s.apiKeys.publik) }
  };
}

module.exports = {
  MAX_AI_RULES_CHARS,
  RENDERER_READ_ONLY,
  applyPublikDefault,
  stripRendererPatch,
  redactForRenderer,
  setRendererSettings,
  settingsFile: FILE,
  getSettings() { return load(); },
  // Main-process only: the provisioning flow writes the key and its state here.
  setPublik(patch) {
    load();
    const { apiKey, ...rest } = patch || {};
    if (typeof apiKey === 'string') data.apiKeys = { ...data.apiKeys, publik: apiKey };
    data.publik = { ...data.publik, ...rest };
    save();
    return data;
  },
  // Replaces (not merges) the overrides, so resetting an action to its
  // default removes its key instead of pinning today's default.
  setShortcutOverrides(overrides) {
    load();
    data = { ...data, shortcuts: { ...(overrides || {}) } };
    save();
    return data;
  },
  setSettings(patch) {
    load();
    const nextSettings = deepMerge(data, patch || {});
    nextSettings.baseUrl = normalizeBaseUrl(nextSettings.baseUrl);
    data = nextSettings;
    save();
    return data;
  }
};
