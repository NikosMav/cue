const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences, clipboard, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Resolve before any module captures userData (settings, sessions or models).
require('./src/config-path').configureUserData(app, __dirname);
if (!app.requestSingleInstanceLock()) app.exit(0);
const store = require('./src/store');
const { captureScreenshot, pickSource } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM } = require('./src/llm');
const { MODES, buildPromptRequest, buildDebriefRequest, splitDebrief } = require('./src/prompts');
const { SessionStore, SessionRecorder, presentationBlock, sessionToMarkdown, exportFileName, isValidId, summarize, writeFileAtomic, planResume, QUIT_WHILE_LISTENING, RESUME_WINDOW_MS } = require('./src/sessions');
const { streamWithWatchdog } = require('./src/stream-watchdog');
const { detectConsoleSession } = require('./src/windows-session');
const { createWarmUp } = require('./src/warmup');
const { createClickThrough, placeOnDisplay, clampToArea } = require('./src/click-through');
const { effectiveSettings, settingsForSession, updateSetup } = require('./src/setups');
const { DeckStore } = require('./src/deck-store');
const { importDeck, enrichDeck, appendQuestions, validQuestionItems, countQuestions } = require('./src/deck-import');
const { MAX_FILE_BYTES, DeckError } = require('./src/deck-extract');
const { deckOutline, slideContext } = require('./src/deck-relevance');
const { createPresentationRuntime, deckChanged } = require('./src/presentation-runtime');
const { buildCoverageRequest, parseCoverageResponse, coverageInput } = require('./src/presentation-prompts');

// Settings as every feature reads them: About me + the active setup projected
// onto the flat prep fields (src/setups.js).
function currentSettings() {
  return effectiveSettings(store.getSettings());
}
const { createStreamingSTT } = require('./src/stt-streaming');
const { resolveSttLanguage } = require('./src/stt-language');
const { BatchTranscriber } = require('./src/batch-transcriber');
const { AutoAnswer } = require('./src/auto-answer');
const { currentQuestion } = require('./src/interview-context');
const { ACTIONS: SHORTCUT_ACTIONS, resolveShortcuts, findConflicts, isValid: isValidAccelerator } = require('./src/shortcuts');
const { AdaptiveVAD } = require('./src/vad');
const { rms16 } = require('./src/wav');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');
const { isSystemSettingsUrl } = require('./src/system-settings-url');
const publik = require('./src/publik');
// The app token release.yml baked into src/publik-build.json (empty in a dev
// checkout → the publik option is simply absent from the provider picker).
const publikBuild = publik.loadBuildConfig();
const {
  hashRGBA,
  dhashRGBA,
  shouldEmitSlide,
  createSlideStore,
  clampSlidesConfig,
  presentationSlidesConfig,
  buildSlideSystem,
  buildSlideUser,
  DEFAULT_STABLE_REQUIRED
} = require('./src/slides');

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}

// Linux Wayland / Ozone native rendering configuration. Without this, Electron
// falls back to XWayland even on a native Wayland session; 'auto' picks Wayland
// when available and X11 otherwise. Harmless no-op on X11-only sessions.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');

let win = null;
let clickThrough = null; // decides where the overlay takes the mouse (src/click-through.js)
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
let shortcutState = {};   // action id → registered
// action id → { accelerator, status: 'ok' | 'taken' | 'conflict' | 'invalid' | 'unset' | 'inactive' }
let shortcutStatus = {};
let shortcutsSuspended = false; // while Settings records a new key combination
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

// WDA_EXCLUDEFROMCAPTURE (win.setContentProtection(true)) is documented to
// exclude a window's content from third-party capture surfaces (BitBlt,
// PrintWindow, DXGI Desktop Duplication, screen recording / screen share)
// WITHOUT touching the live composited image on an ordinary, physically
// scanned-out desktop session — the user still sees the window fine. But on
// a Windows session whose own visible surface is ITSELF a remoted or
// composited pipeline — a Remote Desktop (RDP) connection, a Windows 365 /
// Cloud PC session, most VM consoles, a CI runner's virtual desktop — the
// same flag has been observed to make the window render nothing at all, to
// the user as much as to any capture tool (see
// cue-windows-overlay-not-visible-for-mic-grant: PrintWindow(PW_RENDERFULLCONTENT)
// sampled zero color variance, and a full-desktop screenshot showed the
// always-on-top window occluding nothing, only ever reproduced with
// protection on and never with it off). Windows names the locally-attached
// interactive session exactly "Console"; every remoted session gets a
// different name (e.g. "RDP-Tcp#3"). The name is read from Windows for this
// process (src/windows-session.js), not from the SESSIONNAME variable alone,
// which launchers can drop or leave stale. Anything other than a confirmed
// local console session is treated as unsafe to protect: a window the user
// can see (even if a screen-share viewer also could) is strictly better than
// a window that is invisible to everyone, including the user trying to grant
// it microphone access. Resolved once in app.whenReady(), before any window.
let winSession = { local: !isWindows, sessionName: '', source: isWindows ? 'unknown' : 'platform' };

let permWin = null;
// Windows never blocks startup on an unresolved permission (see app.whenReady()
// below), so launchApp() can already have run once by the time the user grants
// access and clicks Continue in the gate window (permissions:continue also
// calls launchApp()). Without this guard the second call re-creates the main
// BrowserWindow (createWindow() has no existing-window check), re-registers
// global shortcuts and re-starts the applink server -- a real, reachable
// regression, not a hypothetical.
let appLaunched = false;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
// Speech-to-text emits many short lines (a 38-minute call produced about 600),
// so this holds a long call in full. Prompts take what they need by length.
const MAX_TRANSCRIPT_TURNS = 2000;
// -------- slides state (memory-only, never written to disk) --------
let slideStore = createSlideStore({ maxSlides: 50 });
let slideTimer = null;
let slideLastHash = null;
let slideStableCount = 0;
let slideBusy = false;
let slideDisabled = false; // set when the chat key rejects slide captions (stops cost spam)
let slideTxCursor = 0; // transcript.length at last emitted slide
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
let batchTranscriber = null;
// The one answer being generated. A newer request cancels it instead of
// being dropped, so a new interview question never waits on an old answer.
let activeRequest = null;   // { id, mode, text, auto, startedAt, controller }
let requestSeq = 0;
const REPEAT_GUARD_MS = 400; // a held-down shortcut or double click is one request
let lastManualRequestAt = 0;
// Completed answers this session, oldest first: { mode, prompt, text, ts }.
// Lets follow-ups ("tell me more about that", "optimize it") see what cue said.
const sessionAnswers = [];
const MAX_SESSION_ANSWERS = 20;
// Screenshots queued for the coding solver (a problem longer than one screen).
let screenshotQueue = [];
const MAX_QUEUED_SCREENSHOTS = 4;
// Saved sessions (created at launch, once the user-data path is known).
let sessionStore = null;
// A conversation cue was recording when it stopped, put back at launch; sent to the renderer once it loads.
let resumedConversation = null;
let sessionRecorder = null;
// Practice mode: cue asks the questions and the mic carries the answers.
const practice = { active: false, speaking: false, quietUntil: 0 };
// The mic can pick up cue's spoken question from the speakers; ignore it
// while the voice plays and briefly after.
const PRACTICE_ECHO_GUARD_MS = 600;
const autoAnswer = new AutoAnswer({
  isEnabled: () => !!store.getSettings().autoAnswer && state.capturing && !practice.active,
  getTranscript: () => transcript,
  onFire: (question) => {
    // The user already asked about this question by hand: leave their answer.
    const lastThem = [...transcript].reverse().find((t) => t.channel === 'them');
    if (lastThem && lastManualRequestAt >= lastThem.ts) return;
    runFeature('answerThis', question, { auto: true });
  }
});
let batchStt = { settings: null, stt: null };
let whisperModelManager = null;
let localWhisperTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
  if (sessionRecorder) sessionRecorder.addTurn(turn);
  // The pacing clock starts at the first slide match or the first line spoken.
  if (presentationRuntime) presentationRuntime.noteTranscript();
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text) {
  if (!text || !text.trim()) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
  autoAnswer.noteFinal(channel, turn.text);
}

