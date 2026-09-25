// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
//
// The durable-write mechanics (atomic temp+rename, .bak snapshot, 0600
// permissions) live in ./settings-store-core so they can be unit tested
// without Electron; this file owns the schema, defaults, the setups migration
// and the public surface (getSettings/setSettings/etc.).
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { createFileStore } = require('./settings-store-core');
const { normalizeBaseUrl } = require('./openai-compatible');
const { migrateSettings, SETUPS_VERSION } = require('./setups');

const fileStore = createFileStore(() => app.getPath('userData'), 'cue-data.json');
const FILE = fileStore.mainPath();

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
  apiKeys: { cerebras: '', openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '', deepseek: '', azure: '', publik: '' },
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
  // Prep material lives in aboutMe and setups (src/setups.js). They are not
  // defaulted here: a legacy file without setupsVersion must still migrate.
  // Tab 5: Style — custom response rules
  // The user writes how the AI should write: e.g. "no em-dashes", "use bullet
  // points", "casual tone". Applied to every LLM mode EXCEPT LeetCode (kept
  // strict for coding problems).
  aiRules: '',
  answerLength: 'brief', // Spoken answers: brief, balanced, detailed.
  includeScreen: true,  // Assist/Ask can run with conversation only.
  autoAnswer: false,
  warmUp: true,          // Prime the provider connection and prompt cache (main.js warmUpProvider).
  // Saved sessions (transcript + answers per interview), on by default and
  // switched off in the Sessions panel; sessionsExportDir optionally keeps a
  // Markdown copy of each.
  sessionsExportDir: '',
  practiceVoice: true,  // Read practice questions aloud with the system voice.
  // Global shortcut overrides by action id (src/shortcuts.js); '' clears one.
  // Written only through setShortcutOverrides so a reset can remove a key.
  shortcuts: {},    // Answer the interviewer's question as soon as they finish, without a key press.
  // Overlay opacity (1 = fully opaque). Clamped so the window never vanishes.
  opacity: 1,
  // Slides: opt-in auto slide tracking (memory-only, forwarded, never written to disk).
  slides: {
    enabled: false,
    intervalMs: 3000,
    threshold: 5,
    maxSlides: 50
  },
  // Per-caller consent for the app-link get_slides action, separate from the
  // link's coarse read/action scopes: a caller already trusted to start/stop
  // listening (scope "action") is NOT automatically trusted to read slide
  // captions too. Keyed by app-link caller id; value is 'granted' or 'denied'.
  applinkSlidesConsent: {},
  // Window position
  windowX: null,
  windowY: null,
  models: {
    cerebras: { fast: 'qwen-3.8-27b', smart: 'qwen-3.8-27b' },
    openai: { fast: 'gpt-4.1-mini', smart: 'gpt-4.1' },
    // Kept in sync with CURRENT_ANTHROPIC_DEFAULT_FAST/_SMART in src/llm.js —
    // claude-3-5-haiku-latest/claude-3-5-sonnet-latest (the previous defaults
    // here) were retired by Anthropic and 404 on every request. This is the
    // block createLLM() actually reads by default (settings.models[provider],
    // not src/llm.js's DEFAULT_MODELS, which only backstops a missing entry) —
    // llm.js's DEAD_ANTHROPIC_MODEL_RE self-heal additionally migrates any
    // settings file already saved with the old dead ids.
    anthropic: { fast: 'claude-haiku-4-5', smart: 'claude-opus-5' },
    // fast is kept in sync with CURRENT_GEMINI_DEFAULT in src/llm.js —
    // gemini-2.0-flash (the original default here) was retired by Google on
    // 2026-03-03 and 404s on every request. smart is the newest Pro release.
    gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.1-pro-preview' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    // deepseek-chat/deepseek-reasoner were retired 2026-07-24; deepseek-flash
    // (non-thinking) and deepseek-v4-pro (thinking) are the current aliases.
    deepseek: { fast: 'deepseek-flash', smart: 'deepseek-v4-pro' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    // Tier aliases, never upstream slugs; the provisioning response overrides them.
    publik: { fast: 'publik-fast', smart: 'publik-balanced' }
  }
};

// Fields the renderer may never write. settings:set passes patches through
// stripRendererPatch; settings:get hands out redactForRenderer's view.
const MIN_OPACITY = 0.2;
const MAX_OPACITY = 1;

function clampOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(n * 100) / 100));
}

const RENDERER_READ_ONLY = ['publik', 'shortcuts', 'settingsMeta', 'windowX', 'windowY', 'setupsVersion'];

let data = null;
let hasSavedFile = false;
let lastError = null;
// Set while the file on disk is still in the single-profile layout (or
// migrateFile failed) and migrateFile has not succeeded in this process.
// save() then keeps changes in memory only: writing the new layout without
// the backup migrateFile makes would lose the old file. The next launch retries.
let migrationBlocked = false;
let migrationDone = false;
let unsavedWhileBlocked = false;
let warnedBlocked = false;

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

function readSettingsFile(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings object');
  return saved;
}

