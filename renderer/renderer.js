/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isWindows = cue.platform === 'win32';
  const isMac = cue.platform === 'darwin';

  // Exiting must work before settings or provider setup has completed.
  const quitButton = $('#quit-btn');
  quitButton.addEventListener('click', () => cue.quit());
  quitButton.title = isMac ? 'Quit cue (⌘⇧X)' : 'Quit cue (Ctrl+Shift+X)';

  // ---- paint icons -------------------------------------------------------
  $('#quit-btn').innerHTML = icon('x', { size: 14 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#auto-toggle .ic').innerHTML = icon('wand-sparkles', { size: 14 });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  // Redacted view of the publik API state (never the key), from main via
  // cue.publikState() at boot and the publik:state push thereafter.
  let publikState = null;
  let whisperOverview = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let currentRequestId = null; // events from any other request are stale
  let caretEl = null;
  const MAX_RESPONSES = 20; // the latest answer plus the previous ones kept

  // The reading area is the panel's only scrolling zone: the latest answer
  // (#latest) and, folded below it, the earlier ones (#previous-list).
  const reading = $('#reading');
  const latest = $('#latest');
  const previousList = $('#previous-list');
  const previousToggle = $('#previous-toggle');

  // Fade whichever edge of the reading area has text scrolled out of view.
  function updateMessageFades() {
    const hidden = reading.scrollHeight - reading.clientHeight;
    reading.classList.toggle('fade-top', reading.scrollTop > 2);
    reading.classList.toggle('fade-bottom', hidden - reading.scrollTop > 2);
  }
  reading.addEventListener('scroll', updateMessageFades, { passive: true });
  new MutationObserver(updateMessageFades).observe(reading, { childList: true, subtree: true, characterData: true });
  // A resize (sidebar opened, practice row shown) re-wraps the text; keep the
  // pinned answer in place too. pinnedGroup/keepPinnedInView are defined below
  // and only read when the observer fires.
  new ResizeObserver(() => { keepPinnedInView(); updateMessageFades(); }).observe(reading);

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  const renderMarkdown = window.CueMarkdown.renderMarkdown; // renderer/markdown.js

  // Copy buttons: one per code block, one per finished answer.
  reading.addEventListener('click', (e) => {
    const codeBtn = e.target.closest && e.target.closest('.copy-code');
    const answerBtn = e.target.closest && e.target.closest('.copy-answer');
    const btn = codeBtn || answerBtn;
    if (!btn) return;
    const text = codeBtn
      ? (codeBtn.closest('.code-block').querySelector('code') || {}).textContent || ''
      : (btn.closest('.response-group').querySelector('.ai-text') || { dataset: {} }).dataset.raw || '';
    cue.copyText(text.replace(/\n$/, ''));
    const label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = label; }, 1200);
  });

  // ---- previous answers helpers (pure; test/renderer-panel.test.js evaluates them)
  function previousLabel(count, open) {
    return (open ? '▾' : '▸') + ' Previous answers (' + count + ')';
  }
  // ---- end previous answers helpers

  function setPreviousOpen(open) {
    const count = previousList.children.length;
    const shown = !!open && count > 0;
    previousList.classList.toggle('hidden', !shown);
    previousToggle.classList.toggle('hidden', count === 0);
    previousToggle.textContent = previousLabel(count, shown);
    previousToggle.setAttribute('aria-expanded', String(shown));
    updateMessageFades();
  }
  previousToggle.addEventListener('click', () => setPreviousOpen(previousList.classList.contains('hidden')));

  // A new answer takes the answer on screen to the top of Previous answers
  // (newest first) and folds the list again.
  function archiveLatest() {
    for (const group of [...latest.querySelectorAll(':scope > .response-group')]) previousList.prepend(group);
    while (previousList.children.length > MAX_RESPONSES - 1) previousList.lastElementChild.remove();
    setPreviousOpen(false);
  }

  function clearMessages() {
    latest.innerHTML = '';
    previousList.innerHTML = '';
    setPreviousOpen(false);
    aiEl = null; caretEl = null;
  }

  // The answer being written stays in view: its first line is kept at the top
  // of the reading area while it grows, until the user scrolls by hand.
  // Scrolling once at the start was not enough, because an empty answer
  // cannot be scrolled to the top yet, and the text then streamed in below
  // the visible area.
  let pinnedGroup = null;
  const PIN_MARGIN = 26; // clears the top fade so the first line is not dimmed
  function keepPinnedInView() {
    if (!pinnedGroup || !pinnedGroup.isConnected) return;
    const offset = pinnedGroup.getBoundingClientRect().top - reading.getBoundingClientRect().top - PIN_MARGIN;
    if (Math.abs(offset) > 1) reading.scrollTop += offset;
  }
  const releasePin = () => { pinnedGroup = null; };
  reading.addEventListener('wheel', releasePin, { passive: true });
  reading.addEventListener('pointerdown', (e) => { if (e.offsetX > reading.clientWidth) releasePin(); }); // scrollbar drag
  reading.addEventListener('keydown', releasePin);

  // An answer that arrives without llm:start (an early error) gets its own group.
  function startAi(small) {
    clearEmptyState();
    archiveLatest();
    const group = document.createElement('div');
    group.className = 'response-group';
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    latest.appendChild(group);
  }

  // Streaming renders the partial answer as markdown on each animation frame,
  // so lists and code look right while they arrive, not only at the end.
  let renderFrame = null;
  function renderStreaming() {
    renderFrame = null;
    if (!aiEl) return;
    aiEl.innerHTML = renderMarkdown(aiEl.dataset.raw || '');
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    const last = aiEl.lastElementChild;
    const host = last && last.matches('p, ul, ol') ? (last.matches('ul, ol') ? last.lastElementChild || last : last)
      : last && last.matches('.code-block') ? last.querySelector('code') : aiEl;
    host.appendChild(caretEl);
    keepPinnedInView();
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    if (!renderFrame) renderFrame = requestAnimationFrame(renderStreaming);
  }

  function finalizeAi(note) {
    if (!aiEl) return;
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = null; }
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    if (note) {
      const n = document.createElement('div');
      n.className = 'ai-note';
      n.textContent = note;
      aiEl.appendChild(n);
    }
    const group = aiEl.closest('.response-group');
    if (group && raw.trim() && !group.dataset.noCopy && !group.querySelector('.copy-answer')) {
      const copy = document.createElement('button');
      copy.className = 'copy-answer';
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.title = 'Copy this answer';
      group.appendChild(copy);
    }
    aiEl = null; caretEl = null;
    keepPinnedInView();
  }

  let busyFailsafe = null;
  function setBusy(v) {
    busy = v;
    clearTimeout(busyFailsafe);
    // Failsafe: main has a 25s stream watchdog that always sends llm:done/llm:error, but if a
    // terminal event is ever lost the whole UI stays frozen — self-clear after a generous window.
    if (v) busyFailsafe = setTimeout(() => { busy = false; }, 40000);
  }

  // ---- toast helper ------------------------------------------------------
  // Toast queue system — ensures latest toast wins cleanly without stacking
  let toastTimer = null;
  let toastFadeTimer = null;
  function showToast(message, ms, opts) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('app').appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;
    el.classList.toggle('wrap', !!(opts && opts.wrap));
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  // ---- actions -----------------------------------------------------------
  // A new request replaces the answer in progress (main cancels it), so a new
  // question never waits for an old answer to finish.
  function runMode(mode, text) {
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  // ---- Ask field ---------------------------------------------------------
  // Typing is rare: ✎ Ask opens a one-line field above the footer. It sends
  // what the old composer sent for typed text, an 'ask' request with the
  // question. Speech never fills it.
  const askField = $('#ask-field');
  const askInput = $('#ask-input');
  const askBtn = $('#ask-btn');

  // Sent questions, newest last: Ctrl+Z in the empty field brings one back.
  const questionHistory = [];
  const MAX_QUESTION_HISTORY = 10;
  function saveToQuestionHistory(text) {
    const t = (text || '').trim();
    if (t.length < 5 || questionHistory[questionHistory.length - 1] === t) return;
    questionHistory.push(t);
    while (questionHistory.length > MAX_QUESTION_HISTORY) questionHistory.shift();
  }
  function restoreLastQuestion() {
    const last = questionHistory.pop();
    if (!last) { showToast('No question to restore', 1500); return; }
    askInput.value = last;
  }

  function openAsk() {
    showPanel();
    askField.classList.remove('hidden');
    askBtn.classList.add('on');
    askBtn.setAttribute('aria-expanded', 'true');
    askInput.focus();
  }
  function closeAsk() {
    askField.classList.add('hidden');
    askBtn.classList.remove('on');
    askBtn.setAttribute('aria-expanded', 'false');
    askInput.blur();
  }
  function sendAsk() {
    const text = askInput.value.trim();
    if (text) {
      saveToQuestionHistory(text);
      askInput.value = '';
      runMode('ask', text);
    }
    closeAsk();
  }
  $('#ask-btn').addEventListener('click', () => (askField.classList.contains('hidden') ? openAsk() : closeAsk()));
  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeAsk(); runMode('assist', ''); return; }
    if (e.key === 'Enter') { e.preventDefault(); sendAsk(); return; }
    // Esc closes the field only; it does not also stop the answer being written.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAsk(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !askInput.value) { e.preventDefault(); restoreLastQuestion(); }
  });

  // ---- heard caption helpers (pure; test/renderer-panel.test.js evaluates them)
  function heardCaption(text) {
    return 'Heard: “' + text + '”';
  }
  // ---- end heard caption helpers

  // "Heard: …" above the footer: the other side's latest final line while
  // listening. Your own speech is not echoed.
  const heardEl = $('#heard');
  function showHeard(text) {
    heardEl.textContent = heardCaption(text.trim());
    heardEl.classList.remove('hidden');
  }
  function clearHeard() {
    heardEl.textContent = '';
    heardEl.classList.add('hidden');
  }

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    // Keep this copy (and its revision) current for the next save.
    settings = await cue.settingsSet({ smart: settings.smart });
  });

  // Auto-answer toggle: answer the interviewer as soon as they finish asking
  const autoBtn = $('#auto-toggle');
  function syncAutoButton() {
    autoBtn.classList.toggle('on', !!settings.autoAnswer);
    autoBtn.title = settings.autoAnswer
      ? 'Auto-answer is on: cue answers a question from the other side when they finish asking (while listening)'
      : 'Auto-answer is off: press Enter or the shortcut to answer';
  }
  autoBtn.addEventListener('click', async () => {
    settings.autoAnswer = !settings.autoAnswer;
    syncAutoButton();
    settings = await cue.settingsSet({ autoAnswer: settings.autoAnswer });
    showToast(settings.autoAnswer ? 'Auto-answer on' : 'Auto-answer off', 1500);
  });

  // Hide / collapse
  // Hide shrinks the window to the header (main does the resize), which stays
  // visible. It takes the transcript sidebar with it and brings it back on expand.
  let reopenSidebarOnExpand = false;
  function panelHidden() { return $('#panel').classList.contains('collapsed'); }
  function toggleHide() {
    closePanelMenu();
    closeSetupMenu();
    const collapsed = $('#panel').classList.toggle('collapsed');
    const hideBtn = $('#hide-btn');
    hideBtn.classList.toggle('collapsed', collapsed);
    hideBtn.textContent = collapsed ? 'Show' : 'Hide';
    hideBtn.title = collapsed ? 'Show the panel' : 'Hide the panel';
    renderPresenterStrip();
    if (collapsed) {
      reopenSidebarOnExpand = sidebarOpen;
      if (sidebarOpen) hideSidebar();
    } else if (reopenSidebarOnExpand) {
      showSidebar();
    }
    cue.setHidden(collapsed, Math.ceil($('#header').getBoundingClientRect().height));
  }
  // Screens and menus that open below the header need the panel shown first:
  // main refuses to grow a hidden window.
  function showPanel() { if (panelHidden()) toggleHide(); }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  // Start/stop: "● Listening" while capturing, "Start" otherwise.
  function setCaptureButton(active) {
    const btn = $('#stop-btn');
    btn.classList.toggle('active', active);
    btn.textContent = active ? '● Listening' : 'Start';
    btn.title = active ? 'Stop listening' : 'Start listening';
  }

  // ---- panel menu helpers (pure; test/renderer-panel.test.js evaluates them)
  // Review slides only applies to a presentation setup.
  function menuActionVisible(action, setupKind) {
    return action !== 'review-slides' || setupKind === 'presentation';
  }
  // ---- end panel menu helpers

  // ---- text size helpers (pure; test/renderer-panel.test.js evaluates them)
  // One A−/A+ step from the saved size; `text` is src/panel-layout.js (via preload).
  function stepTextSize(current, direction, text) {
    return text.answerScale(text.answerScale(current) + direction * text.TEXT_STEP);
  }
  // ---- end text size helpers

  // ---- ⋯ menu --------------------------------------------------------------
  const panelMenu = $('#panel-menu');
  const panelText = cue.panelText;
  function closePanelMenu() {
    panelMenu.classList.add('hidden');
    $('#menu-btn').setAttribute('aria-expanded', 'false');
  }
  function renderPanelMenu() {
    const setup = settings && activeSetupOf(settings);
    panelMenu.querySelectorAll('[data-action]').forEach((item) => {
      item.classList.toggle('hidden', !menuActionVisible(item.dataset.action, setup && setup.kind));
    });
    applyTextSize(settings ? settings.answerTextPx : panelText.TEXT_DEFAULT);
  }
  // Text size drives --answer-px on #app; the answers read it (styles.css).
  function applyTextSize(px) {
    const size = panelText.answerScale(px);
    $('#app').style.setProperty('--answer-px', size + 'px');
    $('#text-size-value').textContent = String(size);
    return size;
  }
  async function changeTextSize(direction) {
    if (!settings) return;
    const size = applyTextSize(stepTextSize(settings.answerTextPx, direction, panelText));
    if (size === panelText.answerScale(settings.answerTextPx)) return;
    settings.answerTextPx = size;
    try { await queueSettingsPatch({ answerTextPx: size }); }
    catch (err) { showToast('Could not save the text size', 2000); }
  }
  async function openReviewSlides() {
    if (!activePresentationSetup()) return;
    await openSetupsTab(settings.activeSetupId);
    deckReviewOpen = true;
    renderDeckReview();
  }
  function runMenuAction(action) {
    // Text size keeps the menu open so the new size can be read and stepped again.
    if (action === 'text-smaller') { changeTextSize(-1); return; }
    if (action === 'text-larger') { changeTextSize(1); return; }
    closePanelMenu();
    if (action === 'history') { showPanel(); toggleSidebar(); }
    else if (action === 'sessions') openSessions();
    else if (action === 'settings') openSettings();
    else if (action === 'review-slides') openReviewSlides();
  }
  $('#menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSetupMenu();
    if (!panelMenu.classList.contains('hidden')) { closePanelMenu(); return; }
    showPanel();
    renderPanelMenu();
    panelMenu.classList.remove('hidden');
    $('#menu-btn').setAttribute('aria-expanded', 'true');
  });
  panelMenu.querySelectorAll('[data-action]').forEach((item) => item.addEventListener('click', (e) => {
    e.stopPropagation();
    runMenuAction(item.dataset.action);
  }));
  document.addEventListener('click', (e) => { if (!panelMenu.contains(e.target)) closePanelMenu(); });
  // Global scroll shortcuts: the panel never takes focus, so keys cannot scroll it.
  cue.on('answers:scroll', ({ direction }) => {
    releasePin();
    reading.scrollBy({ top: direction * Math.max(60, reading.clientHeight * 0.8) });
  });
  // Main changed a setting (e.g. the auto-answer shortcut): keep this copy in
  // step so the next Save does not write the old value back.
  cue.on('settings:changed', (patch) => {
    if (!settings) return;
    Object.assign(settings, patch);
    if ('autoAnswer' in patch) syncAutoButton();
    if ('answerTextPx' in patch) applyTextSize(settings.answerTextPx);
    if ('setups' in patch) {
      updateSetupStatus();
      // Main wrote a setup itself (a deck pointer after an import, the save
      // switch): take the saved revision too, or the next Save from Settings
      // is rejected as changed outside this window.
      refreshSettingsRevision();
      renderDeckBlock();
    }
  });

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', async () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) {
      // startSystemAudio may fail (user cancels, no permission) — that's OK,
      // mic will still work and capture will toggle regardless
      try { await startSystemAudio(); } catch (_) { /* handled inside startSystemAudio */ }
    }
    const active = await cue.captureToggle();
    if (turningOn && !active) stopSystemAudio();
  });

  // Transcript toggle removed — sidebar now auto-opens with listening

  // Clear transcript
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', async () => {
      // A draft in the Ask field stays one Ctrl+Z away after clearing.
      saveToQuestionHistory(askInput.value);

      const { savedId } = await cue.clearTranscript();
      clearConversationUI();
      showToast(savedId ? 'Session saved · open Sessions for its summary and debrief' : 'Transcript cleared', 3500);
    });
  }

  // Empties the answers, transcript sidebar, heard caption and Ask field
  // (main has already reset its own copy of the conversation).
  function clearConversationUI() {
    showEmptyState(); // clears the answers and says what to do next
    pinnedGroup = null;
    clearTranscriptSidebar(); // clear the history sidebar too
    clearHeard();
    askInput.value = '';
    closeAsk();
  }

  // ---- capture: mic (renderer side) — uses AudioWorklet (modern, off-main-thread) ----
  let audioCtx = null, micStream = null, micWorklet = null;
  // Generation counter: startMic() awaits getUserMedia, so a second call (or a
  // stopMic()) can land mid-flight. A superseded stream is stopped instead of
  // wired up, so two pipelines never feed the "you" channel and none stays hot.
  let micGen = 0;
  async function startMic() {
    if (micStream) return;
    const gen = ++micGen;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000
        }
      });
      if (gen !== micGen || micStream) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStream = stream;
      // getUserMedia can resolve with a stream that has no usable audio track
      // (e.g. a virtual/placeholder device, or a device that was unplugged
      // between permission grant and capture start). Fail loudly here instead
      // of silently wiring up an AudioWorklet to nothing — that produces the
      // "cue never hears me, no error shown" symptom with no diagnostic at all.
      const [track] = micStream.getAudioTracks();
      if (!track) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        showStatus('No microphone audio track was available. Check Windows Sound settings for a working default input device, then try again.');
        return;
      }
      cue.log('mic stream started: track=' + (track.label || '(no label — permission may be stale)') + ' muted=' + track.muted);
      audioCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for low-latency, off-main-thread processing
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'cue-audio-processor');
        micWorklet.port.onmessage = (e) => {
          cue.micPcm(e.data);
        };
        source.connect(micWorklet);
        // Don't connect to destination — we just capture, don't play
        cue.log('mic AudioWorklet processor attached');
      } catch (workletErr) {
        // Fallback to ScriptProcessor if AudioWorklet fails (shouldn't happen in Electron 33+)
        cue.log('AudioWorklet failed, falling back to ScriptProcessor: ' + workletErr.message);
        const micNode = audioCtx.createMediaStreamSource(micStream);
        const micProc = audioCtx.createScriptProcessor(1024, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
        micProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.micPcm(out.buffer);
        };
        micWorklet = { _legacy: true, proc: micProc, node: micNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const name = err && err.name;
      cue.log('mic error: ' + name + ' — ' + message);
      // getUserMedia's DOMException.name is the reliable signal here — the
      // .message text varies by Chromium version and isn't meant for users.
      // Distinguishing "no device" from "denied" from "in use elsewhere"
      // turns one generic dead end into three different next actions.
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        showStatus('No microphone was found. Plug one in, or pick a default input device in your OS sound settings, then try again.');
      } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        showStatus(isWindows
          ? 'Microphone permission was denied. Settings → Privacy & security → Microphone → allow cue, then try again.'
          : 'Microphone permission was denied. System Settings → Privacy & Security → Microphone → allow cue, then try again.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        showStatus('The microphone could not be started — another application may be using it exclusively. Close other apps using the mic and try again.');
      } else {
        showStatus('Microphone capture could not be started. Check your mic permissions and try again.');
      }
    }
  }
  function stopMic() {
    micGen++; // invalidate any startMic() still waiting on getUserMedia
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else {
        micWorklet.disconnect();
      }
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in cue's process) ----
  let sysStream = null, sysCtx = null, sysWorklet = null, sysStarting = false;
  async function startSystemAudio() {
    // Called both from the stop-btn click (fresh user gesture for getDisplayMedia) and from the
    // capture:state handler. getDisplayMedia is async, so `if (sysStream) return` alone loses the
    // race and can open a second loopback stream that is then orphaned.
    if (sysStream || sysStarting) return;
    // macOS: asking for meeting audio means asking for a display-capture session, and
    // that session puts the OS screen-recording indicator on the menu bar for the whole
    // call. Default to staying invisible; the user opts in in Settings > Audio.
    if (isMac && !(settings && settings.meetingAudio)) {
      cue.log('system audio: meeting audio is off on macOS -- no display-capture session opened');
      showStatus('Meeting audio is off, so cue stays invisible. macOS shows a screen-recording indicator whenever an app captures system audio; turn Meeting audio on in Settings \u203a Audio if you want the other side transcribed.');
      return;
    }
    sysStarting = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      cue.log('system audio unavailable: getDisplayMedia not supported');
      showStatus('Meeting audio capture is not available on this device build.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        cue.log('system audio: no loopback track on this platform');
        stream.getTracks().forEach((t) => t.stop());
        showStatus(cue.platform === 'win32'
          ? 'No system-audio loopback track detected. Make sure "Share audio" is checked in the screen share dialog, and that your audio device is not in exclusive mode.'
          : 'No system-audio loopback track detected. Meeting audio needs macOS 14.4+ — your screen and microphone still work.');
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for system audio too
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'cue-audio-processor');
        sysWorklet.port.onmessage = (e) => {
          cue.systemPcm(e.data);
        };
        source.connect(sysWorklet);
        cue.log('system audio: AudioWorklet capturing loopback');
      } catch (workletErr) {
        // Fallback to ScriptProcessor
        cue.log('system audio AudioWorklet failed, using ScriptProcessor: ' + workletErr.message);
        const sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const sysProc = sysCtx.createScriptProcessor(1024, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
        sysProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.systemPcm(out.buffer);
        };
        sysWorklet = { _legacy: true, proc: sysProc, node: sysNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      cue.log('system audio error: ' + message);
      showStatus('Meeting audio could not be started. Grant screen/audio access to cue and try again.');
    } finally {
      sysStarting = false;
    }
  }
  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else {
        sysWorklet.disconnect();
      }
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- transcript history sidebar (hidden by default, manual toggle) ----
  let tsSidebarInterimEl = null;
  let sidebarOpen = false;
  // Track last committed row per channel — all chunks from same speaker go in one row
  const tsLastRow = { you: null, them: null };
  const tsRowTimer = { you: null, them: null };
  const TS_SENTENCE_GAP_MS = 10000; // 10s silence = new row

  function showSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    if (sidebar) sidebar.classList.remove('hidden');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.add('sidebar-open');
    sidebarOpen = true;
  }

  function hideSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    if (sidebar) sidebar.classList.add('hidden');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.remove('sidebar-open');
    sidebarOpen = false;
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      hideSidebar();
    } else {
      showSidebar();
      // Scroll to bottom when opening sidebar
      const list = document.getElementById('ts-list');
      if (list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    }
  }

  // Close sidebar button
  const closeSidebarBtn = document.getElementById('close-sidebar-btn');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', hideSidebar);
  }

  function appendTranscriptHistoryTurn(channel, text, isInterim) {
    const list = document.getElementById('ts-list');
    if (!list) return;

    // Remove placeholder on first real turn
    const ph = list.querySelector('.ts-placeholder');
    if (ph) ph.remove();

    if (isInterim) {
      // Update the single floating interim row
      if (!tsSidebarInterimEl) {
        tsSidebarInterimEl = document.createElement('div');
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';
        const txt = document.createElement('span');
        txt.className = 'ts-text ts-interim';
        tsSidebarInterimEl.appendChild(chLabel);
        tsSidebarInterimEl.appendChild(txt);
        list.appendChild(tsSidebarInterimEl);
      }
      tsSidebarInterimEl.querySelector('.ts-text').textContent = text;
    } else {
      // Remove interim row
      if (tsSidebarInterimEl) { tsSidebarInterimEl.remove(); tsSidebarInterimEl = null; }

      const existingRow = tsLastRow[channel];
      const useExisting = existingRow && existingRow.isConnected;

      if (useExisting) {
        // Append to existing row — accumulates sentence fragments
        const txt = existingRow.querySelector('.ts-text');
        if (txt) {
          txt.textContent = txt.textContent ? txt.textContent + ' ' + text : text;
        }
      } else {
        // Start a new row (no buttons — just clean history view)
        const row = document.createElement('div');
        row.className = 'ts-turn ts-' + channel;

        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';

        const txt = document.createElement('span');
        txt.className = 'ts-text';
        txt.textContent = text;

        row.appendChild(chLabel);
        row.appendChild(txt);
        list.appendChild(row);
        tsLastRow[channel] = row;
      }

      // Reset silence timer
      clearTimeout(tsRowTimer[channel]);
      tsRowTimer[channel] = setTimeout(() => { tsLastRow[channel] = null; }, TS_SENTENCE_GAP_MS);

      // When THIS channel speaks, reset the OTHER channel's row
      const other = channel === 'you' ? 'them' : 'you';
      clearTimeout(tsRowTimer[other]);
      tsLastRow[other] = null;

      list.scrollTop = list.scrollHeight;
    }
  }

  function clearTranscriptSidebar() {
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    tsSidebarInterimEl = null;
    tsLastRow.you = null; tsLastRow.them = null;
    clearTimeout(tsRowTimer.you); clearTimeout(tsRowTimer.them);
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active }) => {
    setCaptureButton(active);
    // startSystemAudio() is called directly from the stop-button click handler
    // so that the getDisplayMedia request has a fresh user gesture.
    // Here we only start the mic (no gesture required) and stop everything on deactivate.
    if (active) {
      startMic();
      // Don't auto-open sidebar — user can toggle it manually
    } else {
      stopMic();
      stopSystemAudio();
      clearHeard(); // the caption is shown only while listening
      // Don't auto-close sidebar — let user keep it open if they want
    }
  });

  // Live speech goes to the history sidebar only; the panel shows the other
  // side's final lines in the heard caption (the 'transcript' event below).
  cue.on('stt:interim', ({ channel, text }) => {
    appendTranscriptHistoryTurn(channel, text, true); // update sidebar interim
  });
  cue.on('stt:status', ({ channel, status, provider }) => {
    cue.log(`[stt] ${provider || channel || 'unknown'} ${status}`);
    if (provider === 'local') {
      if (status === 'loading') setCaptureButton(true);
      if (status === 'off' || status === 'error') setCaptureButton(false);
    }
  });
  cue.on('slides:update', ({ count, last }) => {
    if (!count) return;
    const title = last && last.caption ? last.caption.split('\n')[0].slice(0, 80) : 'Slide ' + count;
    showToast(`Slide ${count} captured · ${title}`, 3000);
  });
  cue.on('llm:start', ({ id, userBubble, small, mode }) => {
    if (aiEl) finalizeAi('Interrupted');
    currentRequestId = id;
    clearEmptyState();
    archiveLatest(); // the answer on screen moves to Previous answers
    const group = document.createElement('div');
    group.className = 'response-group';
    if (userBubble) {
      // The question as one muted line; the full text is its tooltip.
      const b = document.createElement('div');
      b.className = 'user-bubble';
      b.textContent = userBubble;
      b.title = userBubble;
      group.appendChild(b);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    latest.appendChild(group);
    // Scroll only the reading area (never scrollIntoView: it also scrolls the
    // page itself, which pushed the header out of the window), and keep this
    // answer in view while it streams.
    reading.scrollTop = 0;
    pinnedGroup = aiEl;
    requestAnimationFrame(keepPinnedInView);
    setBusy(true);
    if (mode !== 'practiceQuestion') setPresentationAnswerShown(true);
  });
  const isStale = (id) => id !== undefined && id !== currentRequestId;
  cue.on('llm:token', ({ id, text }) => { if (!isStale(id)) appendToken(text); });
  cue.on('llm:done', ({ id }) => {
    if (isStale(id)) return;
    currentRequestId = null;
    finalizeAi(); setBusy(false);
  });
  cue.on('llm:cancelled', ({ id, reason }) => {
    if (isStale(id)) return;
    currentRequestId = null;
    finalizeAi(reason === 'replaced' ? 'Interrupted by a newer request' : 'Stopped');
    setBusy(false);
  });
  cue.on('llm:error', ({ id, message, action }) => {
    if (isStale(id)) return;
    currentRequestId = null;
    if (!aiEl) { startAi(true); aiEl.closest('.response-group').dataset.noCopy = '1'; } // an error only: nothing to copy
    const errorEl = aiEl;
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
    // A missing key is fixed in Settings: offer that right under the message
    // instead of repeating the message in a status bar.
    if (action && action.kind === 'settings') {
      const open = publikActionButton(action);
      open.className = 'answer-action';
      errorEl.appendChild(open);
      return;
    }
    // publik errors carry one action: the renderer's markdown emits no anchors,
    // so a link needs a real button (same pattern as the mic banner).
    if (action && action.kind === 'card') { showPublikCard(); return; }
    if (action && action.kind) showStatus(message, publikActionButton(action));
  });
  // A conversation resumed after cue stopped unexpectedly: back into the history,
  // without auto-filling the question box from an old turn.
  cue.on('transcript:restore', ({ turns }) => {
    for (const { channel, text } of turns || []) {
      if (text && text.trim().length >= 2) appendTranscriptHistoryTurn(channel, text, false);
    }
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
    // In practice the "interviewer" is cue itself, and its question is already on screen.
    if (practiceActive) return;
    if (channel === 'them' && capturing) showHeard(text);
  });
  let statusTimer = null;
  function showStatus(message, button) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      // Between the reading area and the footer
      $('#panel-main').insertBefore(el, $('#footer'));
    }
    el.textContent = message;
    if (button) el.appendChild(button);
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), button ? 30000 : 11000);
  }
  cue.on('status', ({ message }) => {
    cue.log('[status] ' + message);
    showStatus(message);
  });

  // ---- setup status & smart tooltip helpers ------------------------------


  // ---- AI rules: live char counter + soft cap ---------------------------
  function updateAiRulesCounter() {
    const el = document.getElementById('ai-rules');
    const counter = document.getElementById('ai-rules-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
  }
  const aiRulesEl = document.getElementById('ai-rules');
  if (aiRulesEl) aiRulesEl.addEventListener('input', updateAiRulesCounter);
  let capturing = false;
  function updateSavingIndicator() {
    const setup = settings && activeSetupOf(settings);
    const on = !!(setup && setup.saveSessions && (capturing || practiceActive));
    $('#setup-saving-dot').classList.toggle('hidden', !on);
  }

  let lastActiveSetupId = null;
  function updateSetupStatus() {
    if (!settings) return;
    const setup = activeSetupOf(settings);
    if (!setup) return;
    // The store falls back to "Any conversation" when the active setup is
    // gone (deleted in another window, a bad import); say so once.
    if (lastActiveSetupId && lastActiveSetupId !== setup.id && !(settings.setups || []).some((s) => s.id === lastActiveSetupId)) {
      showToast('The active setup no longer exists; using “' + setup.name + '”.', 3000);
    }
    lastActiveSetupId = setup.id;
    $('#setup-switch-name').textContent = setup.name;
    updateSavingIndicator();
    if (!panelMenu.classList.contains('hidden')) renderPanelMenu();
    renderPresenterStrip();
    return maybeShowPresentationHint();
  }

  const setupMenu = $('#setup-menu');
  const setupSwitchTitle = $('#setup-switch').title;
  function closeSetupMenu() { setupMenu.classList.add('hidden'); }
  function renderSetupMenu() {
    setupMenu.innerHTML = '';
    for (const s of settings.setups || []) {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = s.name;
      item.classList.toggle('on', s.id === settings.activeSetupId);
      item.addEventListener('click', async () => {
        closeSetupMenu();
        if (s.id === settings.activeSetupId) return;
        try {
          settings = await queueSettingsPatch({ activeSetupId: s.id });
          const hinted = updateSetupStatus();
          if (latest.querySelector('.empty-state')) showEmptyState();
          if (!hinted) showToast('Setup: ' + s.name, 1500);
        } catch (err) {
          showToast((err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 3000);
        }
      });
      setupMenu.appendChild(item);
    }
    setupMenu.appendChild(document.createElement('hr'));
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'New setup…';
    add.addEventListener('click', async () => { closeSetupMenu(); await openSetupsTab(); $('#setup-new').click(); });
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.textContent = 'Manage setups…';
    manage.addEventListener('click', () => { closeSetupMenu(); openSetupsTab(); });
    setupMenu.append(add, manage);
  }
  $('#setup-switch').addEventListener('click', (e) => {
    e.stopPropagation();
    closePanelMenu();
    if (setupMenu.classList.contains('hidden')) { showPanel(); renderSetupMenu(); setupMenu.classList.remove('hidden'); }
    else closeSetupMenu();
  });
  document.addEventListener('click', (e) => { if (!setupMenu.contains(e.target)) closeSetupMenu(); });
  cue.on('capture:state', (st) => { capturing = !!(st && st.active); updateSavingIndicator(); });

  function updateSmartTooltip() {
    if (!settings) return;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fast = m.fast || 'fast model';
    const smart = m.smart || 'smart model';
    const btn = document.getElementById('smart-toggle');
    if (btn) btn.title = 'Fast: ' + fast + ' · Smart: ' + smart + ' (higher quality, ~2× slower)';
  }

  // ---- microphone permission banner --------------------------------------
  function showMicPermissionBanner() {
    let banner = document.getElementById('mic-perm-banner');
    if (banner) { banner.classList.add('show'); return; }
    banner = document.createElement('div');
    banner.id = 'mic-perm-banner';
    banner.className = 'show';
    banner.innerHTML =
      '<div class="mic-perm-text">' +
        '<strong>🎙️ Microphone access required</strong><br>' +
        'cue needs microphone permission to hear you during calls. Grant access in System Settings, then restart cue.' +
      '</div>' +
      '<div class="mic-perm-actions"></div>';
    const actions = banner.querySelector('.mic-perm-actions');
    if (cue.platform === 'darwin') {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open Microphone Settings';
      openBtn.addEventListener('click', () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
      actions.appendChild(openBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'dismiss';
    dismissBtn.addEventListener('click', () => banner.classList.remove('show'));
    actions.appendChild(dismissBtn);
    $('#panel-main').insertBefore(banner, $('#footer'));
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  let settingsFormReady = false;
  async function closeSettings() {
    await stopRecording();
    if (await saveSettings()) scrim.classList.add('hidden');
  }
  // Background opacity: the panel, toolbar and history fills (styles.css --panel-alpha).
  // Dragging the slider previews it; the value is saved with the other settings.
  function applyPanelOpacity(value) {
    const n = Number(value);
    const alpha = Number.isFinite(n) ? Math.min(1, Math.max(0.2, n)) : 0.72;
    const percent = Math.round(alpha * 100);
    document.documentElement.style.setProperty('--panel-alpha', String(alpha));
    $('#panel-opacity').value = String(percent);
    $('#panel-opacity-value').textContent = percent + '%';
  }
  $('#panel-opacity').addEventListener('input', (e) => applyPanelOpacity(Number(e.target.value) / 100));

  async function openSettings() {
    showPanel();
    settingsFormReady = false;
    $('#s-close').disabled = true;
    try { settings = await cue.settingsGet(); }
    catch (error) {
      scrim.classList.remove('hidden');
      $('#s-status').textContent = error.message;
      return;
    }
    fillSettings();
    settingsFormReady = true;
    $('#s-close').disabled = false;
    scrim.classList.remove('hidden');
    refreshWhisperModels();
    refreshShortcuts();
  }
  $('#settings-reload').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', () => { void closeSettings(); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) void closeSettings(); });

  // ---- keyboard shortcuts tab ----------------------------------------------
  let shortcutView = null;
  let recordingId = null;
  const SHORTCUT_STATUS_TEXT = {
    taken: 'Another app already uses this combination. Pick a different one.',
    conflict: 'Also assigned to another action above. Pick a different one.',
    invalid: 'This combination cannot be used as a shortcut.',
    inactive: 'Active only while a presentation setup is selected.'
  };

  function keycaps(accelerator) {
    const parts = cue.acceleratorParts(accelerator);
    if (!parts.length) return '<span class="none">Not set</span>';
    return parts.map((p) => '<span class="keycap">' + esc(p) + '</span>').join('');
  }

  function renderShortcuts() {
    const host = $('#shortcut-list');
    if (!host || !shortcutView) return;
    host.innerHTML = '';
    for (const action of shortcutView.actions) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const name = document.createElement('div');
      name.className = 'shortcut-name';
      name.textContent = action.label;
      const statusText = SHORTCUT_STATUS_TEXT[action.status];
      if (statusText) {
        const st = document.createElement('span');
        st.className = 'shortcut-status' + (action.status === 'inactive' ? '' : ' warn');
        st.textContent = statusText;
        name.appendChild(st);
      }
      const keys = document.createElement('button');
      keys.className = 'shortcut-keys' + (recordingId === action.id ? ' recording' : '');
      keys.innerHTML = recordingId === action.id ? 'Press keys…' : keycaps(action.accelerator);
      keys.title = 'Click, then press the new combination';
      keys.addEventListener('click', () => startRecording(action.id));
      const more = document.createElement('div');
      more.className = 'shortcut-more';
      const reset = document.createElement('button');
      reset.className = 's-action';
      reset.textContent = 'Default';
      reset.disabled = action.accelerator === action.defaultAccelerator;
      reset.title = action.defaultAccelerator ? 'Default: ' + cue.formatAccelerator(action.defaultAccelerator) : 'No default shortcut';
      reset.addEventListener('click', async () => { shortcutView = await cue.shortcutsSet(action.id, null); renderShortcuts(); });
      const clear = document.createElement('button');
      clear.className = 's-action';
      clear.textContent = 'Clear';
      clear.disabled = !action.accelerator;
      clear.addEventListener('click', async () => { shortcutView = await cue.shortcutsSet(action.id, ''); renderShortcuts(); });
      more.append(reset, clear);
      row.append(name, keys, more);
      host.appendChild(row);
    }
  }

  async function refreshShortcuts() {
    shortcutView = await cue.shortcutsGet();
    renderShortcuts();
    updateShortcutHints();
  }

  // Global shortcuts would swallow the combination being recorded, so they
  // are released while recording and restored afterwards (main also restores
  // them on its own after 30 s).
  async function startRecording(id) {
    if (recordingId && recordingId !== id) await stopRecording();
    recordingId = id;
    await cue.shortcutsSuspend();
    renderShortcuts();
  }
  async function stopRecording() {
    if (!recordingId) return;
    recordingId = null;
    shortcutView = await cue.shortcutsResume();
    renderShortcuts();
    updateShortcutHints();
  }
  document.addEventListener('keydown', async (e) => {
    if (!recordingId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { await stopRecording(); return; }
    const { accelerator, error } = cue.acceleratorFromEvent({ code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey });
    if (error) { showToast(error, 3000); return; }
    if (!accelerator) return; // a lone modifier: keep listening
    const id = recordingId;
    recordingId = null;
    await cue.shortcutsSet(id, accelerator);
    shortcutView = await cue.shortcutsResume();
    renderShortcuts();
    updateShortcutHints();
  }, true);
  $('#shortcuts-reset').addEventListener('click', async () => {
    recordingId = null;
    shortcutView = await cue.shortcutsReset();
    renderShortcuts();
    updateShortcutHints();
  });
  cue.on('shortcuts:state', (view) => { shortcutView = view; renderShortcuts(); updateShortcutHints(); });

  // Hints elsewhere in the UI show the configured keys, not the defaults.
  function shortcutFor(id) {
    const action = shortcutView && shortcutView.actions.find((a) => a.id === id);
    return action && action.status === 'ok' ? action.accelerator : '';
  }
  // The footer buttons carry their shortcuts in their titles.
  function updateShortcutHints() {
    applyModeLabels();
  }

  // Tab switching
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      if (tab.classList.contains('on')) return;
      await stopRecording();
      if (!(await saveSettings())) return;
      document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('on');
      const pane = document.querySelector(`.s-tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.remove('hidden');
    });
  });

  function updateCustomProviderFields() {
    $('#custom-endpoint-settings').classList.toggle('hidden', settings.provider !== 'custom');
    $('#publik-settings').classList.toggle('hidden', settings.provider !== 'publik');
    renderPublikBlock();
  }

  // ---- publik API (packaged-build default) --------------------------------
  function publikActionButton(action) {
    if (!action || !action.kind) return null;
    const btn = document.createElement('button');
    if (action.kind === 'link' && action.url) {
      btn.textContent = action.label || 'Open publikhq.com';
      btn.addEventListener('click', () => cue.publikOpen(action.url));
    } else if (action.kind === 'reconnect') {
      btn.textContent = action.label || 'Reconnect';
      btn.addEventListener('click', async () => { btn.disabled = true; publikState = await cue.publikReconnect(); renderPublikBlock(); });
    } else if (action.kind === 'disclosure') {
      btn.textContent = 'Set up publik API';
      btn.addEventListener('click', () => showPublikDisclosure());
    } else if (action.kind === 'card') {
      btn.textContent = 'Show the publik API card';
      btn.addEventListener('click', () => showPublikCard());
    } else if (action.kind === 'settings') {
      btn.textContent = 'Open Settings';
      btn.addEventListener('click', () => openSettings());
    } else {
      return null;
    }
    return btn;
  }

  // Low starter (CONTRACT §12 / task 3): one non-blocking banner with one
  // link, once per key while it sits below the 20% line — not on every push.
  let lowStarterNoticedFor = null;
  function maybeShowLowStarter(p) {
    if (!p || !p.lowStarter) { lowStarterNoticedFor = null; return; }
    if (lowStarterNoticedFor === p.keyId) return;
    lowStarterNoticedFor = p.keyId;
    showStatus(p.lowStarter.message, publikActionButton(p.lowStarter.action));
  }

  function selectByoProvider() {
    const openaiBtn = document.querySelector('#provider-seg button[data-provider="openai"]');
    if (openaiBtn) openaiBtn.click();
    $('#key-openai').focus();
  }

  function renderPublikBlock() {
    const p = publikState;
    const block = $('#publik-settings');
    if (!block || !p || !settings) return;
    const show = (id, on) => $(id).classList.toggle('hidden', !on);
    $('#publik-cost-note').textContent = p.copy.cost;
    $('#publik-data-note').textContent = p.copy.dataPath;
    const note = $('#publik-status-note');
    note.classList.remove('warn');
    let line;
    if (p.connected && p.revoked) {
      line = 'publik API key was revoked. Reconnect to set this computer up again.'; note.classList.add('warn');
    } else if (p.connected) {
      line = `Connected · key ${p.keyId} · ${p.line || 'Ready'}`;
    } else if (p.disconnected) {
      line = 'publik API is disconnected. This computer was removed from your publik account.'; note.classList.add('warn');
    } else if (!p.disclosureAccepted) {
      line = 'Not set up yet — no key needed to set it up.';
    } else if (p.lastError) {
      line = p.lastError; note.classList.add('warn');
    } else {
      line = 'Connecting…';
    }
    note.textContent = line;
    // Low starter: the same sentence the banner used, kept on the card.
    const low = $('#publik-low-note');
    low.textContent = p.lowStarter ? p.lowStarter.message : '';
    low.classList.toggle('hidden', !p.lowStarter);
    // "Why it costs money" — the one justification sentence (CONTRACT §12).
    $('#publik-why-summary').textContent = p.copy.whyItCostsToggle;
    $('#publik-why-text').textContent = p.copy.whyItCosts;
    // The primary button (CONTRACT §12.2): "Link this computer & pick a plan"
    // while anonymous, "Pick a plan" / "Manage plan" once claimed.
    const cta = p.settingsCta;
    $('#publik-link').textContent = cta ? cta.label : '';
    show('#publik-setup', !p.connected && !p.disclosureAccepted);
    show('#publik-reconnect', p.disclosureAccepted && (!p.connected || p.revoked));
    show('#publik-link', !!cta);
    show('#publik-add-credit', p.connected && !p.revoked && p.claimState === 'claimed' && !!p.addCreditUrl);
    show('#publik-disconnect', p.connected && !p.revoked);
    $('#provider-publik').classList.toggle('hidden', !p.available);
    if (settings.provider === 'publik') $('#s-status').textContent = statusText();
  }
  $('#publik-setup').addEventListener('click', () => showPublikDisclosure());
  $('#publik-link').addEventListener('click', () => { const cta = publikState && publikState.settingsCta; if (cta) cue.publikOpen(cta.url); });
  $('#publik-add-credit').addEventListener('click', () => cue.publikOpen(publikState && publikState.addCreditUrl));
  $('#publik-pricing').addEventListener('click', () => cue.publikOpen(publikState ? publikState.links.pricing : ''));
  $('#publik-reconnect').addEventListener('click', async () => { $('#publik-reconnect').disabled = true; try { publikState = await cue.publikReconnect(); } finally { $('#publik-reconnect').disabled = false; } renderPublikBlock(); });
  $('#publik-disconnect').addEventListener('click', async () => { publikState = await cue.publikDisconnect(); renderPublikBlock(); });
  $('#publik-byo').addEventListener('click', selectByoProvider);
  cue.on('publik:state', (state) => { publikState = state; renderPublikBlock(); maybeShowLowStarter(state); });

  function fillSettings() {
    $('#settings-location').textContent = settings.settingsMeta?.file || 'Settings location unavailable';
    const providers = settings.settingsMeta?.keyProviders || [];
    $('#settings-keys-present').textContent = providers.length ? `Saved credentials / endpoints: ${providers.join(', ')}` : 'No saved credentials / endpoints';
    // Keys tab
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    $('#key-custom').value = settings.apiKeys.custom || '';
    $('#base-url').value = settings.baseUrl || '';
    updateCustomProviderFields();
    $('#key-ollama').value = settings.apiKeys.ollama || '';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-minimax').value = settings.apiKeys.minimax || '';
    $('#key-deepseek').value = settings.apiKeys.deepseek || '';
    $('#key-cerebras').value = settings.apiKeys.cerebras || '';
    document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.classList.toggle('on', b.dataset.region === (settings.minimaxRegion || 'global_en')));
    $('#key-azure').value = settings.apiKeys.azure || '';
    $('#azure-endpoint').value = settings.azureEndpoint || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    fillAppLinkCallers();
    $('#s-status').textContent = statusText();
    // Transcription tab
    document.querySelectorAll('#meeting-audio-seg button').forEach((button) => {
      button.classList.toggle('on', (button.dataset.meetingAudio === 'on') === !!settings.meetingAudio);
    });
    const meetingAudioNote = $('#meeting-audio-note');
    if (meetingAudioNote) {
      meetingAudioNote.textContent = isMac
        ? 'macOS can only capture system audio through a screen-capture session. While this is on, the menu bar shows the screen-recording indicator and Control Center lists cue under \u201cCurrently Sharing\u201d \u2014 visible to everyone you screen-share with. Off by default; your microphone, screen capture and answers are unaffected.'
        : 'Transcribes the other participants alongside your microphone. This platform\u2019s loopback capture shows no recording indicator.';
    }
    document.querySelectorAll('#stt-provider-seg button').forEach((button) => {
      button.classList.toggle('on', button.dataset.sttProvider === (settings.sttProvider || 'auto'));
    });
    const localWhisper = settings.localWhisper || { modelId: 'base.en', language: 'auto', threads: 0 };
    const languageSelect = $('#stt-language');
    if (!languageSelect.options.length) {
      for (const [code, name] of cue.sttLanguages.list) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        languageSelect.appendChild(option);
      }
    }
    languageSelect.value = cue.sttLanguages.resolve(settings);
    $('#whisper-threads').value = Number(localWhisper.threads) || 0;
    const slidesCfg = settings.slides || { enabled: false, intervalMs: 3000 };
    $('#slides-enabled').checked = !!slidesCfg.enabled;
    $('#slides-interval').value = slidesCfg.intervalMs || 3000;
    fillAboutMe();
    fillSetupForm(editingSetupId || settings.activeSetupId);
    // Style tab
    $('#ai-rules').value = settings.aiRules || '';
    $('#answer-length').value = ['brief', 'balanced', 'detailed'].includes(settings.answerLength) ? settings.answerLength : 'brief';
    applyPanelOpacity(settings.panelOpacity);
    $('#include-screen').value = settings.includeScreen === false ? 'no' : 'yes';
    $('#warm-up').value = settings.warmUp === false ? 'off' : 'on';
    updateAiRulesCounter();
  }

  // Whoever cue has been told it may answer questions for. Empty is the normal
  // state — nothing appears here until something has asked and been allowed.
  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !cue.appLinkState) return;
    let state;
    try { state = await cue.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '<div class="s-caller-empty">Nothing has asked yet.</div>';
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => (scope === 'action' ? 'control' : 'read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : 'denied');
      label.title = id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Forget';
      button.addEventListener('click', async () => {
        await cue.appLinkRevoke(id);
        fillAppLinkCallers();
      });
      row.append(label, button);
      host.append(row);
    }
  }

  const uploadResumeBtn = document.getElementById('upload-resume-btn');
  if (uploadResumeBtn) uploadResumeBtn.addEventListener('click', async () => {
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Resume import failed: ' + res.error); return; }
    $('#resume-text').value = res.text || '';
    showStatus('Imported ' + res.fileName + ' — press Save to keep it.');
  });
  const uploadJdBtn = document.getElementById('upload-jd-btn');
  if (uploadJdBtn) uploadJdBtn.addEventListener('click', async () => {
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Job description import failed: ' + res.error); return; }
    $('#job-description').value = res.text || '';
    showStatus('Imported ' + res.fileName + ' — press Save to keep it.');
  });

  function statusText() {
    const k = settings.apiKeys;
    const labels = { publik: 'publik API', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepgram: 'Deepgram', custom: 'Custom', ollama: 'Ollama', groq: 'Groq', minimax: 'MiniMax', deepseek: 'DeepSeek', cerebras: 'Cerebras', azure: 'Azure AI Foundry' };
    const has = Object.keys(labels).filter((p) => k[p]).map((p) => labels[p]);
    const publikPart = settings.provider === 'publik' && publikState
      ? ` · ${publikState.connected ? (publikState.balanceLabel ? `balance ${publikState.balanceLabel}` : 'connected') : 'not set up'}`
      : '';
    // 'auto' walks the same fallback chain src/stt.js builds; an explicit choice
    // is reported as-is so the status line matches what will actually be used.
    const selectedSttProvider = settings.sttProvider || 'auto';
    const automaticStt = k.deepgram ? 'Deepgram (streaming)' : (k.openai ? 'OpenAI Realtime' : (k.groq ? 'Groq Whisper' : (k.gemini ? 'Gemini (batch)' : 'none')));
    const stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
    const setup = activeSetupOf(settings);
    return `${labels[settings.provider] || settings.provider}${publikPart} · STT: ${stt}` + (setup ? ' · setup: ' + setup.name : '');
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    updateSmartTooltip();
  }));
  document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.minimaxRegion = b.dataset.region;
    document.querySelectorAll('#minimax-region-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.querySelectorAll('#meeting-audio-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.meetingAudio = button.dataset.meetingAudio === 'on';
    document.querySelectorAll('#meeting-audio-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
  }));

  document.querySelectorAll('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    document.querySelectorAll('#stt-provider-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
    $('#s-status').textContent = statusText();
  }));

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function getSelectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function renderWhisperModelState() {
    const model = getSelectedWhisperModel();
    if (!model) return;
    const language = model.englishOnly ? 'English only' : 'Multilingual';
    const recommendation = model.recommended ? ' · recommended default' : '';
    const partial = model.partialBytes > 0 && !model.installed
      ? ` · ${formatBytes(model.partialBytes)} ready to resume`
      : '';
    $('#whisper-model-detail').textContent = `${formatBytes(model.bytes)} · ${language} · ${model.quantization} · ${model.hardwareTier}${recommendation}${partial}`;

    const progressWrap = $('#whisper-progress-wrap');
    const progressPercent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = progressPercent;
    $('#whisper-progress-label').textContent = `${progressPercent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = model.installed ? 'Installed' : (model.partialBytes ? 'Resume' : 'Download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previousSelection = $('#whisper-model').value || settings.localWhisper?.modelId || 'base.en';
      whisperOverview = await cue.whisperModels();
      const runtimeBadge = $('#whisper-runtime-status');
      runtimeBadge.classList.toggle('ready', whisperOverview.runtime.available);
      runtimeBadge.classList.toggle('error', !whisperOverview.runtime.available);
      runtimeBadge.textContent = whisperOverview.runtime.available
        ? `Ready · v${whisperOverview.runtime.version} · ${whisperOverview.runtime.target}`
        : 'Not prepared';
      runtimeBadge.title = whisperOverview.runtime.message || '';

      const select = $('#whisper-model');
      select.innerHTML = '';
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}${model.recommended ? ' (recommended)' : ''}${model.installed ? ' ✓' : ''}`;
        select.appendChild(option);
      }
      const selectionExists = whisperOverview.models.some((model) => model.id === previousSelection);
      select.value = selectionExists ? previousSelection : 'base.en';
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = whisperOverview.runtime.available
        ? 'Model files are verified before they can be loaded.'
        : whisperOverview.runtime.message;
      renderWhisperModelState();
    } catch (error) {
      status.textContent = `Could not load local model information: ${error.message}`;
    }
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    renderWhisperModelState();
  });

  $('#whisper-download').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    renderWhisperModelState();
    $('#whisper-status').textContent = `Downloading ${model.id}. You can cancel and resume later.`;
    try {
      await cue.whisperModelDownload(model.id);
      $('#whisper-status').textContent = `${model.id} downloaded and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = error.message.includes('cancelled')
        ? `${model.id} download paused. Progress was kept.`
        : `Download failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-cancel').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (model) await cue.whisperModelCancel(model.id);
  });

  $('#whisper-import').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    $('#whisper-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await cue.whisperModelImport(model.id);
      $('#whisper-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-delete').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model || !window.confirm(`Delete the ${model.id} model (${formatBytes(model.bytes)}) from this computer?`)) return;
    try {
      await cue.whisperModelDelete(model.id);
      $('#whisper-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#whisper-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  cue.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
      $('#whisper-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
    }
  });
  cue.on('whisper:models-changed', () => refreshWhisperModels());

  // Saves run one at a time. Tab switches and Done each save the form; two
  // overlapping saves carried the same settings revision, so the second was
  // rejected as "changed outside this window" and its tab switch was lost.
  // Queued, each save starts after the previous one and sends the revision
  // that save returned.
  let saveQueue = Promise.resolve();
  function saveSettings() {
    const run = saveQueue.then(saveSettingsNow, saveSettingsNow);
    saveQueue = run.catch(() => {});
    return run;
  }

  // A small patch (for example the active setup) through the same queue as full saves.
  // No settingsMeta: a one-field patch cannot clobber other fields, and writes
  // that do not refresh this copy (Smart, Auto, the auto-answer shortcut, the
  // export folder) would otherwise make its revision stale and get it rejected.
  // The store repairs an active id that no longer exists.
  function queueSettingsPatch(patch) {
    const run = saveQueue.then(() => cue.settingsSet({ ...patch }));
    saveQueue = run.catch(() => {});
    return run;
  }

  // Takes the saved revision after main wrote settings this copy already
  // merged (settings:changed). Queued, so a save waiting behind it sends it.
  function refreshSettingsRevision() {
    const run = saveQueue.then(async () => {
      const fresh = await cue.settingsGet();
      if (settings && fresh) settings.settingsMeta = fresh.settingsMeta;
    });
    saveQueue = run.catch(() => {});
    return run;
  }

  // ---- presentation helpers (pure; test/renderer-presentation.test.js evaluates them)
  // One entry per non-empty line.
  function parseLines(text) {
    return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  function deckStatusText({ fileName, slideCount, done, total, failed }) {
    const count = Number(slideCount) || 0;
    const parts = [fileName, count + (count === 1 ? ' slide' : ' slides')];
    if (total > 0 && done < total) {
      parts.push('Talking points: generating… ' + done + ' of ' + total + (total === 1 ? ' batch' : ' batches'));
    } else if (failed > 0) {
      parts.push(failed + (failed === 1 ? ' slide' : ' slides') + ' not generated');
    }
    return parts.join(' · ');
  }
  // Time left as m:ss, never below 0:00.
  function formatTimeLeft(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  function pacingChip(pacing) {
    const status = pacing && pacing.status;
    const minutes = (pacing && pacing.minutes) || 0;
    if (status === 'on') return '✓ on track';
    if (status === 'ahead') return '▲ ahead ' + minutes + ' min';
    if (status === 'behind') return '▼ behind ' + minutes + ' min';
    return '';
  }
  // The header's status while the panel is hidden: pacing and time left.
  function headerStatus(update) {
    if (!update || !update.snapshot) return '';
    const snap = update.snapshot;
    const pace = snap.offDeck ? 'off-deck' : pacingChip(snap.pacing);
    return [pace, formatTimeLeft(snap.remainingMs)].filter(Boolean).join(' · ');
  }
  // First line of the presenter strip; empty without a deck.
  function stripStatusLine(update) {
    const snap = (update && update.snapshot) || {};
    const count = snap.slideCount || 0;
    if (!count) return '';
    const slide = update.slide;
    let line = 'Slide ' + (slide ? slide.n : '–') + ' / ' + count;
    if (slide && slide.title) line += ' · ' + slide.title;
    if (snap.offDeck) line += ' · off-deck';
    else if (update.matching === 'failed' || update.matching === 'disabled') line += ' · ?';
    return line;
  }
  // While an answer is shown the talking points shrink to their first bullet.
  function visiblePoints(points, answerShown) {
    const list = Array.isArray(points) ? points : [];
    // The panel has a fixed height: while an answer is on screen the strip
    // keeps only its status line so the answer is readable, not one line.
    return answerShown ? [] : list.slice();
  }
  // Watch display picker: shown with more than one display, or to clear a
  // saved display that is not connected (main then watches the primary).
  function displayOptions(displays, watchDisplayId) {
    const list = Array.isArray(displays) ? displays : [];
    const saved = String(watchDisplayId || '');
    const missing = !!saved && !list.some((d) => String(d.id) === saved);
    const options = [{ value: '', label: 'Primary display' }];
    for (const d of list) options.push({ value: String(d.id), label: d.label + ' · ' + d.width + '×' + d.height });
    if (missing) options.push({ value: saved, label: 'Not connected' });
    return { show: list.length > 1 || missing, missing, options };
  }
  // A streaming presentation debrief ends with a ```json block of questions:
  // show only the prose, including while a fence is still arriving.
  function debriefDisplayText(raw) {
    const text = String(raw || '');
    const at = text.toLowerCase().lastIndexOf('```json');
    const prose = at >= 0 ? text.slice(0, at) : text.replace(/`{1,3}(j(s(on?)?)?)?$/i, '');
    return prose.trimEnd();
  }
  // The question list is offered only while the session's setup still exists,
  // is a presentation setup, and has a deck.
  function canAddDebriefQuestions(session, setups) {
    const questions = session && Array.isArray(session.debriefQuestions) ? session.debriefQuestions : [];
    if (!questions.length) return false;
    const setup = (Array.isArray(setups) ? setups : []).find((s) => s.id === session.setupId);
    return !!(setup && setup.kind === 'presentation' && setup.deck);
  }
  // ---- end presentation helpers

  // ---- mode label
  function modeLabel(mode, setupKind) {
    if (setupKind === 'presentation') {
      if (mode === 'say') return 'Answer audience';
      if (mode === 'followup') return 'Ask the room';
    }
    return { say: 'What should I say?', followup: 'Follow-up', assist: 'Assist', recap: 'Recap' }[mode] || '';
  }
  // ---- end mode label

  // ---- action titles
  // The name comes first (a compact button shows only its icon), then the
  // shortcut and, for the two main actions, what they do.
  function actionTitle(mode, setupKind, accelerator) {
    const name = modeLabel(mode, setupKind) + (accelerator ? ' (' + accelerator + ')' : '');
    if (mode === 'say') return name + ' · Suggests what to say next based on the conversation';
    if (mode === 'assist') return name + ' · Scans your screen and conversation to decide what you need';
    return name;
  }
  // ---- end action titles

  function applyModeLabels() {
    const setup = settings && activeSetupOf(settings);
    for (const mode of ['say', 'assist', 'followup', 'recap']) {
      const btn = document.querySelector('.act[data-mode="' + mode + '"]');
      if (!btn) continue;
      const keys = shortcutFor(mode); // only say and assist have one
      btn.querySelector('.lbl').textContent = modeLabel(mode, setup && setup.kind);
      btn.title = actionTitle(mode, setup && setup.kind, keys ? cue.formatAccelerator(keys) : '');
    }
    fitActionRow();
  }

  // The footer never wraps: when the row would overflow, Assist, Follow-up
  // and Recap drop their labels (their titles keep the names).
  function fitActionRow() {
    const row = $('#action-row');
    row.classList.remove('compact');
    row.classList.toggle('compact', row.scrollWidth > row.clientWidth);
  }
  new ResizeObserver(fitActionRow).observe($('#action-row'));

  // ---- presenter strip, header status and first-use hint ------------------
  // main sends presentation:update only while listening with a presentation
  // setup; the last one stays on screen after listening stops.
  let presentationUpdate = null;
  let presentationUpdateKey = '';
  let presentationAnswerShown = false;
  let presentationSlideN = null;
  let presentationFlagsOpen = false;

  function activePresentationSetup() {
    const setup = settings && activeSetupOf(settings);
    return setup && setup.kind === 'presentation' ? setup : null;
  }
  // An update belongs to one setup and one import of its deck.
  function presentationKey(setup) {
    return setup.id + '|' + (setup.deck ? setup.deck.importedAt : '');
  }
  // Before the first update: no slide yet, the full planned time.
  function idlePresentationUpdate(setup) {
    const count = setup.deck ? setup.deck.slideCount : 0;
    return {
      snapshot: { current: null, slideCount: count, offDeck: false, remainingMs: (setup.durationMin || 45) * 60000, pacing: { status: count ? 'on' : 'none', minutes: 0 }, skipped: [], flags: [], timeline: [] },
      slide: null,
      next: null,
      matching: 'ok'
    };
  }

  function renderPresenterStrip() {
    applyModeLabels();
    const strip = $('#presenter-strip');
    const headerStatusEl = $('#header-status');
    const setup = activePresentationSetup();
    if (!setup) {
      strip.classList.add('hidden');
      headerStatusEl.classList.add('hidden');
      return;
    }
    const update = presentationUpdate && presentationUpdateKey === presentationKey(setup) ? presentationUpdate : idlePresentationUpdate(setup);
    const snap = update.snapshot || {};
    const hasDeck = (snap.slideCount || 0) > 0;
    const slideN = update.slide ? update.slide.n : null;
    if (slideN !== presentationSlideN) {
      presentationSlideN = slideN;
      presentationAnswerShown = false;
    }
    $('#ps-status').textContent = stripStatusLine(update);
    $('#ps-time').textContent = formatTimeLeft(snap.remainingMs) + ' left';
    const pace = $('#ps-pace');
    pace.textContent = pacingChip(snap.pacing);
    pace.className = 'ps-pace ' + ((snap.pacing && snap.pacing.status) || '');
    const points = $('#ps-points');
    points.innerHTML = '';
    if (hasDeck && update.slide) {
      for (const text of visiblePoints(update.slide.points, presentationAnswerShown)) {
        const li = document.createElement('li');
        li.textContent = text;
        points.appendChild(li);
      }
    }
    $('#ps-next').textContent = hasDeck && update.next ? 'next → ' + update.next.n + ' · ' + update.next.title : '';
    const flags = Array.isArray(snap.flags) ? snap.flags : [];
    const flagsEl = $('#ps-flags');
    flagsEl.classList.toggle('hidden', !flags.length);
    if (!flags.length) presentationFlagsOpen = false;
    flagsEl.textContent = presentationFlagsOpen
      ? flags.map((f) => '⚑ ' + f).join('\n')
      : (flags.length ? '⚑ ' + flags[flags.length - 1] : '');
    flagsEl.title = presentationFlagsOpen ? 'Show the newest flag only' : 'Show all flags';
    // While an answer is on screen the strip keeps only its status line and
    // first point, so the answer gets the room in the fixed-height panel.
    strip.classList.toggle('answering', presentationAnswerShown);
    strip.classList.remove('hidden');
    const status = headerStatus(update);
    headerStatusEl.textContent = status;
    headerStatusEl.className = 'header-status ' + ((snap.pacing && snap.pacing.status) || '');
    headerStatusEl.classList.toggle('hidden', !status || !panelHidden());
  }
  $('#ps-flags').addEventListener('click', () => {
    presentationFlagsOpen = !presentationFlagsOpen;
    renderPresenterStrip();
  });
  cue.on('presentation:update', (update) => {
    const setup = activePresentationSetup();
    if (!setup || !update || !update.snapshot) return;
    presentationUpdate = update;
    presentationUpdateKey = presentationKey(setup);
    renderPresenterStrip();
  });
  // An answer on screen shrinks the talking points to their first bullet.
  function setPresentationAnswerShown(shown) {
    if (presentationAnswerShown === shown) return;
    presentationAnswerShown = shown;
    if (activePresentationSetup()) renderPresenterStrip();
  }

  // Once per setup, the first time it is the active one.
  const presentationHintsShown = new Set();
  function maybeShowPresentationHint() {
    const setup = activePresentationSetup();
    if (!setup || presentationHintsShown.has(setup.id)) return false;
    presentationHintsShown.add(setup.id);
    const key = 'cue.presentationHint.' + setup.id;
    try {
      if (window.localStorage.getItem(key)) return false;
      window.localStorage.setItem(key, '1');
    } catch (_) { /* storage unavailable: shown once per run */ }
    showToast('Share a window (your slideshow), not your whole screen, and keep cue on your laptop display.', 8000, { wrap: true });
    return true;
  }

  // ---- About me and setups (data model: src/setups.js) --------------------
  const setupsModel = cue.setupsModel;
  let editingSetupId = null;

  function activeSetupOf(s) {
    const list = (s && s.setups) || [];
    return list.find((x) => x.id === s.activeSetupId) || list.find((x) => x.id === setupsModel.BUILTIN_SETUP_ID) || list[0];
  }
  function editingSetup() {
    return settings.setups.find((x) => x.id === editingSetupId) || activeSetupOf(settings);
  }

  function fillAboutMe() {
    const a = settings.aboutMe || {};
    $('#resume-text').value = a.resumeText || '';
    $('#star-stories').value = a.stories || '';
    $('#work-style').value = a.workStyle || '';
    renderAboutMeWarning();
  }

  // About me goes to every setup: point out lines that look written for one.
  function renderAboutMeWarning() {
    const box = $('#about-me-warning');
    if (!box) return;
    const aboutMe = { resumeText: $('#resume-text').value, stories: $('#star-stories').value, workStyle: $('#work-style').value };
    const found = setupsModel.findSetupSpecificLines(aboutMe, settings.setups || [], { builtinId: setupsModel.BUILTIN_SETUP_ID });
    box.textContent = '';
    box.classList.toggle('hidden', !found.length);
    if (!found.length) return;
    const head = document.createElement('strong');
    head.textContent = found.length === 1 ? '1 line looks specific to one setup' : found.length + ' lines look specific to one setup';
    box.appendChild(head);
    const list = document.createElement('ul');
    for (const hit of found.slice(0, 6)) {
      const item = document.createElement('li');
      const quote = hit.text.length > 70 ? hit.text.slice(0, 70) + '…' : hit.text;
      item.textContent = hit.label + ', line ' + hit.line + ': "' + quote + '" (' + hit.reason + ')';
      list.appendChild(item);
    }
    box.appendChild(list);
    const tail = document.createElement('div');
    tail.textContent = (found.length > 6 ? 'And ' + (found.length - 6) + ' more. ' : '') + 'If it only applies to one conversation, move it to that setup\'s Notes.';
    box.appendChild(tail);
  }
  for (const id of ['#resume-text', '#star-stories', '#work-style']) $(id).addEventListener('input', renderAboutMeWarning);

  function applyKindToForm(kind) {
    const interview = kind === 'interview';
    const presentation = kind === 'presentation';
    document.querySelectorAll('#setup-kind-seg button').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
    document.querySelectorAll('[data-pane="setups"] .interview-only').forEach((el) => el.classList.toggle('hidden', !interview));
    document.querySelectorAll('[data-pane="setups"] .presentation-only').forEach((el) => el.classList.toggle('hidden', !presentation));
    $('#setup-conversation-label').textContent = interview ? 'Job description' : presentation ? 'Talk and audience' : 'This conversation and your role';
    $('#job-description').placeholder = interview
      ? 'Paste the job description for the role.'
      : presentation
        ? 'e.g. Intro to graph algorithms, 2nd-year CS students, comfortable with Python.'
        : 'e.g. Weekly platform sync; I lead the API work and give the status update.';
    $('#setup-kind-note').textContent = interview
      ? 'Tuned for job interviews: answers as the candidate, practice interviews available.'
      : presentation
        ? 'For giving a talk: cue keeps talking points for each slide and helps with audience questions.'
        : 'Works in any conversation: cue works out the situation from what it hears and answers for your role.';
    if (presentation) renderDeckBlock();
  }

  // ---- presentation deck: import, status and the slide editor ------------
  const deckProgress = new Map(); // setupId -> { done, total } from deck:progress
  let deckView = null;            // { setupId, deck } shown in the deck block
  let deckLoadToken = 0;
  let deckReviewOpen = false;
  let deckRowsKey = '';           // which deck the review rows were built for
  const deckExpanded = new Set(); // slide numbers whose editor is open

  function formKind() {
    const on = document.querySelector('#setup-kind-seg button.on');
    return on ? on.dataset.kind : null;
  }
  // Slides an import left for enrichment (mirrors src/deck-import.js).
  function deckPending(deck) {
    return deck.slides.filter((s) => !s.edited && !s.enrichError && !s.points.length && !s.questions.length && !s.keyIdea).length;
  }
  function showDeckError(message) {
    const status = $('#deck-status');
    status.textContent = message;
    status.classList.add('error');
  }
  function setDeckStatus() {
    if (!deckView) return;
    const { setupId, deck } = deckView;
    const progress = deckProgress.get(setupId) || {};
    const status = $('#deck-status');
    status.classList.remove('error');
    status.textContent = deckStatusText({
      fileName: deck.source.fileName,
      slideCount: deck.slides.length,
      done: progress.done,
      total: progress.total,
      failed: deck.slides.filter((s) => s.enrichError).length
    });
  }

  // Shows the editing setup's deck. Safe to call any time: it does nothing
  // unless the Settings form is showing a presentation setup.
  async function renderDeckBlock() {
    if (!settings || !settings.setups || formKind() !== 'presentation') return;
    const setup = editingSetup();
    if (!setup) return;
    const token = ++deckLoadToken;
    if (!setup.deck) {
      deckView = null;
      const status = $('#deck-status');
      status.classList.remove('error');
      status.textContent = 'No deck yet · import a PPTX or PDF';
      $('#deck-review').disabled = true;
      renderDeckReview();
      return;
    }
    let deck = null;
    try { deck = await cue.deckGet(setup.id); } catch (_) { deck = null; }
    if (token !== deckLoadToken) return;
    if (!deck) {
      deckView = null;
      showDeckError('Deck file missing — import it again');
      $('#deck-review').disabled = true;
      renderDeckReview();
      return;
    }
    deckView = { setupId: setup.id, deck };
    $('#deck-review').disabled = false;
    setDeckStatus();
    renderDeckReview();
  }

  function renderDeckReview() {
    const panel = $('#deck-review-panel');
    const list = $('#deck-review-list');
    $('#deck-review').textContent = deckReviewOpen && deckView ? 'Hide slides' : 'Review slides';
    panel.classList.toggle('hidden', !deckReviewOpen || !deckView);
    if (!deckView) { list.textContent = ''; deckRowsKey = ''; return; }
    if (!deckReviewOpen) return;
    const { setupId, deck } = deckView;
    const key = setupId + '|' + deck.source.sha256 + '|' + deck.slides.map((s) => s.n).join(',');
    if (key !== deckRowsKey) {
      if (!deckRowsKey.startsWith(setupId + '|')) deckExpanded.clear();
      list.textContent = '';
      for (const slide of deck.slides) list.appendChild(buildDeckRow(setupId, slide.n));
      if (!deck.slides.length) {
        const empty = document.createElement('div');
        empty.className = 'deck-review-empty';
        empty.textContent = 'This deck has no slides.';
        list.appendChild(empty);
      }
      deckRowsKey = key;
    }
    for (const row of list.querySelectorAll('.deck-slide')) {
      const slide = deck.slides.find((s) => s.n === Number(row.dataset.n));
      if (slide) syncDeckRow(row, slide);
    }
  }

  function currentSlide(setupId, n) {
    return deckView && deckView.setupId === setupId ? deckView.deck.slides.find((s) => s.n === n) : null;
  }

  function deckLabel(text, hint) {
    const el = document.createElement('div');
    el.className = 's-label';
    el.textContent = text;
    if (hint) {
      const h = document.createElement('span');
      h.className = 's-hint';
      h.textContent = hint;
      el.appendChild(h);
    }
    return el;
  }

  function buildDeckRow(setupId, n) {
    const row = document.createElement('div');
    row.className = 'deck-slide';
    row.dataset.n = String(n);
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'deck-slide-head';
    const title = document.createElement('span');
    title.className = 'deck-slide-title';
    const tags = document.createElement('span');
    tags.className = 'deck-slide-tags';
    head.append(title, tags);
    const body = document.createElement('div');
    body.className = 'deck-slide-body';
    body.classList.toggle('hidden', !deckExpanded.has(n));
    head.setAttribute('aria-expanded', String(deckExpanded.has(n)));
    head.addEventListener('click', () => {
      const open = !body.classList.toggle('hidden');
      if (open) deckExpanded.add(n); else deckExpanded.delete(n);
      head.setAttribute('aria-expanded', String(open));
    });

    const keyIdea = document.createElement('input');
    keyIdea.className = 's-input';
    keyIdea.type = 'text';
    keyIdea.maxLength = 120;
    keyIdea.dataset.field = 'keyIdea';
    keyIdea.setAttribute('aria-label', 'Key idea');
    const points = document.createElement('textarea');
    points.rows = 4;
    points.spellcheck = false;
    points.dataset.field = 'points';
    points.setAttribute('aria-label', 'Talking points');
    const questions = document.createElement('textarea');
    questions.rows = 3;
    questions.spellcheck = false;
    questions.dataset.field = 'questions';
    questions.setAttribute('aria-label', 'Likely questions');
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 's-action';
    again.textContent = 'Generate again';
    body.append(deckLabel('Key idea'), keyIdea, deckLabel('Talking points', 'one per line'), points,
      deckLabel('Likely questions', 'one per line'), questions, again);
    row.append(head, body);

    const fields = { keyIdea, points, questions };
    // A text field fires change when it loses focus with a new value.
    for (const field of Object.values(fields)) {
      field.addEventListener('change', () => {
        const slide = currentSlide(setupId, n);
        if (slide) saveDeckSlide(setupId, slide, fields);
      });
    }
    again.addEventListener('click', async () => {
      const slide = currentSlide(setupId, n);
      if (!slide) return;
      deckProgress.delete(setupId);
      let res;
      try { res = await cue.deckRegenerate(setupId, slide.n); } catch (error) { res = { error: error && error.message ? error.message : String(error) }; }
      afterDeckRegenerate(setupId, res);
    });
    return row;
  }

  function syncDeckRow(row, slide) {
    const head = row.querySelector('.deck-slide-head');
    head.querySelector('.deck-slide-title').textContent = slide.n + ' · ' + (slide.title || 'Untitled slide');
    const tags = head.querySelector('.deck-slide-tags');
    tags.textContent = '';
    const tag = (text, cls) => {
      const el = document.createElement('span');
      el.className = 'deck-tag' + (cls ? ' ' + cls : '');
      el.textContent = text;
      tags.appendChild(el);
    };
    if (slide.edited) tag('edited');
    if (slide.enrichError) tag('not generated', 'failed');
    // Never overwrite the field being typed in.
    const values = { keyIdea: slide.keyIdea || '', points: (slide.points || []).join('\n'), questions: (slide.questions || []).join('\n') };
    for (const field of row.querySelectorAll('[data-field]')) {
      if (document.activeElement !== field) field.value = values[field.dataset.field];
    }
  }

  async function saveDeckSlide(setupId, slide, fields) {
    let res;
    try {
      res = await cue.deckUpdateSlide(setupId, slide.n, {
        keyIdea: fields.keyIdea.value.trim().slice(0, 120),
        points: parseLines(fields.points.value).map((line) => line.slice(0, 140)),
        questions: parseLines(fields.questions.value).map((line) => line.slice(0, 160))
      });
    } catch (error) {
      res = { error: error && error.message ? error.message : String(error) };
    }
    if (!deckView || deckView.setupId !== setupId) return;
    if (res && res.deck) {
      deckView = { setupId, deck: res.deck };
      setDeckStatus();
      renderDeckReview();
    } else if (res && res.error) {
      showDeckError(res.error);
    }
  }

  function afterDeckRegenerate(setupId, res) {
    if (!res || res.error) {
      if (editingSetupId === setupId) showDeckError((res && res.error) || 'Could not start generating.');
      return;
    }
    // Progress may already have arrived (no AI provider reports at once).
    if (res.started && !deckProgress.has(setupId)) deckProgress.set(setupId, { done: 0, total: Math.ceil(res.started / 8) });
    if (editingSetupId === setupId) renderDeckBlock();
  }

  cue.on('deck:progress', ({ setupId, done, total }) => {
    deckProgress.set(setupId, { done, total });
    if (editingSetupId === setupId) renderDeckBlock();
  });

  $('#deck-review').addEventListener('click', () => {
    deckReviewOpen = !deckReviewOpen;
    renderDeckReview();
  });
  $('#deck-regenerate-unedited').addEventListener('click', async () => {
    if (!deckView) return;
    const { setupId } = deckView;
    deckProgress.delete(setupId);
    let res;
    try { res = await cue.deckRegenerate(setupId, 'unedited'); } catch (error) { res = { error: error && error.message ? error.message : String(error) }; }
    afterDeckRegenerate(setupId, res);
  });

  function fillSetupForm(id) {
    editingSetupId = id || settings.activeSetupId;
    const setup = editingSetup();
    editingSetupId = setup.id;
    const select = $('#setup-select');
    select.innerHTML = '';
    for (const s of settings.setups) {
      const option = document.createElement('option');
      option.value = s.id;
      option.textContent = s.name + (s.id === settings.activeSetupId ? ' (active)' : '');
      select.appendChild(option);
    }
    select.value = setup.id;
    const builtin = setup.id === setupsModel.BUILTIN_SETUP_ID;
    $('#setup-name').value = setup.name;
    $('#setup-name').disabled = builtin;
    $('#setup-delete').disabled = builtin;
    document.querySelectorAll('#setup-kind-seg button').forEach((b) => { b.disabled = builtin; });
    $('#job-description').value = setup.conversation || '';
    $('#knowledge-base').value = setup.notes || '';
    $('#why-company').value = setup.whyCompany || '';
    $('#why-leaving').value = setup.whyLeaving || '';
    $('#salary-target').value = setup.salaryTarget || '';
    $('#questions-to-ask').value = setup.questionsToAsk || '';
    $('#setup-instructions').value = setup.instructions || '';
    $('#setup-save').checked = !!setup.saveSessions;
    $('#setup-duration').value = String(setup.durationMin || 45);
    $('#setup-activate').disabled = setup.id === settings.activeSetupId;
    if (!deckView || deckView.setupId !== setup.id) deckReviewOpen = false;
    applyKindToForm(setup.kind);
    renderDisplayPicker(setup);
  }

  // Watch display: filled from the connected displays each time the form is.
  let displayPickerToken = 0;
  async function renderDisplayPicker(setup) {
    const token = ++displayPickerToken;
    const select = $('#setup-display');
    select.innerHTML = '';
    $('#setup-display-block').classList.add('hidden');
    let displays = [];
    try { displays = await cue.displaysList(); } catch (_) { displays = []; }
    if (token !== displayPickerToken) return;
    const view = displayOptions(displays, setup.watchDisplayId);
    for (const o of view.options) {
      const option = document.createElement('option');
      option.value = o.value;
      option.textContent = o.label;
      select.appendChild(option);
    }
    select.value = String(setup.watchDisplayId || '');
    const note = $('#setup-display-note');
    note.textContent = view.missing ? 'That display is not connected; watching the primary display.' : '';
    note.classList.toggle('hidden', !view.missing);
    $('#setup-display-block').classList.toggle('hidden', !view.show);
  }
  // The note is about the saved display; choosing another one answers it.
  $('#setup-display').addEventListener('change', (e) => {
    const option = e.target.selectedOptions[0];
    if (!option || option.textContent !== 'Not connected') $('#setup-display-note').classList.add('hidden');
  });

  // Writes the form into settings (not yet saved).
  function collectSetupForm() {
    const setup = editingSetup();
    if (!setup) return;
    const kindButton = document.querySelector('#setup-kind-seg button.on');
    const patch = {
      name: setup.id === setupsModel.BUILTIN_SETUP_ID ? setup.name : ($('#setup-name').value.trim() || 'Untitled setup'),
      kind: setup.id === setupsModel.BUILTIN_SETUP_ID ? 'general' : (kindButton ? kindButton.dataset.kind : setup.kind),
      conversation: $('#job-description').value.trim(),
      notes: $('#knowledge-base').value.trim(),
      whyCompany: $('#why-company').value.trim(),
      whyLeaving: $('#why-leaving').value.trim(),
      salaryTarget: $('#salary-target').value.trim(),
      questionsToAsk: $('#questions-to-ask').value.trim(),
      instructions: $('#setup-instructions').value.trim(),
      saveSessions: $('#setup-save').checked
    };
    if (patch.kind === 'presentation') {
      const minutes = Number.parseInt($('#setup-duration').value, 10);
      patch.durationMin = Number.isFinite(minutes) ? Math.min(240, Math.max(5, minutes)) : (setup.durationMin || 45);
      // Before the display list arrives the select is empty: keep the saved choice.
      if ($('#setup-display').options.length) patch.watchDisplayId = $('#setup-display').value;
    }
    settings.setups = settings.setups.map((s) => (s.id === setup.id ? { ...s, ...patch } : s));
  }

  function collectAboutMe() {
    settings.aboutMe = {
      resumeText: $('#resume-text').value.trim(),
      stories: $('#star-stories').value.trim(),
      workStyle: $('#work-style').value.trim()
    };
  }

  async function openSetupsTab(id) {
    await openSettings();
    fillSetupForm(id || settings.activeSetupId);
    const tab = document.querySelector('.s-tab[data-tab="setups"]');
    if (tab) tab.click();
  }

  $('#setup-select').addEventListener('change', (e) => { collectSetupForm(); fillSetupForm(e.target.value); });
  // The list follows the name as it is typed.
  $('#setup-name').addEventListener('input', () => {
    const option = $('#setup-select').selectedOptions[0];
    if (option) option.textContent = ($('#setup-name').value.trim() || 'Untitled setup') + (editingSetupId === settings.activeSetupId ? ' (active)' : '');
  });
  document.querySelectorAll('#setup-kind-seg button').forEach((b) => b.addEventListener('click', () => {
    applyKindToForm(b.dataset.kind);
    // A new kind brings its default save switch only for a setup that never had content.
    const s = editingSetup();
    if (!s.conversation && !s.notes) $('#setup-save').checked = b.dataset.kind !== 'general';
  }));
  $('#setup-new').addEventListener('click', () => {
    collectSetupForm();
    const setup = setupsModel.makeSetup({ name: 'New setup', kind: 'general' });
    settings.setups = [...settings.setups, setup];
    fillSetupForm(setup.id);
    $('#setup-name').focus();
    $('#setup-name').select();
  });
  $('#setup-duplicate').addEventListener('click', () => {
    collectSetupForm();
    const source = editingSetup();
    const copy = { ...setupsModel.makeSetup({ kind: source.kind }), ...source };
    copy.id = setupsModel.makeSetup().id;
    copy.name = source.name + ' copy';
    // Deck files belong to one setup; the copy imports its own.
    if (copy.kind === 'presentation') copy.deck = null;
    settings.setups = [...settings.setups, copy];
    fillSetupForm(copy.id);
  });
  $('#setup-delete').addEventListener('click', () => {
    const setup = editingSetup();
    if (setup.id === setupsModel.BUILTIN_SETUP_ID) return;
    if (!confirm(`Delete the setup "${setup.name}"? Saved sessions are kept.`)) return;
    settings.setups = settings.setups.filter((s) => s.id !== setup.id);
    if (settings.activeSetupId === setup.id) {
      settings.activeSetupId = setupsModel.BUILTIN_SETUP_ID;
      // Deleted here, on purpose: the "no longer exists" notice is for changes made elsewhere.
      lastActiveSetupId = settings.activeSetupId;
    }
    fillSetupForm(settings.activeSetupId);
  });
  $('#deck-import').addEventListener('click', async () => {
    const button = $('#deck-import');
    const setupId = editingSetupId;
    button.disabled = true;
    try {
      // Main reads the setup from the saved file, so a new setup, or one just
      // switched to Presentation, is saved first.
      if (!(await saveSettings())) return;
      deckProgress.delete(setupId);
      const res = await cue.deckImport(setupId);
      if (!res || res.canceled) return;
      if (res.error) { if (editingSetupId === setupId) showDeckError(res.error); return; }
      if (res.unchanged) showToast('Same file as the current deck · nothing changed', 2000);
      if (editingSetupId !== setupId) return;
      await renderDeckBlock();
      // Batches report as they finish; until the first one does, show the count.
      if (!res.unchanged && deckView && deckView.setupId === setupId && !deckProgress.has(setupId)) {
        const pending = deckPending(deckView.deck);
        if (pending) { deckProgress.set(setupId, { done: 0, total: Math.ceil(pending / 8) }); setDeckStatus(); }
      }
    } catch (error) {
      if (editingSetupId === setupId) showDeckError(error && error.message ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  });
  $('#setup-activate').addEventListener('click', async () => {
    collectSetupForm();
    settings.activeSetupId = editingSetupId;
    if (await saveSettings()) fillSetupForm(editingSetupId);
  });

  async function saveSettingsNow() {
    // Never persist empty inputs before the asynchronous form load finishes.
    if (!settingsFormReady) return false;
    // Keys
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    settings.apiKeys.custom = $('#key-custom').value.trim();
    settings.baseUrl = $('#base-url').value.trim();
    settings.apiKeys.ollama = $('#key-ollama').value.trim();
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.minimax = $('#key-minimax').value.trim();
    settings.apiKeys.deepseek = $('#key-deepseek').value.trim();
    settings.apiKeys.cerebras = $('#key-cerebras').value.trim();
    settings.apiKeys.azure = $('#key-azure').value.trim();
    settings.azureEndpoint = $('#azure-endpoint').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    // If the active provider still has no key, but the user just filled in a
    // key for a different provider (without touching the Provider selector —
    // the flow both bug reports describe), switch to that provider. Without
    // this, `settings.provider` stays on its default ('openai') forever and
    // cue keeps reporting itself unconfigured even though a valid key was
    // saved for the provider the user actually meant to use.
    // Providers that work without a key (Ollama, a Custom endpoint, publik) are
    // a deliberate choice and never switched away from.
    const keylessProviders = ['ollama', 'custom', 'publik'];
    if (!keylessProviders.includes(settings.provider) && !settings.apiKeys[settings.provider]) {
      const keyedProviders = ['openai', 'anthropic', 'gemini', 'groq', 'minimax', 'deepseek', 'cerebras', 'azure'];
      const justFilled = keyedProviders.find((p) => settings.apiKeys[p]);
      if (justFilled && justFilled !== settings.provider) {
        settings.provider = justFilled;
        // Keep the form in step with the switch: the next save (switching tabs
        // saves) reads the model boxes into settings.models[settings.provider],
        // and stale boxes wrote the previous provider's models (e.g. Ollama's
        // llama3.2) into OpenAI's.
        document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x.dataset.provider === justFilled));
        const m = settings.models[justFilled] || { fast: '', smart: '' };
        $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
        updateCustomProviderFields();
      }
    }
    // Transcription
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.sttLanguage = $('#stt-language').value || 'en';
    settings.localWhisper.threads = Math.max(0, Math.min(64, Number.parseInt($('#whisper-threads').value, 10) || 0));
    // Slides (opt-in, memory only)
    settings.slides = {
      ...(settings.slides || {}),
      enabled: $('#slides-enabled').checked,
      intervalMs: Math.max(1500, Math.min(15000, Number.parseInt($('#slides-interval').value, 10) || 3000))
    };
    // Style tab
    settings.aiRules = $('#ai-rules').value.trim();
    settings.answerLength = $('#answer-length').value;
    settings.panelOpacity = Number($('#panel-opacity').value) / 100;
    settings.includeScreen = $('#include-screen').value !== 'no';
    settings.warmUp = $('#warm-up').value !== 'off';
    collectAboutMe();
    collectSetupForm();
    try {
      settings = await cue.settingsSet(settings);
      if (latest.querySelector('.empty-state')) showEmptyState(); // a key was just added or removed
      $('#s-status').textContent = statusText();
      updateSetupStatus();
      updateSmartTooltip();
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      $('#s-status').textContent = message;
      $('#base-url').focus();
      return false;
    }
  }

  // ---- empty state: what to do next, never a sample answer ----------------
  // A made-up answer on launch is indistinguishable from a real one at a
  // glance, which is exactly how the panel is read during an interview.
  function providerReady(s) {
    const p = s.provider;
    if (p === 'publik') return !!(s.publik && s.publik.connected);
    if (p === 'ollama') return true;
    if (p === 'custom') return !!s.baseUrl;
    return !!(s.apiKeys && s.apiKeys[p]);
  }
  function showEmptyState() {
    clearMessages();
    setPresentationAnswerShown(false); // the answers were cleared
    const box = document.createElement('div');
    box.className = 'empty-state';
    if (!providerReady(settings)) {
      box.innerHTML = '<strong>Add an AI key to get started.</strong><br>cue needs a provider key before it can answer.';
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open Settings';
      open.addEventListener('click', () => openSettings());
      box.appendChild(document.createElement('br'));
      box.appendChild(open);
    } else {
      const setup = activeSetupOf(settings);
      box.innerHTML = setup && setup.kind === 'interview'
        ? '<strong>Ready for your interview.</strong> Start listening with the ■ button above, then press <strong>What should I say?</strong> when you\'re asked something.'
        : setup && setup.kind === 'presentation'
          ? '<strong>Ready to present.</strong> Start listening with the ■ button above. Talking points follow your slides; press <strong>Answer audience</strong> when someone asks a question.'
          : '<strong>Ready.</strong> Start listening with the ■ button above, then press <strong>What should I say?</strong> when someone asks you something or you want to contribute.';
    }
    latest.appendChild(box);
  }
  function clearEmptyState() {
    const box = latest.querySelector('.empty-state');
    if (box) box.remove();
  }

  // ---- saved sessions ------------------------------------------------------
  const sessionsScrim = $('#sessions-scrim');
  let sessionsView = null;       // { enabled, exportDir, currentId, sessions }
  let openSessionId = null;
  let debriefingId = null;
  let debriefRaw = '';

  function formatWhen(ms) {
    return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function sessionMeta(s) {
    const minutes = Math.max(0, Math.round(((s.endedAt || s.updatedAt || s.startedAt) - s.startedAt) / 60000));
    const parts = [formatWhen(s.startedAt), minutes + ' min', s.questionCount + (s.questionCount === 1 ? ' question' : ' questions')];
    if (s.id === (sessionsView && sessionsView.currentId)) parts.push('in progress');
    if (s.hasDebrief) parts.push('debriefed');
    return parts.join(' · ');
  }

  function renderSessionsList() {
    const v = sessionsView;
    if (!v) return;
    $('#sessions-enabled').checked = v.enabled;
    const label = $('#sessions-enabled').parentElement;
    label.lastChild.textContent = ' Save conversations with “' + (sessionsView.setupName || 'this setup') + '”';
    const practice = $('#practice-start');
    practice.disabled = sessionsView.setupKind !== 'interview';
    practice.title = practice.disabled ? 'Practice needs a Job interview setup' : 'Cue asks interview questions and rates your answers';
    $('#sessions-hint').classList.toggle('hidden', v.enabled && v.sessions.length > 0);
    $('#sessions-export-dir').textContent = v.exportDir || 'off';
    $('#sessions-export-dir').title = v.exportDir || '';
    $('#sessions-clear-dir').classList.toggle('hidden', !v.exportDir);
    const host = $('#sessions-list');
    host.innerHTML = '';
    if (!v.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'sess-empty';
      empty.textContent = $('#sessions-search').value.trim() ? 'No sessions match.'
        : v.enabled ? 'No saved sessions yet. They appear here as you use cue.' : 'Saving is off. Turn it on above to keep your conversations.';
      host.appendChild(empty);
      return;
    }
    for (const s of v.sessions) {
      const item = document.createElement('button');
      item.className = 'sess-item';
      const title = document.createElement('div');
      title.className = 'sess-item-title';
      title.textContent = s.title;
      const meta = document.createElement('div');
      meta.className = 'sess-item-meta';
      meta.textContent = sessionMeta(s);
      item.append(title, meta);
      item.addEventListener('click', () => openSession(s.id));
      host.appendChild(item);
    }
  }

  async function refreshSessions() {
    sessionsView = await cue.sessionsList($('#sessions-search').value);
    renderSessionsList();
  }

  function showSessionsList() {
    openSessionId = null;
    $('#session-view').classList.add('hidden');
    $('#sessions-list-view').classList.remove('hidden');
    refreshSessions();
  }

  async function openSession(id) {
    const session = await cue.sessionsGet(id);
    if (!session) { showToast('That session no longer exists.', 2000); return refreshSessions(); }
    openSessionId = id;
    $('#sessions-list-view').classList.add('hidden');
    $('#session-view').classList.remove('hidden');
    $('#session-debrief').textContent = session.debrief ? 'Redo debrief' : 'Debrief';
    $('#session-debrief').disabled = debriefingId === id;
    $('#session-body').innerHTML = renderMarkdown(session.markdown);
    renderDebriefQuestions(session);
    $('#session-body').scrollTop = 0;
  }

  // After a presentation debrief's prose: one checkbox per audience question
  // and "Add selected", which appends the ticked ones to their slides.
  function renderDebriefQuestions(session) {
    if (!canAddDebriefQuestions(session, settings && settings.setups)) return;
    const body = $('#session-body');
    const box = document.createElement('div');
    box.className = 'debrief-questions';
    const head = document.createElement('p');
    head.className = 'md-h';
    head.textContent = 'Questions for the deck';
    box.appendChild(head);
    const checks = [];
    for (const q of session.debriefQuestions) {
      const row = document.createElement('label');
      row.className = 'debrief-q';
      const check = document.createElement('input');
      check.type = 'checkbox';
      const text = document.createElement('span');
      text.className = 'debrief-q-text';
      text.textContent = q.question;
      const hint = document.createElement('span');
      hint.className = 'debrief-q-hint';
      hint.textContent = 'Add to slide ' + q.n + '\'s likely questions';
      const words = document.createElement('span');
      words.append(text, hint);
      row.append(check, words);
      box.appendChild(row);
      checks.push({ check, q });
    }
    const actions = document.createElement('div');
    actions.className = 'debrief-q-actions';
    const add = document.createElement('button');
    add.className = 's-action primary';
    add.textContent = 'Add selected';
    const status = document.createElement('span');
    status.className = 'debrief-q-status';
    actions.append(add, status);
    box.appendChild(actions);
    add.addEventListener('click', async () => {
      const items = checks.filter((c) => c.check.checked).map((c) => ({ n: c.q.n, question: c.q.question }));
      if (!items.length) { status.textContent = 'Tick the questions to add first.'; return; }
      add.disabled = true;
      try {
        const r = await cue.deckAddQuestions(session.setupId, items);
        if (r && r.error) { status.textContent = r.error; add.disabled = false; return; }
        status.textContent = 'Added ' + r.added + (r.added === 1 ? ' question' : ' questions') + ' to the deck.';
        for (const c of checks) c.check.disabled = true;
      } catch (err) {
        status.textContent = err && err.message ? err.message : String(err);
        add.disabled = false;
      }
    });
    // Right after the debrief prose, before the conversation.
    const conversation = [...body.querySelectorAll('.md-h')].find((h) => h.textContent === 'Conversation');
    body.insertBefore(box, conversation || null);
  }

  function openSessions() {
    showPanel();
    sessionsScrim.classList.remove('hidden');
    showSessionsList();
  }
  function closeSessions() { sessionsScrim.classList.add('hidden'); }

  $('#sessions-close').addEventListener('click', closeSessions);
  sessionsScrim.addEventListener('click', (e) => { if (e.target === sessionsScrim) closeSessions(); });
  $('#session-back').addEventListener('click', showSessionsList);
  let searchTimer = null;
  $('#sessions-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refreshSessions, 200); });
  $('#sessions-enabled').addEventListener('change', async (e) => {
    sessionsView = await cue.sessionsSetEnabled(e.target.checked);
    renderSessionsList();
    settings = await cue.settingsGet();
    updateSetupStatus();
    showToast(e.target.checked ? 'Sessions will be saved on this computer' : 'Saving off · sessions already saved are kept', 2500);
  });
  $('#sessions-choose-dir').addEventListener('click', async () => { sessionsView = await cue.sessionsChooseExportDir(); renderSessionsList(); });
  $('#sessions-clear-dir').addEventListener('click', async () => { sessionsView = await cue.sessionsClearExportDir(); renderSessionsList(); });
  $('#sessions-open-folder').addEventListener('click', () => cue.sessionsOpenFolder());
  $('#session-export').addEventListener('click', async () => {
    if (!openSessionId) return;
    try {
      const r = await cue.sessionsExport(openSessionId);
      if (!r.canceled) showToast('Exported to ' + r.filePath, 3000);
    } catch (err) { showToast(err.message || String(err), 3000); }
  });
  $('#session-delete').addEventListener('click', async () => {
    if (!openSessionId) return;
    if (!confirm('Delete this session? This cannot be undone.')) return;
    sessionsView = await cue.sessionsDelete(openSessionId);
    showSessionsList();
    showToast('Session deleted', 1800);
  });
  $('#session-debrief').addEventListener('click', async () => {
    const id = openSessionId;
    if (!id) return;
    debriefingId = id;
    debriefRaw = '';
    $('#session-debrief').disabled = true;
    const body = $('#session-body');
    body.innerHTML = '<p class="md-h">Debrief</p><div id="debrief-live"><p><em>Writing the debrief…</em></p></div>';
    body.scrollTop = 0;
    try {
      await cue.sessionsDebrief(id);
      if (openSessionId === id) await openSession(id);
    } catch (err) {
      const message = (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (openSessionId === id) { const live = $('#debrief-live'); if (live) live.innerHTML = '<p>' + esc(message) + '</p>'; }
      else showToast(message, 3000);
    } finally {
      debriefingId = null;
      if (openSessionId === id) $('#session-debrief').disabled = false;
    }
  });
  cue.on('sessions:debrief-token', ({ id, text }) => {
    if (id !== debriefingId) return;
    debriefRaw += text;
    const live = $('#debrief-live');
    if (live && openSessionId === id) live.innerHTML = renderMarkdown(debriefDisplayText(debriefRaw));
  });
  cue.on('sessions:saved', () => {
    if (!sessionsScrim.classList.contains('hidden') && !openSessionId) refreshSessions();
  });

  // ---- practice interviews -------------------------------------------------
  let practiceActive = false;
  let practiceStartedListening = false;
  function setPracticeUI(active) {
    practiceActive = active;
    $('#practice-row').classList.toggle('hidden', !active);
    $('#action-row').classList.toggle('hidden', active);
    // Practice is an interview: a general setup mid-run would mix the prompts.
    const setupSwitch = $('#setup-switch');
    setupSwitch.disabled = active;
    setupSwitch.title = active ? 'Switch setups after ending practice' : setupSwitchTitle;
    if (active) closeSetupMenu();
    if (!active && 'speechSynthesis' in window) speechSynthesis.cancel();
    syncPracticeVoice();
    updateSavingIndicator();
  }
  function practiceVoiceOn() { return !settings || settings.practiceVoice !== false; }
  function syncPracticeVoice() { $('#practice-voice').textContent = 'Voice: ' + (practiceVoiceOn() ? 'on' : 'off'); }

  // Questions are read aloud with the operating system's own voices (free and
  // offline). The mic is muted in main while the voice plays.
  function speakQuestion(text) {
    if (!practiceVoiceOn() || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.onstart = () => cue.practiceSpeaking(true);
    utterance.onend = () => cue.practiceSpeaking(false);
    utterance.onerror = () => cue.practiceSpeaking(false);
    speechSynthesis.speak(utterance);
  }

  $('#practice-start').addEventListener('click', async () => {
    let r;
    try { r = await cue.practiceStart(); }
    catch (err) {
      showToast((err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 3500);
      return;
    }
    closeSessions();
    clearConversationUI();
    setPracticeUI(true);
    // Listening is needed to hear the answers; the click still counts as the
    // user gesture that audio capture requires.
    practiceStartedListening = !$('#stop-btn').classList.contains('active');
    if (practiceStartedListening) $('#stop-btn').click();
    runMode('practiceQuestion');
    showToast((r.savedId ? 'Previous conversation saved · ' : '') + 'Answer out loud, then Rate my answer or Next question', 4000);
  });
  $('#practice-next').addEventListener('click', () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); runMode('practiceQuestion'); });
  $('#practice-rate').addEventListener('click', () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); runMode('practiceFeedback'); });
  $('#practice-voice').addEventListener('click', async () => {
    settings.practiceVoice = !practiceVoiceOn();
    syncPracticeVoice();
    if (!settings.practiceVoice && 'speechSynthesis' in window) speechSynthesis.cancel();
    await cue.settingsSet({ practiceVoice: settings.practiceVoice });
  });
  $('#practice-end').addEventListener('click', async () => {
    const r = await cue.practiceEnd();
    // Leave listening as it was before practice.
    if (practiceStartedListening && $('#stop-btn').classList.contains('active')) $('#stop-btn').click();
    practiceStartedListening = false;
    setPracticeUI(false);
    clearConversationUI();
    showToast(r.savedId ? 'Practice saved · open Sessions to debrief it' : 'Practice ended · turn on saving in Sessions to keep practice runs', 3500);
  });
  cue.on('practice:state', ({ active }) => { if (active !== practiceActive) setPracticeUI(active); });
  cue.on('practice:question', ({ text }) => speakQuestion(text));

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panelMenu.classList.contains('hidden')) { closePanelMenu(); return; }
    if (e.key === 'Escape' && !setupMenu.classList.contains('hidden')) { closeSetupMenu(); return; }
    // Text size: window keys only (the panel rarely has focus; the ⋯ menu is the main path).
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); changeTextSize(1); return; }
      if (e.key === '-') { e.preventDefault(); changeTextSize(-1); return; }
    }
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) void closeSettings();
    else if (e.key === 'Escape' && !sessionsScrim.classList.contains('hidden')) closeSessions();
    // Escape with nothing else to close stops the answer being written.
    else if (e.key === 'Escape' && busy) cue.cancelAnswer();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  // The renderer reports where its UI is and the main process compares the
  // cursor with it (src/click-through.js). Deciding here from mousemove
  // failed: Windows forwards those unreliably while the window is
  // click-through, and never over the drag handle, so a direct grab of the
  // header went to the app behind.
  const UI_SELECTORS = '#header, #panel-menu, #setup-menu, #panel-wrap, #transcript-sidebar, #settings-scrim, #sessions-scrim, #publik-scrim, #consent-scrim';
  let lastUiRects = '';
  let uiRectsFrame = null;
  function reportUiRects() {
    uiRectsFrame = null;
    const rects = [...document.querySelectorAll(UI_SELECTORS)]
      .filter((el) => el.getClientRects().length) // hidden (display: none) parts are skipped
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
      })
      .filter((r) => r.width > 0 && r.height > 0);
    const key = JSON.stringify(rects);
    if (key !== lastUiRects) { lastUiRects = key; cue.setUiRects(rects); }
  }
  function scheduleUiRects() { if (!uiRectsFrame) uiRectsFrame = requestAnimationFrame(reportUiRects); }
  new MutationObserver(scheduleUiRects).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  const uiResize = new ResizeObserver(scheduleUiRects);
  document.querySelectorAll(UI_SELECTORS).forEach((el) => uiResize.observe(el));
  document.addEventListener('transitionend', scheduleUiRects); // e.g. the panel sliding for the history sidebar
  window.addEventListener('resize', scheduleUiRects);
  scheduleUiRects();

  // ---- assistant access request ------------------------------------------
  // Shown here rather than as a native dialog because cue hides its dock icon:
  // an OS panel from an accessory app never comes forward and cannot be
  // clicked. Note the scrim is registered in the click-through selector above
  // and in styles.css — without both, this window stays transparent to the
  // mouse and the buttons do nothing.
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;

  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    cue.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
  }

  cue.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // Do not wait for a mousemove to turn the mouse back on: the pointer may
    // already be still, and the sheet would be unclickable until it moved.
    scheduleUiRects();
    $('#cs-deny').focus();
  });

  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, including Escape and
  // clicking away.
  consentScrim.addEventListener('click', (e) => { if (e.target === consentScrim) answerConsent(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingConsentId) { e.preventDefault(); answerConsent(false); }
  });

  // ---- publik consent helpers (pure; test/renderer-panel.test.js evaluates them)
  // The disclosure shows on its own at start-up while publik is the provider
  // and this build's disclosure version has not been accepted.
  function publikConsentPending(settings, publik) {
    if (!settings || !publik || !publik.available || settings.provider !== 'publik') return false;
    return (Number(publik.disclosureAccepted) || 0) < (Number(publik.disclosureVersion) || 1);
  }
  // ---- end publik consent helpers

  // ---- publik consent dialog ---------------------------------------------
  const publikScrim = $('#publik-scrim');
  // Disclosure (R21 §4.3): two disclosures — cost and data path — and a
  // visible "use my own key" branch. Copy comes from main (one source).
  // Only "Continue" mints a key; closing the dialog never provisions.
  function publikStep() {
    const c = publikState.copy.disclosure;
    return {
      icon: '🪙',
      title: c.title,
      body: () => `${esc(c.intro)}<br><br><strong>Cost.</strong> ${esc(c.cost)}<br><br><strong>Where your prompts go.</strong> ${esc(c.dataPath)}` +
        `<span class="pd-fine">${esc(c.terms)} <a id="pd-publik-terms">publik API terms</a></span>`,
      buttons: [
        { label: c.accept, action: async () => {
          const btns = $('#pd-buttons').querySelectorAll('button'); btns.forEach((b) => { b.disabled = true; });
          publikState = await cue.publikAcceptDisclosure(); settings.provider = 'publik'; renderPublikBlock();
          // CONTRACT §12.1: the card comes right after POST /installs succeeds,
          // with the real balance on it. Nothing is spent before it is seen.
          if (publikState.card) { showPublikCard(); return; }
          hidePublikDialog();
        } },
        { label: c.decline, action: () => { hidePublikDialog(); openSettings(); selectByoProvider(); } }
      ]
    };
  }
  // The first-run card (CONTRACT §12.1), in this order: (a) the balance line
  // from the mint response, (b) the one-sentence justification, (c) the
  // primary button that opens claim_url — and "Later", which keeps the key
  // and the balance. Everything is painted from publikState.card (src/publik.js
  // ctaView), so the copy has one source and the link rule is tested there.
  // It has only these buttons: leaving it any other way would spend the
  // starter without the card being acknowledged.
  function publikCardStep() {
    const card = publikState.card;
    const done = async () => {
      publikState = await cue.publikCardSeen(); renderPublikBlock();
      hidePublikDialog();
    };
    const buttons = [];
    if (card.primary) {
      buttons.push({ label: card.primary.label, primary: true, action: async () => { cue.publikOpen(card.primary.url); await done(); } });
    }
    buttons.push({ label: card.secondary.label, action: done });
    return {
      icon: '✅',
      title: card.title,
      body: () => `<div class="publik-card-balance">${esc(card.balance)}</div><div class="publik-card-why">${esc(card.why)}</div>`,
      buttons
    };
  }
  function esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
  function renderPublikDialog(step) {
    showPanel();
    $('#pd-icon').textContent = step.icon;
    $('#pd-title').textContent = step.title;
    $('#pd-body').innerHTML = step.body();
    const termsLink = $('#pd-publik-terms');
    if (termsLink) termsLink.addEventListener('click', () => cue.publikOpen(publikState.links.terms));
    const btns = $('#pd-buttons'); btns.innerHTML = '';
    step.buttons.forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; if (b.primary) el.classList.add('pd-cta'); el.addEventListener('click', b.action); btns.appendChild(el); });
    publikScrim.classList.remove('hidden'); scheduleUiRects();
  }
  function hidePublikDialog() { publikScrim.classList.add('hidden'); }
  function showPublikDisclosure() {
    if (!publikState || !publikState.available) return;
    renderPublikDialog(publikStep());
  }
  // Also reached from Settings → Keys, an answer error's action, and the
  // "never a silent starter" gate in main.js runFeature.
  function showPublikCard() {
    if (!publikState || !publikState.card) return;
    renderPublikDialog(publikCardStep());
  }

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    applyPanelOpacity(settings.panelOpacity);
    applyTextSize(settings.answerTextPx);
    publikState = await cue.publikState();
    // A build with no app token never shows the option.
    $('#provider-publik').classList.toggle('hidden', !publikState.available);

    // R5: setup name and saving dot in the header
    updateSetupStatus();
    // R6: smart tooltip
    updateSmartTooltip();

    smartBtn.classList.toggle('on', !!settings.smart);
    syncAutoButton();
    showEmptyState();

    // The footer titles show the configured shortcuts for this platform.
    refreshShortcuts().catch(() => {});

    const st = await cue.captureState();
    setCaptureButton(!!st.active);
    if (publikConsentPending(settings, publikState)) showPublikDisclosure();
  })();
})();