// Voice activity from the utterance segmenters (batch and local modes).
function publishSpeechState(channel, speaking, durationMs) {
  send('vad:state', { channel, speaking, durationMs });
  autoAnswer.noteSpeech(channel, speaking);
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : resolveSttLanguage(settings),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: publishSpeechState,
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
function saveWindowPosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  store.setSettings({ windowX: x, windowY: y });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  // Restore onto the monitor the position was saved on (or the nearest one if
  // it is gone), not clamped to the primary display.
  if (Number.isFinite(savedSettings.windowX) && Number.isFinite(savedSettings.windowY)) {
    const placed = placeOnDisplay({ x: savedSettings.windowX, y: savedSettings.windowY }, { width: W, height: H }, screen.getAllDisplays());
    startX = placed.x;
    startY = placed.y;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX,
    y: startY,
    // The window is shown inactive and never takes focus, so without this macOS spends the
    // first click only activating it and a press on the drag handle does nothing.
    acceptFirstMouse: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: process.env.CUE_VISIBLE_TEST !== '1',
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows && process.env.CUE_VISIBLE_TEST !== '1') {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);
  // Created on a monitor whose scale differs from the primary's, the window
  // comes out scaled a second time (1052x900 instead of 700x600 on a 150%
  // laptop next to a 100% monitor). Applying the bounds once more fixes it.
  win.setBounds({ x: startX, y: startY, width: W, height: H });

  // Fix 2: Only call setContentProtection if the OS supports it, and only on
  // a session where it will not blank the window out for the user themself
  // (see winSession above — RDP/VM/Cloud-PC-style sessions
  // render a WDA_EXCLUDEFROMCAPTURE window fully invisible, not just hidden
  // from capture). On older builds, or a non-local-console Windows session,
  // we skip it silently and send a warning to the renderer instead.
  const shouldProtect = !process.env.CUE_NO_PROTECT && winSession.local;
  if (shouldProtect) {
    if (isLinux) {
      // setContentProtection has no effect on Linux (no windowing-system-level
      // capture-exclusion primitive it can map to) — skip the no-op call and
      // say so, rather than pretending the window is hidden from screen shares.
      console.log('[cue] Running on Linux: native screen protection (setContentProtection) is not supported and has been skipped.');
    } else if (WIN_SUPPORTS_CONTENT_PROTECTION) {
      win.setContentProtection(true);
    } else {
      // Will notify the renderer after it loads
      console.log(`[cue] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
    }
  } else if (isWindows && !winSession.local && !process.env.CUE_NO_PROTECT) {
    console.log(`[cue] Windows session is not a local console session (session=${winSession.sessionName || 'unknown'}, from ${winSession.source}) — skipping setContentProtection so the window stays visible to you. Window may appear in screen shares.`);
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  // Click-through follows the cursor, polled here rather than inferred from
  // mouse events Windows forwards unreliably (see src/click-through.js).
  if (clickThrough) clickThrough.stop();
  clickThrough = createClickThrough({
    getCursor: () => screen.getCursorScreenPoint(),
    getBounds: () => win.getBounds(),
    isActive: () => !!win && !win.isDestroyed() && win.isVisible() && process.env.CUE_VISIBLE_TEST !== '1',
    setIgnore: (ignore) => win.setIgnoreMouseEvents(ignore, { forward: true })
  });
  win.setIgnoreMouseEvents(process.env.CUE_VISIBLE_TEST !== '1', { forward: true });
  clickThrough.start();
  win.on('closed', () => { if (clickThrough) clickThrough.stop(); });
  // Closing the window quits cue, so it asks first while listening too.
  win.on('close', (e) => { if (!mayQuitNow()) e.preventDefault(); });
  // Windows is shutting down or signing out: never hold that up with a dialog.
  win.on('session-end', () => { quitConfirmed = true; });

  // Dragging onto a monitor with a different scale factor briefly resizes the
  // window (to 467x401 when entering a 150% screen) and can leave it a pixel
  // off. The overlay has one size: restore it once the move ends.
  win.on('moved', () => {
    const b = win.getBounds();
    if (b.width !== W || b.height !== H) win.setBounds({ x: b.x, y: b.y, width: W, height: H });
  });
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(saveWindowPosition, 500);
  });

  win.setTitle('Cue'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('Cue');
    if (resumedConversation) {
      const { turns, updatedAt, setupName, quitWhileListening } = resumedConversation;
      resumedConversation = null;
      send('transcript:restore', { turns });
      const minutes = Math.max(1, Math.round((Date.now() - updatedAt) / 60000));
      const why = quitWhileListening ? 'cue was quit while listening' : 'cue stopped unexpectedly';
      send('status', { message: `${why}. Resumed your ${setupName ? setupName + ' ' : ''}conversation from ${minutes} min ago (${turns.length} turns). Clear starts a new one.` });
    }
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
    // Warn when protection was skipped because this is not a local console
    // session (RDP / Cloud PC / VM console) — see winSession.
    if (isWindows && !process.env.CUE_NO_PROTECT && !winSession.local) {
      send('status', {
        message: 'Heads up: screen-share hiding is off for this session (remote desktop / cloud PC / VM sessions can render the window invisible to you as well when it is on). The window will be visible in screen shares here.'
      });
    }
    // The setups migration didn't complete (see store.js migrationBlocked):
    // save() is keeping changes in memory only until cue restarts.
    if (store.migrationBlocked()) {
      send('status', {
        message: 'Settings could not be updated to the new setups layout, so changes are kept only until cue restarts. Your previous settings file is unchanged.'
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- batch STT (cloud providers without a streaming protocol) --------
// Reuse one STT client per settings snapshot so its quota cooldown persists
// between utterances, while a key changed in Settings takes effect at once
// (store.setSettings replaces the settings object).
function currentBatchSTT() {
  const settings = currentSettings();
  if (batchStt.settings !== settings) batchStt = { settings, stt: createSTT(settings) };
  return batchStt;
}

async function transcribeUtterance(channel, pcm) {
  const { settings, stt } = currentBatchSTT();
  if (!stt.available) {
    if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
    return '';
  }
  state.transcribing[channel] = true;
  try {
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return '';
    }
    const text = (res.text || '').trim();
    return text.length > 1 && !/^[?!.,;:\-…]+$/.test(text) ? text : '';
  } finally {
    state.transcribing[channel] = false;
  }
}

function startBatchTranscription() {
  if (batchTranscriber) return;
  batchTranscriber = new BatchTranscriber({
    transcribe: transcribeUtterance,
    onTranscript: publishTranscript,
    onSpeechState: publishSpeechState,
    onError: (e, channel) => {
      console.log('[stt] error', e && e.message);
      recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'transcribeUtterance', context: { channel } });
    }
  });
  batchTranscriber.start();
}

function stopBatchTranscription() {
  if (!batchTranscriber) return;
  // Speech already captured is still transcribed after listening stops.
  batchTranscriber.stop();
  batchTranscriber = null;
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

// -------- streaming STT setup --------
function initStreamingSTT() {
  // Vocabulary (Deepgram keyterms) comes from the active setup and is fixed
  // when listening starts; a setup switch applies from the next start.
  const settings = currentSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    let instance = null; // set below; lets the callbacks tell a stale instance from the live one
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        if (instance && streamingSTT[ch] !== instance) return; // stale instance after a stop/start
        publishTranscript(ch, text);
      },
      onInterim: (ch, text) => {
        if (instance && streamingSTT[ch] !== instance) return;
        send('stt:interim', { channel: ch, text });
        autoAnswer.noteInterim(ch, text);
      },
      onError: (err) => {
        // A socket torn down by a quick stop/start can still report an error a
        // moment later; acting on it would kill the sessions that replaced it
        // and start the batch loop alongside them (double transcription).
        if (instance && streamingSTT[channel] !== instance) return;
        console.log('[streaming-stt] error', err.provider, err.message);
        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          if (state.capturing) startBatchTranscription();
        } else if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      instance = sttInstance.instance;
      streamingMode = true;
      streamingSTT[channel] = instance;
      instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- slides: auto tracking (opt-in, memory-only) --------
// Cheap hash poll (32px thumbnail) every intervalMs; full-res VLM caption only
// on stable change. Never blocks runFeature (own slideBusy flag). Images are
// never stored — only hash + caption + transcript window.
function getSlidesConfig() {
  return clampSlidesConfig(store.getSettings().slides || {});
}

// Presentation frames use a larger sample for the 256-bit difference hash.
async function captureHashFrame({ displayId, width = 32, height = 32 } = {}) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  });
  const src = pickSource(sources, displayId, String(screen.getPrimaryDisplay().id));
  if (!src) return null;
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const bmp = img.toBitmap();
  if (!bmp || !size.width || !size.height) return null;
  return { width: size.width, height: size.height, data: bmp };
}

async function captionSlide(imageDataUrl, transcriptSlice) {
  const settings = store.getSettings();
  const llm = createLLM(settings);
  if (!llm.ready) throw new Error(llm.configurationError || 'Complete the provider settings.');
  let watchdog = null;
  const stalled = new Promise((_res, reject) => {
    watchdog = setTimeout(() => reject(new Error('slide caption timed out')), STREAM_INACTIVITY_MS);
  });
  try {
    return await Promise.race([
      llm.stream({
        system: buildSlideSystem(),
        turns: [{ role: 'user', text: buildSlideUser(transcriptSlice) }],
        imageDataUrl,
        maxTokens: 300,
        onToken: () => {}
      }),
      stalled
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

async function pollSlides() {
  if (state.capturing && presentationRuntime) return pollPresentation();
  if (!state.capturing || slideBusy || slideDisabled) return;
  const cfg = getSlidesConfig();
  if (!cfg.enabled) return;
  if (slideStore.count() >= cfg.maxSlides) return;
  let frame = null;
  try {
    frame = await captureHashFrame();
  } catch {
    return;
  }
  if (!frame) return;
  const newHash = hashRGBA(frame.width, frame.height, frame.data);
  if (!newHash) return;
  const decision = shouldEmitSlide(slideLastHash, newHash, {
    threshold: cfg.threshold,
    stableCount: slideStableCount,
    requiredStable: DEFAULT_STABLE_REQUIRED
  });
  slideStableCount = decision.stableCount;
  if (!decision.emit) {
    if (slideLastHash && decision.distance != null && decision.distance <= cfg.threshold) slideLastHash = slideLastHash;
    return;
  }
  slideLastHash = newHash;
  slideStableCount = decision.stableCount;
  // Stable change: take one full-res frame and caption it.
  slideBusy = true;
  try {
    const imageDataUrl = await captureScreenshot();
    if (!imageDataUrl) return;
    const txStart = slideTxCursor;
    const txEnd = transcript.length;
    const slice = transcript.slice(txStart, txEnd).slice(-8);
    const caption = (await captionSlide(imageDataUrl, slice) || '').trim();
    if (!caption) return;
    const slide = slideStore.add({ hash: newHash, caption, txStart, txEnd });
    slideTxCursor = txEnd;
    send('slides:update', { count: slideStore.count(), last: slide });
    recordEvent({ level: 'info', event: 'slide_captured', msg: 'slide ' + slideStore.count() + ' captioned' });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/429|quota|401|403|model_not_found/i.test(msg)) {
      slideDisabled = true;
      send('status', { message: 'Slide captions paused: ' + msg });
    } else {
      console.log('[slides] caption failed', msg);
    }
  } finally {
    slideBusy = false;
  }
}

function startSlideLoop() {
  stopSlideLoop();
  const cfg = presentationRuntime ? presentationSlidesConfig() : getSlidesConfig();
  slideTimer = setInterval(() => { pollSlides().catch(() => {}); }, cfg.intervalMs);
  if (slideTimer.unref) slideTimer.unref();
  if (presentationRuntime) {
    presentationTick = setInterval(sendPresentationUpdate, 1000);
    if (presentationTick.unref) presentationTick.unref();
    sendPresentationUpdate();
  }
}

function stopSlideLoop() {
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
  if (presentationTick) { clearInterval(presentationTick); presentationTick = null; }
}

// -------- presentation: live slide tracking --------
// In a presentation setup a stable screen change is matched to a deck slide
// (src/presentation-runtime.js) instead of captioned; nothing goes to slideStore.
// presentationRuntime = { deck, state, matcher, ... } | null.
let presentationRuntime = null;
let presentationTick = null;
let presentationPollBusy = false; // a slow capture must not overlap the next 1 s poll
let matchCacheTimer = null;
const MATCH_CACHE_SAVE_MS = 2000;

function sendPresentationUpdate() {
  if (presentationRuntime) send('presentation:update', presentationRuntime.update());
}

// Mirrors the talk's timeline, coverage and skips into the saved session.
// Called on slide changes and coverage results, not on the 1 s tick.
function recordPresentationSession() {
  const rt = presentationRuntime;
  if (!rt || !sessionRecorder) return;
  sessionRecorder.setPresentation(presentationBlock({
    deck: rt.deck,
    snapshot: rt.state.snapshot(),
    coverage: rt.coverage,
    durationMin: currentSettings().durationMin
  }));
}

// Writes the runtime's new cache entries into the latest deck on disk, so
// enrichment and slide edits saved meanwhile are kept.
function flushMatchCache() {
  clearTimeout(matchCacheTimer);
  matchCacheTimer = null;
  const rt = presentationRuntime;
  if (!rt || !rt.file) return;
  const writes = rt.takeCacheWrites();
  if (!Object.keys(writes).length) return;
  try {
    const latest = deckStore().load(rt.file);
    if (!latest || deckChanged(latest, rt.deck)) return;
    deckStore().save(rt.file, { ...latest, matchCache: { ...latest.matchCache, ...writes } });
  } catch (e) {
    console.error('[presentation] match cache save failed', e);
  }
}

function scheduleMatchCacheSave() {
  clearTimeout(matchCacheTimer);
  matchCacheTimer = setTimeout(flushMatchCache, MATCH_CACHE_SAVE_MS);
  if (matchCacheTimer.unref) matchCacheTimer.unref();
}

// One slide-identification call on the fast model, with the stall watchdog.
async function identifyCallLLM(request) {
  const llm = createLLM({ ...currentSettings(), smart: false });
  if (!llm.ready) throw new Error(llm.configurationError || 'Complete the provider settings.');
  return streamWithWatchdog(params => llm.stream(params), {
    system: request.system,
    turns: request.turns,
    imageDataUrl: request.imageDataUrl,
    maxTokens: request.maxTokens,
    effort: request.effort,
    onToken: () => {}
  }, STREAM_INACTIVITY_MS);
}

// Fire-and-forget: did the presenter's own speech cover the slide they just left?
// Runs COVERAGE_GRACE_MS after leaving, so speech-to-text has finalised what
// was said on the slide. Failures are silent; a result for a replaced runtime
// is dropped.
const COVERAGE_GRACE_MS = 3000;
function checkCoverage(rt, left) {
  if (!left) return;
  const timer = setTimeout(() => runCoverageCheck(rt, left), COVERAGE_GRACE_MS);
  if (timer.unref) timer.unref();
}

function runCoverageCheck(rt, left) {
  if (presentationRuntime !== rt) return;
  const slides = (rt.deck && rt.deck.slides) || [];
  const input = coverageInput({ left, slide: slides.find(s => s.n === left.n) || null, transcript, graceMs: COVERAGE_GRACE_MS });
  if (!input) return;
  (async () => {
    const llm = createLLM({ ...currentSettings(), smart: false });
    if (!llm.ready) throw new Error(llm.configurationError || 'provider not ready');
    const text = await streamWithWatchdog(params => llm.stream(params), {
      ...buildCoverageRequest(input),
      onToken: () => {}
    }, STREAM_INACTIVITY_MS);
    if (presentationRuntime !== rt) return;
    const result = parseCoverageResponse(text);
    if (!result) return;
    rt.recordCoverage(left.n, result); // also sets or clears the slide's flag
    sendPresentationUpdate();
    recordPresentationSession();
  })().catch(e => console.log('[presentation] coverage check failed', (e && e.message) || e));
}

// Builds (or refreshes) the runtime for the active setup. Another setup,
// another deck (slide count or file hash) or reset: true starts fresh; a
// text-only change (enrichment, edits) swaps the deck in and keeps the state.
function loadPresentationRuntime({ reset = false } = {}) {
  const s = currentSettings();
  const prev = presentationRuntime;
  let next = null;
  if (s.setupKind === 'presentation') {
    let file = null;
    let deck = null;
    try {
      if (s.deck) { file = deckStore().fileFor(s.setupId); deck = deckStore().load(file); }
    } catch (e) {
      console.error('[presentation] deck load failed', e);
    }
    if (!reset && prev && prev.setupId === s.setupId && prev.swapDeck(deck)) {
      next = prev;
      // A changed planned length applies at once. Updated in place: before the
      // first slide this equals a fresh state, but keeps a pacing clock that
      // speech already started; after it, the timeline is kept.
      if (prev.durationMin !== s.durationMin) prev.setDurationMin(s.durationMin);
    } else {
      const rt = createPresentationRuntime({
        deck,
        durationMin: s.durationMin,
        capture: () => captureScreenshot({ displayId: rt.displayId }),
        callLLM: identifyCallLLM,
        onCacheWrite: scheduleMatchCacheSave
      });
      rt.setupId = s.setupId;
      rt.file = deck ? file : null;
      next = rt;
    }
    next.displayId = s.watchDisplayId;
  }
  if (prev && prev !== next) flushMatchCache();
  presentationRuntime = next;
  if (state.capturing && prev !== next) {
    slideLastHash = null;
    slideStableCount = 0;
    startSlideLoop();
  }
  sendPresentationUpdate();
  return presentationRuntime;
}

async function pollPresentation() {
  if (presentationPollBusy) return;
  const rt = presentationRuntime;
  // No deck, no matcher: nothing to compare a frame with, so do not capture.
  if (!rt || !rt.matcher) return;
  let frame = null;
  presentationPollBusy = true;
  try {
    frame = await captureHashFrame({ displayId: rt.displayId, width: 68, height: 64 });
  } catch {
    return;
  } finally {
    presentationPollBusy = false;
  }
  if (!frame || presentationRuntime !== rt) return;
  const newHash = dhashRGBA(frame.width, frame.height, frame.data);
  if (!newHash) return;
  const cfg = presentationSlidesConfig();
  const decision = shouldEmitSlide(slideLastHash, newHash, {
    threshold: cfg.threshold,
    stableCount: slideStableCount,
    requiredStable: cfg.stableRequired
  });
  slideStableCount = decision.stableCount;
  if (!decision.emit) return;
  slideLastHash = newHash;
  // Not awaited: the matcher queues identify calls and drops superseded ones.
  rt.onFrame(newHash).then((res) => {
    if (presentationRuntime !== rt) return;
    if (res.message) send('status', { message: 'Slide matching paused: ' + res.message });
    else if (res.error) console.log('[presentation] slide match failed', res.error);
    checkCoverage(rt, res.left);
    if (res.changed) { sendPresentationUpdate(); recordPresentationSession(); }
  }).catch((e) => console.error('[presentation] slide match error', e));
}

// Only while listening: a step starts the pacing clock.
function stepPresentationSlide(delta) {
  const rt = presentationRuntime;
  if (!rt || !state.capturing) return;
  const res = rt.step(delta);
  checkCoverage(rt, res.left);
  if (res.changed) { sendPresentationUpdate(); recordPresentationSession(); }
}

function resetSlidesSession() {
  slideStore.clear();
  slideLastHash = null;
  slideStableCount = 0;
  slideBusy = false;
  slideDisabled = false;
  slideTxCursor = transcript.length;
}

// -------- audio routing (streaming or batch) --------
// Per-channel level report every few seconds while capturing, so "cue never
// hears me" reports can be told apart: no chunks (capture never reached the
// main process), chunks but rms≈0 (a silent/muted device), or healthy audio
// that the transcriber is dropping.
const AUDIO_LEVEL_LOG_MS = 5000;
const audioLevels = { you: { chunks: 0, peakRms: 0 }, them: { chunks: 0, peakRms: 0 }, lastLog: 0 };
function noteAudioLevel(channel, buf) {
  const lv = audioLevels[channel];
  lv.chunks++;
  if (buf.length >= 2) lv.peakRms = Math.max(lv.peakRms, rms16(buf));
  const now = Date.now();
  if (now - audioLevels.lastLog < AUDIO_LEVEL_LOG_MS) return;
  audioLevels.lastLog = now;
  const fmt = (c) => `${c}: chunks=${audioLevels[c].chunks} peakRms=${Math.round(audioLevels[c].peakRms)}`;
  console.log(`[audio] ${fmt('you')} | ${fmt('them')} (mode=${localWhisperTranscriber ? 'local' : streamingMode ? 'streaming' : 'batch'})`);
  audioLevels.you = { chunks: 0, peakRms: 0 };
  audioLevels.them = { chunks: 0, peakRms: 0 };
}

function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);
  noteAudioLevel(channel, buf);

  if (practice.active) {
    // In practice cue is the interviewer: meeting audio would only echo its
    // own voice, and the mic is muted while that voice plays.
    if (channel === 'them') return;
    if (practice.speaking || Date.now() < practice.quietUntil) return;
  }

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: VAD drives the speech indicator; the provider segments.
    vad[channel].processChunk(buf);
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else if (batchTranscriber) {
    // Batch mode: cut at pauses, then transcribe each utterance.
    batchTranscriber.push(channel, buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
// Primes the provider so the first answer of a session is fast (src/warmup.js).
const warmUpProvider = createWarmUp({
  getSettings: () => currentSettings(),
  createLLM,
  buildPromptRequest,
  isBusy: () => !!activeRequest,
  log: (message) => console.log(message),
  skipProviders: [publik.PUBLIK_PROVIDER]
});

async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    warmUpProvider('listening');
    sttDisabled = false; // reset on re-enable
    const settings = currentSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[cue] capture started, mode: local');
        slideDisabled = false;
        slideTxCursor = transcript.length;
        slideStore = createSlideStore({ maxSlides: getSlidesConfig().maxSlides });
        slideLastHash = null;
        slideStableCount = 0;
        if (presentationRuntime) presentationRuntime.resumeMatching();
        startSlideLoop();
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        send('slides:update', { count: 0, last: null });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startBatchTranscription();
    }
    slideDisabled = false;
    slideTxCursor = transcript.length;
    const slideCfg = getSlidesConfig();
    slideStore = createSlideStore({ maxSlides: slideCfg.maxSlides });
    slideLastHash = null;
    slideStableCount = 0;
    if (presentationRuntime) presentationRuntime.resumeMatching();
    startSlideLoop();
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    send('slides:update', { count: 0, last: null });
    return true;
  }

  state.capturing = false;
  autoAnswer.reset();
  stopBatchTranscription();
  stopStreamingSTT();
  stopSlideLoop();
  vad.you.reset(); vad.them.reset();
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  return false;
}

// -------- feature runner --------
function cancelActiveRequest(reason) {
  if (!activeRequest) return false;
  const cancelled = activeRequest;
  activeRequest = null;
  state.busy = false;
  cancelled.controller.abort();
  send('llm:cancelled', { id: cancelled.id, reason });
  return true;
}

function rememberAnswer(mode, prompt, text) {
  if (!text || !text.trim()) return;
  const entry = { mode, prompt: prompt || '', text: text.trim(), ts: Date.now() };
  sessionAnswers.push(entry);
  if (sessionRecorder) sessionRecorder.addAnswer(entry);
  if (sessionAnswers.length > MAX_SESSION_ANSWERS) sessionAnswers.splice(0, sessionAnswers.length - MAX_SESSION_ANSWERS);
}

function screenCaptureFailedMessage() {
  return process.platform === 'darwin'
    ? 'Screen capture needs permission — grant Screen Recording to cue in System Settings.'
    : process.platform === 'win32'
      ? 'Screen capture failed. Make sure cue is not blocked by Windows privacy or security software, then try again.'
      : 'Screen capture failed. Check your desktop capture permissions, then try again.';
}

// Queue a screenshot for the coding solver (Ctrl/⌘+Shift+H): capture each
// part of a long problem, then Ctrl/⌘+H solves with all of them in order.
async function queueScreenshot() {
  const solveKey = isMac ? '⌘H' : 'Ctrl+H';
  if (screenshotQueue.length >= MAX_QUEUED_SCREENSHOTS) {
    send('status', { message: `Holding ${MAX_QUEUED_SCREENSHOTS} screenshots already. Press ${solveKey} to solve with them.` });
    return;
  }
  try {
    const image = await captureScreenshot();
    if (!image) throw new Error('No screen source was available.');
    screenshotQueue.push(image);
    const n = screenshotQueue.length;
    send('status', { message: `Screenshot ${n} saved. Scroll and add more, or press ${solveKey} to solve with ${n === 1 ? 'it' : 'all ' + n} plus the current screen.` });
  } catch (e) {
    recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'queueScreenshot', context: {} });
    send('status', { message: screenCaptureFailedMessage() });
  }
}

function bubbleFor(mode, def, userText, queued) {
  if (mode === 'leetcode' && queued) return `Solve what's on screen (${queued + 1} screenshots)`;
  if (def.userBubble !== null) return def.userBubble;
  if (mode === 'ask' || mode === 'codeFollowup') return userText;
  if (mode === 'answerThis') return `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"`;
  return null;
}

async function runFeature(requestedMode, userText, { auto = false } = {}) {
  if (!MODES[requestedMode]) return;
  const text = userText || '';
  if (activeRequest && activeRequest.mode === requestedMode && activeRequest.text === text &&
      Date.now() - activeRequest.startedAt < REPEAT_GUARD_MS) return;
  cancelActiveRequest('replaced');

  const job = { id: ++requestSeq, mode: requestedMode, text, auto, startedAt: Date.now(), controller: new AbortController() };
  activeRequest = job;
  state.busy = true;
  if (!auto) lastManualRequestAt = job.startedAt;
  const { signal } = job.controller;
  // Events of a cancelled request never reach the UI after its replacement starts.
  const emit = (channel, data) => { if (!signal.aborted) send(channel, { id: job.id, ...data }); };

  try {
    const settings = currentSettings();
    const llm = createLLM(settings);
    const session = { answers: sessionAnswers };
    if (settings.setupKind === 'presentation') {
      const deck = presentationRuntime ? presentationRuntime.deck : null;
      const asked = requestedMode === 'ask' || requestedMode === 'answerThis' ? text : currentQuestion(transcript) || text;
      settings.deckOutline = deckOutline(deck);
      session.slides = slideContext(deck, presentationRuntime ? presentationRuntime.state.snapshot().current : null, asked);
    }
    const request = buildPromptRequest(settings, requestedMode, transcript, text, session);
    const mode = request.mode;
    const def = MODES[mode];
    const queuedScreens = mode === 'leetcode' ? screenshotQueue.slice() : [];
    emit('llm:start', { userBubble: bubbleFor(mode, def, text, queuedScreens.length), small: !!def.small, category: request.category, mode, auto });

    // A recap of nothing comes back as plausible generic filler. Say so instead.
    if (def.transcriptRequired && transcript.length === 0) {
      emit('llm:error', { message: state.capturing
        ? 'Nothing has been transcribed yet. Let the conversation run a little, then try again.'
        : 'Nothing captured yet. Start listening first so cue can hear the conversation.' });
      return;
    }

    if (!llm.ready) {
      const message = llm.configurationError ||
        (llm.model ? 'Add your ' + settings.provider + ' key in Settings → Keys to get answers.'
          : 'Choose a model for ' + settings.provider + ' in Settings → Keys to get answers.');
      if (settings.provider === publik.PUBLIK_PROVIDER) {
        // No key yet: either the disclosure was never accepted (open it — the
        // mint happens only on "Continue"), or the install was revoked or the
        // last mint failed (offer Reconnect). The app never silently spends.
        const action = !settings.publik.disclosureAccepted
          ? { kind: 'disclosure' }
          : { kind: 'reconnect', label: 'Reconnect' };
        emit('llm:error', { message, action });
        return;
      }
      emit('llm:error', { message, action: { kind: 'settings' } });
      return;
    }
    // Never a silent starter (CONTRACT §12.4): the first-run card — balance,
    // justification, "Link this computer & pick a plan" / "Later" — is shown
    // at least once before any starter usage is spent. Normally it appears
    // right after provisioning; this gate catches a card that was never
    // acknowledged (e.g. an install provisioned by an earlier release).
    if (settings.provider === publik.PUBLIK_PROVIDER && settings.apiKeys.publik && !settings.publik.cardShown) {
      emit('llm:error', { message: 'publik API is set up. Take a look at the card, then ask again.', action: { kind: 'card' } });
      return;
    }

    const images = queuedScreens.slice();
    if (request.needsScreen) {
      try {
        const current = await captureScreenshot();
        if (!current) throw new Error('No screen source was available.');
        images.push(current);
      }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        send('status', { message: screenCaptureFailedMessage() });
      }
    }
    if (signal.aborted) return;

    const answer = await streamWithWatchdog(params => llm.stream(params), {
      system: request.system,
      cachePrefix: request.cachePrefix,
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      effort: request.effort,
      turns: request.turns,
      imageDataUrls: images,
      onToken: t => emit('llm:token', { text: t }),
      onResponse: settings.provider === publik.PUBLIK_PROVIDER ? (res) => publikNoteHeaders(res && res.headers) : undefined
    }, STREAM_INACTIVITY_MS, signal);
    if (signal.aborted) return;
    if (mode === 'practiceQuestion') {
      publishPracticeQuestion(answer);
    } else {
      const prompt = mode === 'say' || mode === 'assist' ? currentQuestion(transcript) : text;
      rememberAnswer(mode, prompt, answer);
    }
    if (queuedScreens.length) screenshotQueue = screenshotQueue.filter((image) => !queuedScreens.includes(image));
    emit('llm:done', {});
    // Streams settle after their headers, so the charge is reconciled from
    // GET /wallet shortly after the answer — one request per answer, debounced.
    if (settings.provider === publik.PUBLIK_PROVIDER) publikScheduleWalletRefresh();
  } catch (e) {
    if (signal.aborted || (e && e.cancelled)) return;
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode: requestedMode, provider: store.getSettings().provider } });
    const action = e && e.action ? e.action : null;
    emit('llm:error', { message: e && e.message ? e.message : String(e), action });
    if (action) publikHandleErrorAction(action);
  } finally {
    if (activeRequest === job) {
      activeRequest = null;
      state.busy = false;
    }
  }
}