// A crash mid-write or a lost file used to blank every key. The .bak that
// settings-store-core keeps from the previous save is put back in place; the
// unreadable file is kept in backups/ for inspection. Without a usable .bak
// nothing is replaced.
function recoverFromBackup(error) {
  let saved;
  try { saved = readSettingsFile(fileStore.bakPath()); }
  catch { throw new Error(`Cannot read Cue settings at ${FILE}. Existing settings were not replaced.`); }
  if (error.code !== 'ENOENT') {
    const backups = path.join(path.dirname(FILE), 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.copyFileSync(FILE, path.join(backups, `unreadable-${Date.now()}.json`));
  }
  fs.copyFileSync(fileStore.bakPath(), FILE);
  console.error(`[cue] ${FILE} was ${error.code === 'ENOENT' ? 'missing' : 'unreadable'}; restored the previous save from ${fileStore.bakPath()}`);
  return saved;
}

function load() {
  // Changes that could not be written are newer than the file.
  if (migrationBlocked && unsavedWhileBlocked && data) return data;
  // Read the current file: profile tools and another process may have changed it.
  let saved;
  try {
    saved = readSettingsFile(FILE);
  } catch (error) {
    if (error.code === 'ENOENT' && !hasSavedFile && !fs.existsSync(fileStore.bakPath())) {
      data = migrateSettings(deepMerge(DEFAULTS, {})).settings;
      return data;
    }
    saved = recoverFromBackup(error);
  }
  // Legacy single-profile files are read in the setups layout without being
  // rewritten; migrateFile() writes the new layout once, after a backup.
  // Another tool may have written the new layout (with its own backup) since.
  migrationBlocked = !(Number(saved.setupsVersion) >= SETUPS_VERSION) && !migrationDone;
  data = migrateSettings(deepMerge(DEFAULTS, saved)).settings;
  hasSavedFile = true;
  return data;
}

// Atomic temp+rename with a .bak of the previous save and 0600 permissions
// (settings-store-core.js). A failure throws so the user sees it; the file on
// disk keeps the previous save, and lastSaveError() keeps the cause.
function save() {
  if (migrationBlocked) {
    // Callers such as the window "moved" handler must not throw here.
    unsavedWhileBlocked = true;
    if (!warnedBlocked) {
      warnedBlocked = true;
      console.warn('[cue] settings not saved: migration to setups has not completed; changes apply until restart');
    }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fileStore.persist(data);
    hasSavedFile = true;
    lastError = null;
  } catch (error) {
    lastError = error;
    data = null;
    console.error('[cue] failed to save settings:', error && error.message);
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

// One-time move to setups (src/setups.js). Backs up the file first; a file
// that cannot be read or parsed is left exactly as it was.
// A failure leaves the file as it was and blocks later saves (see
// migrationBlocked) until a migrateFile call succeeds.
function migrateFile() {
  try {
    let raw;
    try { raw = fs.readFileSync(FILE, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const saved = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings object');
    if (Number(saved.setupsVersion) >= SETUPS_VERSION) return false;
    const backups = path.join(path.dirname(FILE), 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, `before-setups-${Date.now()}.json`), raw, { mode: 0o600, flag: 'wx' });
    data = migrateSettings(saved).settings;
    migrationBlocked = false;
    save();
    migrationDone = true;
    unsavedWhileBlocked = false;
    return true;
  } catch (error) {
    migrationBlocked = true;
    throw error;
  }
}

module.exports = {
  MAX_AI_RULES_CHARS,
  MIN_OPACITY,
  MAX_OPACITY,
  clampOpacity,
  RENDERER_READ_ONLY,
  applyPublikDefault,
  stripRendererPatch,
  redactForRenderer,
  setRendererSettings,
  migrateFile,
  settingsFile: FILE,
  getSettings() { return load(); },
  // True while save() is keeping changes in memory only (see migrationBlocked
  // above): the renderer/main process can use this to warn the user.
  migrationBlocked() { return migrationBlocked; },
  /** Null when the last save succeeded; the Error otherwise. */
  lastSaveError() { return lastError; },
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
    const nextSettings = migrateSettings(deepMerge(data, patch || {})).settings;
    nextSettings.baseUrl = normalizeBaseUrl(nextSettings.baseUrl);
    nextSettings.opacity = clampOpacity(nextSettings.opacity);
    data = nextSettings;
    save();
    return data;
  },
  // Per-caller consent for the app-link get_slides action — separate from the
  // link's own read/action scope grants (see src/applink.js). 'granted',
  // 'denied', or undefined if the caller has never been asked.
  getSlidesConsent(callerId) {
    load();
    return (data.applinkSlidesConsent || {})[callerId];
  },
  setSlidesConsent(callerId, decision) {
    load();
    data.applinkSlidesConsent = { ...(data.applinkSlidesConsent || {}), [callerId]: decision };
    save();
    return data.applinkSlidesConsent;
  },
  clearSlidesConsent(callerId) {
    load();
    if (!data.applinkSlidesConsent || !(callerId in data.applinkSlidesConsent)) return;
    const next = { ...data.applinkSlidesConsent };
    delete next[callerId];
    data.applinkSlidesConsent = next;
    save();
  }
};
