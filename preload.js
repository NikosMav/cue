const { contextBridge, ipcRenderer, clipboard } = require('electron');
const { isLikelyCompleteQuestion } = require('./src/question-detector');
const { acceleratorFromEvent, acceleratorParts, formatAccelerator } = require('./src/accelerator');
const { makeSetup, BUILTIN_SETUP_ID, INTERVIEW_ONLY_FIELDS } = require('./src/setups');
const platform = process.platform;

contextBridge.exposeInMainWorld('cue', {
  platform,
  setupsModel: { makeSetup, BUILTIN_SETUP_ID, INTERVIEW_ONLY_FIELDS },
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  cancelAnswer: () => ipcRenderer.send('llm:cancel'),
  queueScreenshot: () => ipcRenderer.send('screenshot:queue'),
  // Same completeness test the main process uses for auto-answer.
  isLikelyCompleteQuestion: (text) => isLikelyCompleteQuestion(text),
  copyText: (text) => clipboard.writeText(String(text || '')),
  sessionsList: (query) => ipcRenderer.invoke('sessions:list', query || ''),
  sessionsGet: (id) => ipcRenderer.invoke('sessions:get', id),
  sessionsSetEnabled: (enabled) => ipcRenderer.invoke('sessions:set-enabled', !!enabled),
  sessionsDelete: (id) => ipcRenderer.invoke('sessions:delete', id),
  sessionsExport: (id) => ipcRenderer.invoke('sessions:export', id),
  sessionsOpenFolder: () => ipcRenderer.invoke('sessions:open-folder'),
  sessionsChooseExportDir: () => ipcRenderer.invoke('sessions:choose-export-dir'),
  sessionsClearExportDir: () => ipcRenderer.invoke('sessions:clear-export-dir'),
  sessionsDebrief: (id) => ipcRenderer.invoke('sessions:debrief', id),
  practiceStart: () => ipcRenderer.invoke('practice:start'),
  practiceEnd: () => ipcRenderer.invoke('practice:end'),
  practiceSpeaking: (speaking) => ipcRenderer.send('practice:speaking', !!speaking),
  shortcutsGet: () => ipcRenderer.invoke('shortcuts:get'),
  shortcutsSet: (id, accelerator) => ipcRenderer.invoke('shortcuts:set', { id, accelerator }),
  shortcutsReset: () => ipcRenderer.invoke('shortcuts:reset'),
  shortcutsSuspend: () => ipcRenderer.invoke('shortcuts:suspend'),
  shortcutsResume: () => ipcRenderer.invoke('shortcuts:resume'),
  // Plain-data copies only: a KeyboardEvent cannot cross the context bridge.
  acceleratorFromEvent: (e) => acceleratorFromEvent({ code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey }, platform),
  acceleratorParts: (accel) => acceleratorParts(accel, platform),
  formatAccelerator: (accel) => formatAccelerator(accel, platform),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[cue] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setUiRects: (rects) => ipcRenderer.send('mouse:rects', rects),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  publikState: () => ipcRenderer.invoke('publik:state'),
  publikAcceptDisclosure: () => ipcRenderer.invoke('publik:accept-disclosure'),
  publikReconnect: () => ipcRenderer.invoke('publik:reconnect'),
  publikRefresh: () => ipcRenderer.invoke('publik:refresh'),
  publikDisconnect: () => ipcRenderer.invoke('publik:disconnect'),
  publikCardSeen: () => ipcRenderer.invoke('publik:card-seen'),
  publikOpen: (url) => ipcRenderer.send('publik:open', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'llm:cancelled', 'shortcuts:state', 'answers:scroll', 'settings:changed', 'sessions:saved', 'sessions:debrief-token', 'practice:state', 'practice:question', 'status', 'transcript', 'stt:interim', 'stt:final', 'stt:status', 'vad:state', 'applink:consent-request', 'hide:toggle', 'whisper:download-progress', 'whisper:models-changed', 'publik:state'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