// -------- IPC --------
// Redact on the way out, strip on the way in: the publik key never enters the
// renderer, and the renderer's whole-object Save can never clobber it.
ipcMain.handle('settings:get', () => store.redactForRenderer(store.getSettings()));
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  const before = store.getSettings();
  const next = store.setRendererSettings(patch);
  removeOrphanedDecks(before, next);
  // Switching to or from a presentation setup takes or frees the slide keys.
  const presentation = currentSettings().setupKind === 'presentation';
  if (presentation !== shortcutsForPresentation && !shortcutsSuspended) registerShortcuts();
  loadPresentationRuntime();
  // A saved key may have fixed what paused slide matching.
  if (presentationRuntime) presentationRuntime.resumeMatching();
  // Restart slide polling with the new interval when capturing (keeps slides).
  if (state.capturing) startSlideLoop();
  return store.redactForRenderer(next);
});

// -------- publik API --------
// Contract: ~/publik-api-research/CONTRACT.md. The key is minted only after
// the disclosure is accepted (publik:accept-disclosure); the balance line is
// fed by the x-publik-* headers on every answer and reconciled from GET /wallet.
let publikWalletTimer = null;
let publikProvisioning = null;

function publikDevice() {
  let deviceName = '';
  try { deviceName = os.hostname(); } catch { /* optional */ }
  return { appVersion: app.getVersion(), platform: process.platform, osVersion: os.release(), arch: process.arch, deviceName };
}

function publikState() {
  const s = store.getSettings();
  const p = s.publik || {};
  const connected = !!s.apiKeys.publik;
  const wallet = p.wallet || null;
  const claimState = (wallet && wallet.claimState) || p.claimState || 'anonymous';
  const view = {
    available: publikBuild.available,
    selected: s.provider === publik.PUBLIK_PROVIDER,
    connected,
    revoked: !!p.revoked,
    disconnected: !!p.disconnected,
    keyId: p.keyId || '',
    claimState,
    claimUrl: p.claimUrl || (wallet && wallet.claimUrl) || '',
    addCreditUrl: (wallet && wallet.addCreditUrl) || '',
    topUpUrl: (wallet && wallet.topUpUrl) || p.claimUrl || '',
    starterMicros: p.starterMicros || 0,
    balanceMicros: p.balanceMicros,
    balanceAt: p.balanceAt || 0,
    balanceLabel: publik.formatMicros(p.balanceMicros),
    wallet,
    disclosureAccepted: p.disclosureAccepted || 0,
    disclosureVersion: publikBuild.disclosureVersion,
    lastError: p.lastError || '',
    cardShown: !!p.cardShown,
    copy: publik.COPY,
    links: publik.LINKS
  };
  view.line = publik.balanceLine(view);
  // CONTRACT §12: the first-run card (shown while connected && !cardShown),
  // the settings button, and the low-starter banner — all computed here so
  // the renderer only paints.
  view.card = publik.ctaView(view);
  view.settingsCta = publik.settingsCta(view);
  view.lowStarter = publik.lowStarterNotice(view);
  return view;
}
function publikPush() { send('publik:state', publikState()); }

async function publikProvision() {
  if (publikProvisioning) return publikProvisioning;
  publikProvisioning = publik.provisionInstall({
    build: publikBuild,
    store,
    device: publikDevice(),
    log: (e) => recordEvent({ level: e.level, event: e.event, msg: e.msg, frame: 'publikProvision', context: e.context || {} })
  }).then((r) => {
    if (r.ok && r.minted) store.setPublik({ disconnected: false });
    publikPush();
    return publikState();
  }).finally(() => { publikProvisioning = null; });
  return publikProvisioning;
}

// x-publik-* headers from a streamed answer: the balance after admission
// (the hold is included), the claim state, the week. Settlement follows.
function publikNoteHeaders(headers) {
  const h = publik.readGatewayHeaders(headers);
  if (!h) return;
  const s = store.getSettings();
  const wallet = { ...(s.publik.wallet || {}) };
  if (h.balanceMicros !== null) wallet.balanceMicros = h.balanceMicros;
  if (h.claimState) wallet.claimState = h.claimState;
  if (h.weekUsedMicros !== null) wallet.weekUsedMicros = h.weekUsedMicros;
  if (h.weekBudgetMicros !== null || h.weekResetsAt) wallet.weekBudgetMicros = h.weekBudgetMicros;
  if (h.weekResetsAt) wallet.weekResetsAt = h.weekResetsAt;
  if (h.starterRemainingMicros !== null) wallet.starterRemainingMicros = h.starterRemainingMicros;
  store.setPublik({
    balanceMicros: h.balanceMicros !== null ? h.balanceMicros : s.publik.balanceMicros,
    balanceAt: Date.now(),
    claimState: h.claimState || s.publik.claimState,
    wallet,
    revoked: false
  });
  publikPush();
}

async function publikRefreshWallet() {
  const s = store.getSettings();
  if (!s.apiKeys.publik) return publikState();
  try {
    const w = await publik.fetchWallet({ baseUrl: s.publik.baseUrl || publikBuild.baseUrl, apiKey: s.apiKeys.publik });
    store.setPublik({
      wallet: w, balanceMicros: w.balanceMicros, balanceAt: Date.now(), claimState: w.claimState,
      claimUrl: w.claimUrl || (w.claimState === 'claimed' ? '' : s.publik.claimUrl), revoked: false, disconnected: false, lastError: ''
    });
  } catch (e) {
    if (e.status === 401) publikHandleRevoked(e);
    else recordEvent({ level: 'warn', event: 'publik_wallet_failed', msg: e.message, frame: 'publikRefreshWallet', context: { status: e.status || null } });
  }
  publikPush();
  return publikState();
}
function publikScheduleWalletRefresh() {
  clearTimeout(publikWalletTimer);
  publikWalletTimer = setTimeout(() => { publikRefreshWallet().catch(() => {}); }, 1500);
}

// 401 key_revoked: reprovision:true (idle sweep) → re-mint on our own with the
// same install_id; reprovision:false (removed from the dashboard) → stay
// disconnected until the user presses Reconnect.
function publikHandleRevoked(e) {
  const revokedType = !!(e && e.type === 'key_revoked');
  const silent = revokedType && e.reprovision === true;
  // "disconnected" is the dashboard/uninstaller removal only; a plain 401
  // (invalid_api_key) just asks for Reconnect.
  store.setPublik({ revoked: true, disconnected: revokedType && !silent, lastError: '' });
  if (silent) publikProvision().catch(() => {});
}
function publikHandleErrorAction(action) {
  if (!action || action.kind !== 'reprovision') return;
  publikHandleRevoked({ type: 'key_revoked', reprovision: true });
}

ipcMain.handle('publik:state', () => publikState());
ipcMain.handle('publik:accept-disclosure', async () => {
  // Consent precedes mint: this is the only path that calls POST /installs
  // for a fresh install. It also selects publik if the user had moved away.
  if (!publikBuild.available) return publikState();
  store.setPublik({ disclosureAccepted: publikBuild.disclosureVersion });
  store.setSettings({ provider: publik.PUBLIK_PROVIDER });
  return publikProvision();
});
ipcMain.handle('publik:reconnect', async () => {
  const s = store.getSettings();
  if (!s.publik.disclosureAccepted) return publikState();
  if (s.apiKeys.publik && !s.publik.revoked) return publikRefreshWallet();
  store.setPublik({ revoked: true });
  return publikProvision();
});
ipcMain.handle('publik:refresh', () => publikRefreshWallet());
ipcMain.handle('publik:disconnect', async () => {
  const s = store.getSettings();
  if (s.apiKeys.publik) {
    try { await publik.revokeInstall({ baseUrl: s.publik.baseUrl || publikBuild.baseUrl, apiKey: s.apiKeys.publik }); } catch (e) { /* the key is dropped locally regardless */ }
  }
  store.setPublik({ apiKey: '', keyId: '', revoked: false, disconnected: true, balanceMicros: null, wallet: null, lastError: '' });
  publikPush();
  return publikState();
});
// "Later" or the primary button on the first-run card: the card was shown for
// this starter grant. Touches publik.cardShown only — the key stays in place
// and the balance is kept (§12.1).
ipcMain.handle('publik:card-seen', () => {
  try { publik.markCardSeen(store); } catch (e) { recordEvent({ level: 'error', event: 'publik_card_seen_failed', msg: e.message, frame: 'publik:card-seen', context: {} }); }
  publikPush();
  return publikState();
});
// The only path a gateway-supplied URL can take out of the app: publikhq.com
// only. A link off that origin is dropped (the stored claim link stands in
// when it is safe); nothing else is ever handed to the system browser.
ipcMain.on('publik:open', (_e, url) => {
  const s = store.getSettings();
  const target = publik.resolveOpenTarget(url, s.publik.claimUrl);
  if (!target) { recordEvent({ level: 'warn', event: 'publik_open_dropped', msg: '', frame: 'publik:open', context: {} }); return; }
  shell.openExternal(target).catch(() => {});
});
ipcMain.handle('capture:toggle', () => {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
});
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
// Crash recovery. The recorder saves a running conversation every few seconds
// and a normal quit or Clear marks it ended, so a session left unended means
// cue stopped mid-call (crash, kill, power loss). Pick the recent one back up:
// its transcript and answers return to memory, so What should I say?, Recap and
// follow-ups carry on, and recording continues in the same session. Only setups
// that save are affected; "Any conversation" never writes anything to resume.
function resumeInterruptedConversation() {
  let plan;
  try {
    const s = currentSettings();
    plan = planResume(sessionStore.unended(), { now: Date.now(), setupId: s.setupId, saving: s.saveSessions });
  } catch (error) {
    console.error('[sessions] could not look for an interrupted conversation:', error.message);
    return;
  }
  for (const old of plan.close) {
    try { old.endedAt = old.updatedAt || old.startedAt; sessionStore.save(old); } catch { /* retried at the next launch */ }
  }
  const session = plan.resume;
  const quitWhileListening = !!session && session.endReason === QUIT_WHILE_LISTENING;
  if (!session || !sessionRecorder.resume(session)) return;
  const turns = session.transcript.slice(-MAX_TRANSCRIPT_TURNS).map(({ channel, text, ts }) => ({ channel, text, ts }));
  transcript.push(...turns);
  sessionAnswers.push(...(session.answers || []).slice(-MAX_SESSION_ANSWERS));
  resumedConversation = { turns, updatedAt: session.updatedAt, setupName: session.setupName || '', quitWhileListening };
  console.log(`[sessions] resumed ${session.id} (${turns.length} turns)`);
}

// Clearing starts a new conversation: the current one is saved as a session
// (when saving is on) and forgotten here.
function resetConversation() {
  transcript.splice(0, transcript.length);
  sessionAnswers.splice(0, sessionAnswers.length);
  screenshotQueue = [];
  autoAnswer.reset();
  return sessionRecorder ? sessionRecorder.end() : null;
}
ipcMain.handle('transcript:clear', () => {
  const savedId = resetConversation();
  resetSlidesSession();
  send('slides:update', { count: 0, last: null });
  loadPresentationRuntime({ reset: true });
  return { ok: true, savedId };
});

// -------- practice interviews --------
function practiceState() {
  return { active: practice.active };
}

function publishPracticeQuestion(text) {
  const question = String(text || '').trim();
  if (!question) return;
  const turn = { channel: 'them', text: question, ts: Date.now(), source: 'practice' };
  pushTranscript(turn);
  send('transcript', turn);
  send('practice:question', { text: question });
}

ipcMain.handle('practice:start', () => {
  if (currentSettings().setupKind !== 'interview') throw new Error('Practice needs a Job interview setup. Switch to one in the setup menu.');
  if (practice.active) return practiceState();
  cancelActiveRequest('stopped');
  const savedId = resetConversation();
  if (sessionRecorder) sessionRecorder.setKind('practice');
  practice.active = true;
  practice.speaking = false;
  send('practice:state', practiceState());
  return { ...practiceState(), savedId };
});
ipcMain.handle('practice:end', () => {
  if (!practice.active) return practiceState();
  cancelActiveRequest('stopped');
  practice.active = false;
  practice.speaking = false;
  const savedId = sessionRecorder ? sessionRecorder.end() : null;
  if (sessionRecorder) sessionRecorder.setKind('interview');
  transcript.splice(0, transcript.length);
  sessionAnswers.splice(0, sessionAnswers.length);
  send('practice:state', practiceState());
  return { ...practiceState(), savedId };
});
ipcMain.on('practice:speaking', (_e, speaking) => {
  practice.speaking = !!speaking;
  if (!speaking) practice.quietUntil = Date.now() + PRACTICE_ECHO_GUARD_MS;
});

// -------- saved sessions --------
function sessionsDir() {
  return path.join(app.getPath('userData'), 'sessions');
}

function sessionsState(query = '') {
  const settings = store.getSettings();
  const current = sessionRecorder && sessionRecorder.current();
  const active = currentSettings();
  return {
    enabled: active.saveSessions,
    setupName: active.setupName,
    setupKind: active.setupKind,
    exportDir: settings.sessionsExportDir || '',
    currentId: current ? current.id : null,
    sessions: sessionStore ? sessionStore.list(query) : []
  };
}

// The in-memory copy of the live session is newer than its file.
function loadSession(id) {
  const current = sessionRecorder && sessionRecorder.current();
  if (current && current.id === id) return current;
  return sessionStore.get(id);
}

function saveSessionCopy(session) {
  const current = sessionRecorder && sessionRecorder.current();
  if (current && current.id === session.id) { sessionRecorder.flush(); return; }
  sessionStore.save(session);
  const dir = store.getSettings().sessionsExportDir;
  if (dir) {
    try { writeFileAtomic(path.join(dir, exportFileName(session)), sessionToMarkdown(session)); }
    catch (e) { send('status', { message: 'Could not write the Markdown copy: ' + e.message }); }
  }
}

ipcMain.handle('sessions:list', (_e, query) => sessionsState(query));
ipcMain.handle('sessions:get', (_e, id) => {
  if (!isValidId(id)) throw new Error('Invalid session id.');
  const session = loadSession(id);
  return session ? { ...session, summary: summarize(session), markdown: sessionToMarkdown(session) } : null;
});
ipcMain.handle('sessions:set-enabled', (_e, enabled) => {
  const saved = store.getSettings();
  const next = store.setSettings({ setups: updateSetup(saved, saved.activeSetupId, { saveSessions: !!enabled }) });
  send('settings:changed', { setups: next.setups });
  if (enabled && sessionRecorder && !sessionRecorder.current()) {
    // Keep the conversation so far, not only what follows.
    for (const turn of transcript) sessionRecorder.addTurn(turn);
    for (const answer of sessionAnswers) sessionRecorder.addAnswer(answer);
  } else if (!enabled && sessionRecorder) {
    sessionRecorder.end();
  }
  return sessionsState();
});
ipcMain.handle('sessions:delete', (_e, id) => {
  if (!isValidId(id)) throw new Error('Invalid session id.');
  const current = sessionRecorder && sessionRecorder.current();
  if (current && current.id === id) sessionRecorder.discard();
  sessionStore.remove(id);
  return sessionsState();
});
ipcMain.handle('sessions:export', async (_e, id) => {
  const session = isValidId(id) && loadSession(id);
  if (!session) throw new Error('That session no longer exists.');
  const result = await dialog.showSaveDialog(win, {
    title: 'Export session as Markdown',
    defaultPath: path.join(app.getPath('documents'), exportFileName(session)),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  writeFileAtomic(result.filePath, sessionToMarkdown(session));
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle('sessions:open-folder', async () => {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const error = await shell.openPath(sessionsDir());
  return { ok: !error, error };
});
ipcMain.handle('sessions:choose-export-dir', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Keep a Markdown copy of each session in…',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return sessionsState();
  store.setSettings({ sessionsExportDir: result.filePaths[0] });
  send('settings:changed', { sessionsExportDir: result.filePaths[0] });
  if (sessionRecorder) sessionRecorder.flush();
  return sessionsState();
});
ipcMain.handle('sessions:clear-export-dir', () => {
  store.setSettings({ sessionsExportDir: '' });
  send('settings:changed', { sessionsExportDir: '' });
  return sessionsState();
});

// Debriefs stream into the Sessions viewer and are saved with the session.
let debriefInFlight = null;
ipcMain.handle('sessions:debrief', async (_e, id) => {
  const session = isValidId(id) && loadSession(id);
  if (!session) throw new Error('That session no longer exists.');
  const settings = currentSettings();
  // A debrief is read after the call, so accuracy matters more than speed:
  // the fast model listed offers as agreements and prep notes as figures.
  const llm = createLLM({ ...settings, smart: true });
  if (!llm.ready) throw new Error(llm.configurationError || 'Set up an AI provider in Settings first.');
  if (debriefInFlight) debriefInFlight.abort();
  const controller = new AbortController();
  debriefInFlight = controller;
  // Reviewed against the setup the session was recorded with, not the active one.
  const sessionSettings = settingsForSession(store.getSettings(), session);
  const presentation = sessionSettings.setupKind === 'presentation';
  if (presentation) {
    // The deck outline grounds slide names; a deleted setup or deck leaves the
    // session's own titles to carry the review.
    try {
      const setup = presentationSetup(session.setupId);
      const deck = setup && setup.deck ? deckStore().load(deckStore().fileFor(setup.id)) : null;
      if (deck) sessionSettings.deckOutline = deckOutline(deck);
    } catch (err) {
      console.warn('[debrief] deck outline unavailable:', err.message);
    }
  }
  const request = buildDebriefRequest(sessionSettings, session);
  try {
    const text = await streamWithWatchdog(params => llm.stream(params), {
      system: request.system,
      cachePrefix: request.cachePrefix,
      maxTokens: request.maxTokens,
      effort: request.effort,
      turns: request.turns,
      onToken: t => send('sessions:debrief-token', { id, text: t })
    }, STREAM_INACTIVITY_MS, controller.signal);
    if (presentation) {
      // The audience questions arrive as a trailing json block: keep the
      // prose readable and the questions as data for the deck.
      const { prose, questions } = splitDebrief(String(text || ''));
      session.debrief = prose;
      session.debriefQuestions = questions;
    } else {
      session.debrief = String(text || '').trim();
    }
    session.debriefAt = Date.now();
    saveSessionCopy(session);
    return { id, debrief: session.debrief, questions: session.debriefQuestions || [] };
  } finally {
    if (debriefInFlight === controller) debriefInFlight = null;
  }
});
ipcMain.handle('slides:list', () => slideStore.list());
ipcMain.handle('slides:state', () => ({
  ...getSlidesConfig(),
  count: slideStore.count(),
  polling: !!slideTimer,
  disabled: slideDisabled
}));
ipcMain.handle('slides:clear', () => {
  resetSlidesSession();
  send('slides:update', { count: 0, last: null });
  return { ok: true };
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('llm:cancel', () => { cancelActiveRequest('stopped'); });
ipcMain.on('screenshot:queue', () => { queueScreenshot(); });
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
// The renderer reports where its UI is; the main process decides click-through
// from the cursor position (src/click-through.js).
ipcMain.on('mouse:rects', (_e, rects) => {
  if (!clickThrough || !Array.isArray(rects)) return;
  const valid = rects.slice(0, 20).filter((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite));
  clickThrough.setRects(valid);
});
ipcMain.handle('clipboard:write-text', (_e, text) => clipboard.writeText(String(text || '')));
// Only OS settings panes; see src/system-settings-url.js.
ipcMain.on('open-pane', (_e, url) => {
  if (!isSystemSettingsUrl(url)) { recordEvent({ level: 'warn', event: 'open_pane_dropped', msg: '', frame: 'open-pane', context: {} }); return; }
  shell.openExternal(url).catch(() => {});
});
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
// -------- presentation decks --------
// The file dialog and the file read run in MAIN; the renderer never supplies a path.
let deckStoreInstance = null;
function deckStore() {
  if (!deckStoreInstance) deckStoreInstance = new DeckStore({ dir: path.join(app.getPath('userData'), 'decks') });
  return deckStoreInstance;
}
const deckEnrichments = new Map(); // setupId -> { controller, pending: Set<n> } (one enrichment per setup)
const NOT_PRESENTATION = 'Choose a presentation setup first.';

function presentationSetup(setupId) {
  const setup = (store.getSettings().setups || []).find(x => x.id === setupId);
  return setup && setup.kind === 'presentation' ? setup : null;
}

function setDeckPointer(setupId, deck, file, importedAt) {
  const saved = store.getSettings();
  const pointer = { file, fileName: deck.source.fileName, slideCount: deck.slides.length, importedAt };
  const next = store.setSettings({ setups: updateSetup(saved, setupId, { deck: pointer }) });
  send('settings:changed', { setups: next.setups });
  if (currentSettings().setupId === setupId) loadPresentationRuntime();
}

// A save to the active setup's deck: refresh the live runtime's slide text.
function deckSaved(setupId) {
  if (presentationRuntime && presentationRuntime.setupId === setupId) loadPresentationRuntime();
}

function abortDeckEnrichment(setupId) {
  const running = deckEnrichments.get(setupId);
  if (running) { running.controller.abort(); deckEnrichments.delete(setupId); }
}

function removeOrphanedDecks(before, after) {
  try {
    const kept = new Set(((after && after.setups) || []).map(x => x.id));
    for (const setup of (before && before.setups) || []) {
      if (kept.has(setup.id)) continue;
      abortDeckEnrichment(setup.id);
      // Never trust the stored pointer for the path: the file name derives from the id.
      if (setup.deck) deckStore().remove(deckStore().fileFor(setup.id));
    }
  } catch (e) { console.error('[deck] cleanup failed', e); }
}

function deckSummary(deck) {
  return { fileName: deck.source.fileName, slideCount: deck.slides.length };
}

// Enriches `ns` in the background, saving and reporting after every batch.
// Starting a new run for the same setup aborts the old one's remaining batches.
// A regenerate that supersedes a running enrichment inherits that run's
// unprocessed slides; a new import replaces the deck, so it just aborts.
async function runDeckEnrichment(setupId, file, deck, ns, { fromImport = false } = {}) {
  const previous = deckEnrichments.get(setupId);
  if (previous) {
    previous.controller.abort();
    if (!fromImport) ns = [...new Set([...ns, ...previous.pending])].sort((a, b) => a - b);
  }
  const controller = new AbortController();
  const run = { controller, pending: new Set(deck.slides.filter(s => ns.includes(s.n) && !s.edited).map(s => s.n)) };
  deckEnrichments.set(setupId, run);
  try {
    const setup = presentationSetup(setupId);
    if (!setup) return;
    const llm = createLLM({ ...currentSettings(), smart: true });
    const total = Math.ceil(deck.slides.filter(s => ns.includes(s.n) && !s.edited).length / 8);
    if (!llm.ready) {
      // Without a provider, flag the slides so the UI can offer a retry.
      const failed = { ...deck, slides: deck.slides.map(s => (ns.includes(s.n) && !s.edited ? { ...s, enrichError: true } : s)) };
      deckStore().save(file, failed);
      deckSaved(setupId);
      send('deck:progress', { setupId, done: total, total });
      return;
    }
    await enrichDeck(deck, {
      ns,
      conversation: setup.conversation,
      notes: setup.notes,
      signal: controller.signal,
      call: request => streamWithWatchdog(params => llm.stream(params), {
        system: request.system,
        turns: request.turns,
        maxTokens: request.maxTokens,
        effort: request.effort,
        onToken: () => {}
      }, STREAM_INACTIVITY_MS, controller.signal),
      onBatch: (d, done, count, batchNs) => {
        if (controller.signal.aborted) return;
        for (const n of batchNs) run.pending.delete(n);
        // Merge into the latest deck on disk: only this batch's enrichment
        // fields change, and slides edited meanwhile are left alone.
        const latest = deckStore().load(file);
        if (!latest) return;
        const merged = { ...latest, slides: latest.slides.map(cur => {
          const mine = batchNs.includes(cur.n) ? d.slides.find(x => x.n === cur.n) : null;
          if (!mine || cur.edited) return cur;
          return { ...cur, points: mine.points, questions: mine.questions, keyIdea: mine.keyIdea, enrichError: mine.enrichError };
        }) };
        deckStore().save(file, merged);
        deckSaved(setupId);
        send('deck:progress', { setupId, done, total: count });
      }
    });
  } catch (e) {
    console.error('[deck] enrichment failed', e);
  } finally {
    if (deckEnrichments.get(setupId) === run) deckEnrichments.delete(setupId);
  }
}

ipcMain.handle('deck:import', async (_e, setupId) => {
  if (!presentationSetup(setupId)) return { error: NOT_PRESENTATION };
  let fileName = 'the file';
  try {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Presentation', extensions: ['pptx', 'pdf'] }]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const filePath = res.filePaths[0];
    fileName = path.basename(filePath);
    const type = path.extname(filePath).toLowerCase() === '.pdf' ? 'pdf' : 'pptx';
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_FILE_BYTES) throw new DeckError('That file is larger than ' + Math.round(MAX_FILE_BYTES / (1024 * 1024)) + ' MB.');
    const buffer = await fs.promises.readFile(filePath);
    const file = deckStore().fileFor(setupId);
    const { deck, unchanged, toEnrich } = await importDeck({ buffer, type, fileName, previous: deckStore().load(file) });
    if (!unchanged) {
      // A run for the old deck must stop merging its slide-n points into this
      // one, even when this import needs no enrichment at all.
      abortDeckEnrichment(setupId);
      deckStore().save(file, deck);
      setDeckPointer(setupId, deck, file, Date.now());
      if (toEnrich.length) runDeckEnrichment(setupId, file, deck, toEnrich, { fromImport: true });
    }
    return { deck: deckSummary(deck), unchanged };
  } catch (e) {
    return { error: e instanceof DeckError ? e.message : 'Could not read ' + fileName + '.' };
  }
});

// Connected displays for the Watch display picker (presentation setups).
ipcMain.handle('displays:list', () => screen.getAllDisplays().map((d, i) => ({
  id: String(d.id),
  label: d.label || 'Display ' + (i + 1),
  width: d.size.width,
  height: d.size.height
})));

ipcMain.handle('deck:get', (_e, setupId) => {
  const setup = presentationSetup(setupId);
  if (!setup || !setup.deck) return null;
  return deckStore().load(deckStore().fileFor(setupId));
});

ipcMain.handle('deck:update-slide', (_e, setupId, n, patch) => {
  const setup = presentationSetup(setupId);
  if (!setup || !setup.deck) return { error: NOT_PRESENTATION };
  const file = deckStore().fileFor(setupId);
  const deck = deckStore().load(file);
  const slide = deck && deck.slides.find(s => s.n === n);
  if (!slide) return { error: 'That slide no longer exists.' };
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  const p = patch && typeof patch === 'object' ? patch : {};
  slide.points = list(p.points);
  slide.questions = list(p.questions);
  slide.keyIdea = typeof p.keyIdea === 'string' ? p.keyIdea : '';
  slide.edited = true;
  slide.enrichError = false;
  deckStore().save(file, deck);
  deckSaved(setupId);
  return { deck };
});

// Audience questions from a debrief, appended to their slides' likely
// questions (deduplicated, at most 6 per slide, marked edited).
ipcMain.handle('deck:add-questions', (_e, setupId, items) => {
  const setup = presentationSetup(setupId);
  if (!setup || !setup.deck) return { error: NOT_PRESENTATION };
  const file = deckStore().fileFor(setupId);
  const deck = deckStore().load(file);
  if (!deck) return { error: 'Import a deck first.' };
  const valid = validQuestionItems(items, deck.slides.length);
  if (!valid.length) return { added: 0 };
  const next = appendQuestions(deck, valid);
  const added = countQuestions(next) - countQuestions(deck);
  if (added > 0) {
    deckStore().save(file, next);
    deckSaved(setupId);
  }
  return { added };
});

ipcMain.handle('deck:regenerate', (_e, setupId, which) => {
  const setup = presentationSetup(setupId);
  if (!setup || !setup.deck) return { error: NOT_PRESENTATION };
  const file = deckStore().fileFor(setupId);
  const deck = deckStore().load(file);
  if (!deck) return { error: 'Import a deck first.' };
  let ns;
  if (which === 'unedited') {
    ns = deck.slides.filter(s => !s.edited).map(s => s.n);
  } else {
    const slide = deck.slides.find(s => s.n === which);
    if (!slide) return { error: 'That slide no longer exists.' };
    slide.edited = false;
    deckStore().save(file, deck);
    ns = [slide.n];
  }
  if (ns.length) runDeckEnrichment(setupId, file, deck, ns);
  return { started: ns.length };
});

ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => {
  // Forgetting a caller also clears its separate slide-caption consent decision,
  // so a caller the user re-approves later is asked about slides again too,
  // rather than silently inheriting whatever it was granted or denied before.
  store.clearSlidesConsent(callerId);
  return revokeAppLinkCaller(callerId);
});

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- shortcuts --------
// Start/stop listening needs the renderer's own button: loopback capture
// (getDisplayMedia) requires a user gesture, which executeJavaScript can grant.
function toggleListeningFromShortcut() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript("document.getElementById('stop-btn').click()", true).catch(() => {});
}

function toggleAutoAnswer() {
  const autoAnswerOn = !store.getSettings().autoAnswer;
  store.setSettings({ autoAnswer: autoAnswerOn });
  if (!autoAnswerOn) autoAnswer.reset();
  send('settings:changed', { autoAnswer: autoAnswerOn });
  send('status', { message: autoAnswerOn ? 'Auto-answer on.' : 'Auto-answer off.' });
}

const MOVE_STEP_PX = 80;
// The panel stays wholly on its display, like the restored position.
function moveWindow(dx, dy) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const { x, y } = clampToArea({ x: bounds.x + dx * MOVE_STEP_PX, y: bounds.y + dy * MOVE_STEP_PX }, bounds, workArea);
  win.setPosition(x, y);
}

const SHORTCUT_HANDLERS = {
  assist: () => runFeature('assist', ''),
  say: () => runFeature('say', ''),
  leetcode: () => runFeature('leetcode', ''),
  screenshot: () => queueScreenshot(),
  listen: toggleListeningFromShortcut,
  autoAnswer: toggleAutoAnswer,
  stop: () => cancelActiveRequest('stopped'),
  scrollUp: () => send('answers:scroll', { direction: -1 }),
  scrollDown: () => send('answers:scroll', { direction: 1 }),
  moveLeft: () => moveWindow(-1, 0),
  moveRight: () => moveWindow(1, 0),
  moveUp: () => moveWindow(0, -1),
  moveDown: () => moveWindow(0, 1),
  hide: () => send('hide:toggle', {}),
  quit: () => app.quit(),
  slidePrev: () => stepPresentationSlide(-1),
  slideNext: () => stepPresentationSlide(1)
};

function shortcutsView() {
  return {
    platform: process.platform,
    suspended: shortcutsSuspended,
    actions: SHORTCUT_ACTIONS.map(({ id, label, defaultAccelerator }) => ({
      id, label, defaultAccelerator, ...(shortcutStatus[id] || { accelerator: defaultAccelerator, status: 'unset' })
    }))
  };
}

// Slide stepping is only taken from other apps while a presentation setup is
// active; elsewhere these keys stay free and the actions report 'inactive'.
const PRESENTATION_SHORTCUTS = new Set(['slidePrev', 'slideNext']);
let shortcutsForPresentation = false; // the setup kind registerShortcuts last ran for

function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutState = {};
  shortcutStatus = {};
  shortcutsForPresentation = currentSettings().setupKind === 'presentation';
  const map = resolveShortcuts(store.getSettings().shortcuts);
  const inactive = id => PRESENTATION_SHORTCUTS.has(id) && !shortcutsForPresentation;
  // Inactive actions hold no keys, so they cannot conflict with anything.
  const live = Object.fromEntries(Object.entries(map).filter(([id]) => !inactive(id)));
  // The later of two actions sharing a combination is the one reported.
  const conflicted = new Set(findConflicts(live).map(([, later]) => later));
  for (const { id } of SHORTCUT_ACTIONS) {
    const accelerator = map[id];
    let status;
    if (!accelerator) status = 'unset';
    else if (inactive(id)) status = 'inactive';
    else if (!isValidAccelerator(accelerator)) status = 'invalid';
    else if (conflicted.has(id)) status = 'conflict';
    else if (shortcutsSuspended) status = 'ok';
    else {
      let registered = false;
      // register() throws on a string Electron cannot parse.
      try { registered = globalShortcut.register(accelerator, SHORTCUT_HANDLERS[id]); } catch { status = 'invalid'; }
      if (!status) status = registered ? 'ok' : 'taken';
    }
    shortcutState[id] = status === 'ok' && !shortcutsSuspended;
    shortcutStatus[id] = { accelerator, status };
    if (status === 'taken') {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + id + ' shortcut', frame: 'registerShortcuts', context: { shortcut: id, accelerator } });
    }
  }
  send('shortcuts:state', shortcutsView());
}

ipcMain.handle('shortcuts:get', () => shortcutsView());
// accelerator: a string ('' clears the action) or null to restore the default.
ipcMain.handle('shortcuts:set', (_e, { id, accelerator }) => {
  if (!SHORTCUT_ACTIONS.some((a) => a.id === id)) throw new Error('Unknown shortcut action: ' + id);
  const overrides = { ...(store.getSettings().shortcuts || {}) };
  if (accelerator === null || accelerator === undefined) delete overrides[id];
  else overrides[id] = String(accelerator).trim();
  store.setShortcutOverrides(overrides);
  registerShortcuts();
  return shortcutsView();
});
ipcMain.handle('shortcuts:reset', () => {
  store.setShortcutOverrides({});
  registerShortcuts();
  return shortcutsView();
});
// Recording a new combination in Settings: release every global shortcut so
// the keys reach the recorder instead of triggering cue's own actions.
// A recorder that never resumes (window closed mid-recording) must not leave
// cue without shortcuts, so suspension also ends on its own.
const SHORTCUT_SUSPEND_MAX_MS = 30000;
let shortcutResumeTimer = null;
function resumeShortcuts() {
  clearTimeout(shortcutResumeTimer);
  shortcutResumeTimer = null;
  if (!shortcutsSuspended) return;
  shortcutsSuspended = false;
  registerShortcuts();
}
ipcMain.handle('shortcuts:suspend', () => {
  shortcutsSuspended = true;
  globalShortcut.unregisterAll();
  clearTimeout(shortcutResumeTimer);
  shortcutResumeTimer = setTimeout(resumeShortcuts, SHORTCUT_SUSPEND_MAX_MS);
  return true;
});
ipcMain.handle('shortcuts:resume', () => { resumeShortcuts(); return shortcutsView(); });

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  // systemPreferences.getMediaAccessStatus('microphone') is also implemented on
  // Windows (it reads the Settings > Privacy > Microphone toggle); 'screen' has
  // no per-app gate on Windows so verifyScreenAccess() falls straight through to
  // 'granted' there. Only genuinely ungated platforms (e.g. Linux) keep the old
  // hard-coded "granted" fallback.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return {
      mic: systemPreferences.getMediaAccessStatus('microphone'),
      screen: await verifyScreenAccess(),
    };
  }
  return { mic: 'granted', screen: 'granted' };
}

async function requestPermissions() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return true;

  if (process.platform === 'darwin') {
    // Trigger the macOS microphone permission dialog (first-use only)
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }

    // Trigger the macOS screen-recording permission dialog (first-use only).
    // There is no askForMediaAccess('screen'), but attempting to enumerate
    // sources via desktopCapturer will cause macOS to prompt the user.
    const screenStatus = await verifyScreenAccess();
    if (screenStatus !== 'granted') {
      try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
    }
  }
  // Windows has no OS-level "ask" dialog (systemPreferences.askForMediaAccess is
  // macOS-only) — mic access is governed entirely by the Settings toggle the user
  // flips themselves, which getPermissionStatus() below reads directly.

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  permWin.webContents.on('did-finish-load', () => permWin.show());
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (appLaunched) {
    // Already launched once (Windows startup runs launchApp() unconditionally
    // even while the permission gate is still showing). Just dismiss the gate
    // and bring the existing main window forward instead of building a second
    // one on top of it.
    if (permWin && !permWin.isDestroyed()) { permWin.close(); permWin = null; }
    if (win && !win.isDestroyed()) { win.showInactive(); }
    return;
  }
  appLaunched = true;

  if (isMac && app.dock) app.dock.hide();

  // Before the app-link snapshot and before the window exists, so a first run
  // boots with provider 'publik'. Runs once per settings file and never moves
  // a user who has a working key. No network call happens here.
  if (store.applyPublikDefault(publikBuild)) {
    recordEvent({ level: 'info', event: 'publik_default_applied', msg: '', frame: 'launchApp', context: {} });
  }

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });
  sessionStore = new SessionStore({ dir: sessionsDir() });
  sessionRecorder = new SessionRecorder({
    store: sessionStore,
    isEnabled: () => currentSettings().saveSessions,
    exportDir: () => store.getSettings().sessionsExportDir || '',
    meta: () => { const s = currentSettings(); return { setupId: s.setupId, setupName: s.setupName, setupKind: s.setupKind }; },
    onSaved: (summary) => send('sessions:saved', summary),
    onError: (error) => {
      recordEvent({ level: 'error', event: 'session_save_failed', msg: error.message, frame: 'SessionRecorder', context: {} });
      send('status', { message: 'Could not save this session: ' + error.message });
    }
  });
  resumeInterruptedConversation();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  //
  // Two things are true here and both must hold.
  //
  // 1. `audio` must be the string 'loopback' or 'loopbackWithMute' (or a WebFrameMain).
  // Electron's native binding for this callback rejects anything else, including a
  // plain boolean. Windows used to get `true`, which threw synchronously and surfaced
  // to the renderer as AbortError "Error starting capture" ("Meeting audio could not be
  // started"), and also invoked this one-time `callback` a SECOND time. Never pass a
  // boolean on any platform, and invoke `callback` from exactly one place.
  //
  // 2. On macOS the grant is not free: the only route to system audio is a
  // ScreenCaptureKit session over a real display, so while it is held open macOS paints
  // its screen-recording indicator and names cue under Control Center's "Currently
  // Sharing" — pixels every screen-share viewer sees. Nothing app-side suppresses it
  // (an audio-only grant is rejected by Chromium; a window source lights the same
  // indicator), so the honest answer is consent: never open that session on macOS
  // unless the user switched Meeting audio on in Settings > Audio. This guard is the
  // enforcement point and holds even if another renderer path calls getDisplayMedia.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // The macOS consent gate resolves to an empty source list instead of invoking the
    // one-time reply itself, so this handler keeps exactly one invocation site.
    // test/display-media-audio.test.js counts them, because a second site is how the
    // "One-time callback was called more than once" bug happened before.
    const allowed = !isMac || Boolean(store.getSettings().meetingAudio);
    (allowed ? desktopCapturer.getSources({ types: ['screen'] }) : Promise.resolve([]))
      .then((sources) => (sources.length ? { video: sources[0], audio: 'loopback' } : undefined))
      .catch((err) => {
        console.error('[main] system audio: desktopCapturer.getSources failed:', err);
        return undefined;
      })
      .then((request) => callback(request));
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
      slides: slideStore.list(),
    }),
    setCapturing,
    getSlides: () => slideStore.list(),
    getSlidesConsent: (callerId) => store.getSlidesConsent(callerId),
    setSlidesConsent: (callerId, decision) => store.setSlidesConsent(callerId, decision),
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();
  loadPresentationRuntime();
  // After the window is up, so startup is never slowed by the network.
  setTimeout(() => warmUpProvider('launch'), 3000);
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  // One-time move to setups, after a backup. A failure leaves the file as it
  // was; cue keeps reading it through the compatibility path.
  try {
    if (store.migrateFile()) console.log('[cue] settings migrated to setups');
  } catch (error) {
    console.error('[cue] settings migration to setups failed; the settings file was left unchanged:', error.message);
    recordEvent({ level: 'error', event: 'setups_migration_failed', msg: error.message, frame: 'migrateFile', context: {} });
  }
  app.setName('cue');
  if (isWindows) {
    process.title = 'cue';
  }

  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createPermissionsWindow(); });
      return;
    }
  } else if (isWindows) {
    winSession = await detectConsoleSession();
    // Windows has no OS-level modal permission dialog to block startup on —
    // there is no askForMediaAccess() equivalent, and the only way to change
    // the mic toggle is to leave the app and use Settings — so unlike macOS
    // this never withholds the main window. It surfaces the same in-app
    // gate as an informational window alongside the app instead of leaving
    // the user with no option at all to see or act on the permission state
    // ("not able to give permission ... coz there is no option").
    const allGranted = await requestPermissions();
    if (!allGranted) {
      createPermissionsWindow();
    }
  }

  launchApp();
  // macOS and Linux are shutting down: never hold that up with a dialog.
  powerMonitor.on('shutdown', () => { quitConfirmed = true; });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Quitting in the middle of a call is easy to do by accident (the quit button
// sits next to the listen button), so while listening cue asks first. A quit
// while listening is also remembered, so the next launch can pick the
// conversation back up (see planResume).
let quitConfirmed = false;
let quitPrompt = null;
let quitWhileListening = false;

function mayQuitNow() {
  if (quitConfirmed || !state.capturing) return true;
  confirmQuit();
  return false;
}

function confirmQuit() {
  if (quitPrompt) return;
  const saving = currentSettings().saveSessions;
  const minutes = Math.round(RESUME_WINDOW_MS / 60000);
  const parent = win && !win.isDestroyed() ? win : undefined;
  const options = {
    type: 'question',
    buttons: ['Keep listening', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Quit cue?',
    message: 'Quit while listening?',
    detail: saving
      ? `cue is still listening. The conversation so far is saved, and if you reopen cue within ${minutes} minutes it continues where you left off.`
      : 'cue is still listening. This setup does not save sessions, so the conversation so far will be lost.'
  };
  quitPrompt = (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    .then(({ response }) => {
      quitPrompt = null;
      if (response !== 1) return;
      quitConfirmed = true;
      app.quit();
    })
    .catch(() => { quitPrompt = null; });
}

app.on('before-quit', (e) => {
  if (!mayQuitNow()) { e.preventDefault(); return; }
  quitWhileListening = state.capturing;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Synchronous write: the session in progress is saved before exit.
  if (sessionRecorder) sessionRecorder.end(quitWhileListening ? QUIT_WHILE_LISTENING : undefined);
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  stopSlideLoop();
  flushMatchCache();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', (e) => {
  // Don't quit while the permissions window is open — the user may be in System Settings
  if (permWin) { e.preventDefault(); return; }
  app.quit();
});
