const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const panelLayout = require('../src/panel-layout');

// renderer.js is a browser script with no harness: the pure helpers are
// evaluated from their source, the wiring is guarded by inspection.
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer/styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function section(startMarker, endMarker, names, prelude = '') {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(start > -1 && end > start, startMarker + ' not found');
  return new Function(prelude + src.slice(start, end) + '\nreturn { ' + names.join(', ') + ' };')();
}

function functionBody(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > -1, name + ' not found');
  return src.slice(start, src.indexOf('\n  }\n', start));
}

function element(id) {
  const at = html.indexOf('id="' + id + '"');
  assert.ok(at > -1, '#' + id + ' not found');
  const open = html.lastIndexOf('<', at);
  const tag = html.slice(open + 1).match(/^\w+/)[0];
  const close = html.indexOf('</' + tag + '>', at);
  return html.slice(open, close);
}

test('the first-run tour, logo button and toolbar clutter are gone from the page', () => {
  for (const gone of ['id="onboard-scrim"', 'id="onboard"', 'ob-dots', 'ob-next', 'ob-skip', 'ob-back', 'logo-btn', 'drag-pill',
    'id="live-dot"', 'id="stt-status"', 'class="prep-item"', 'id="prep-status"', 'tb-presentation', 'id="toolbar"',
    'id="history-btn"', 'id="sessions-btn"', 'id="more-btn"']) {
    assert.ok(!html.includes(gone), gone + ' is still in index.html');
  }
});

test('the renderer no longer drives the tour or the removed elements', () => {
  for (const gone of ['OB_STEPS', 'showOnboard', 'finishOnboard', 'onboarded', 'logo-btn', 'live-dot', 'stt-status',
    'prep-item', 'tb-presentation', 'history-btn', 'sessions-btn', 'more-btn', '#toolbar']) {
    assert.ok(!src.includes(gone), gone + ' is still in renderer.js');
  }
  assert.ok(!css.includes('#onboard') && !css.includes('.drag-pill') && !css.includes('#live-dot') && !css.includes('#stt-status') && !css.includes('.prep-item') && !css.includes('.tb-presentation'),
    'styles for removed elements are gone');
});

test('the header holds start/stop, the setup switch, status, hide, menu and quit in order', () => {
  const header = element('header');
  const order = ['stop-btn', 'setup-switch', 'setup-saving-dot', 'header-status', 'hide-btn', 'menu-btn', 'quit-btn'];
  let last = -1;
  for (const id of order) {
    const at = header.indexOf('id="' + id + '"');
    assert.ok(at > last, '#' + id + ' is in the header, in order');
    last = at;
  }
  assert.match(header, /^<div id="header" class="drag-handle"/);
  assert.match(header, /id="header-status" class="header-status hidden"/);
  assert.match(css, /#header \{[^}]*-webkit-app-region: drag;/);
});

test('start/stop reads "● Listening" while capturing and "Start" otherwise', () => {
  const body = functionBody('setCaptureButton');
  assert.match(body, /'● Listening'/);
  assert.match(body, /'Start'/);
  assert.match(body, /classList\.toggle\('active', active\)/);
  const capture = src.slice(src.indexOf("cue.on('capture:state'"), src.indexOf('});', src.indexOf("cue.on('capture:state'")));
  assert.match(capture, /setCaptureButton\(active\)/);
});

test('the menu lists the six actions and the text size value', () => {
  const menu = element('panel-menu');
  assert.match(menu, /^<div id="panel-menu" class="panel-menu hidden" role="menu"/);
  const actions = [...menu.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['history', 'sessions', 'settings', 'review-slides', 'text-smaller', 'text-larger']);
  assert.match(menu, /id="text-size-value"/);
});

test('Review slides shows only for a presentation setup', () => {
  const { menuActionVisible } = section('// ---- panel menu helpers', '// ---- end panel menu helpers', ['menuActionVisible']);
  for (const action of ['history', 'sessions', 'settings', 'text-smaller', 'text-larger']) {
    for (const kind of ['general', 'interview', 'presentation', undefined]) assert.equal(menuActionVisible(action, kind), true);
  }
  assert.equal(menuActionVisible('review-slides', 'presentation'), true);
  assert.equal(menuActionVisible('review-slides', 'interview'), false);
  assert.equal(menuActionVisible('review-slides', 'general'), false);
  assert.equal(menuActionVisible('review-slides', undefined), false);
  assert.match(functionBody('renderPanelMenu'), /menuActionVisible\(/);
});

test('text size steps by TEXT_STEP within TEXT_MIN..TEXT_MAX', () => {
  const { stepTextSize } = section('// ---- text size helpers', '// ---- end text size helpers', ['stepTextSize']);
  const t = panelLayout;
  assert.equal(stepTextSize(18, 1, t), 20);
  assert.equal(stepTextSize(18, -1, t), 16);
  assert.equal(stepTextSize(t.TEXT_MAX, 1, t), t.TEXT_MAX);
  assert.equal(stepTextSize(t.TEXT_MIN, -1, t), t.TEXT_MIN);
  assert.equal(stepTextSize(31, 1, t), 32);
  assert.equal(stepTextSize(undefined, 1, t), t.TEXT_DEFAULT + t.TEXT_STEP, 'a missing value starts from the default');
  assert.equal(stepTextSize(99, -1, t), t.TEXT_MAX - t.TEXT_STEP, 'an out-of-range value is clamped first');
});

test('the text size comes from the shared panel-layout module and is saved as answerTextPx', () => {
  assert.match(preload, /require\('\.\/src\/panel-layout'\)/);
  assert.match(preload, /panelText: \{ TEXT_DEFAULT, TEXT_MIN, TEXT_MAX, TEXT_STEP, answerScale \}/);
  const change = functionBody('changeTextSize');
  assert.match(change, /stepTextSize\(/);
  assert.match(change, /answerTextPx: size/);
  const apply = functionBody('applyTextSize');
  assert.match(apply, /answerScale\(/);
  assert.match(apply, /setProperty\('--answer-px', size \+ 'px'\)/);
  assert.match(apply, /#text-size-value/);
  // Ctrl+= / Ctrl+- are window keys, not global shortcuts.
  assert.match(src, /e\.key === '=' \|\| e\.key === '\+'\) \{ e\.preventDefault\(\); changeTextSize\(1\)/);
  assert.match(src, /e\.key === '-'\) \{ e\.preventDefault\(\); changeTextSize\(-1\)/);
});

test('the menu closes on Esc, an outside click or a choice', () => {
  assert.match(src, /if \(e\.key === 'Escape' && !panelMenu\.classList\.contains\('hidden'\)\) \{ closePanelMenu\(\); return; \}/);
  assert.match(src, /document\.addEventListener\('click', \(e\) => \{ if \(!panelMenu\.contains\(e\.target\)\) closePanelMenu\(\); \}\);/);
  const choose = functionBody('runMenuAction');
  assert.match(choose, /closePanelMenu\(\)/);
});

test('menu screens un-hide the panel first', () => {
  for (const name of ['openSettings', 'openSessions']) assert.match(functionBody(name), /showPanel\(\);/, name);
  assert.match(functionBody('runMenuAction'), /'history'[\s\S]*showPanel\(\)/);
});

test('Hide keeps the header and tells main its height', () => {
  const body = functionBody('toggleHide');
  assert.match(body, /cue\.setHidden\(collapsed, Math\.ceil\(\$\('#header'\)\.getBoundingClientRect\(\)\.height\)\)/);
});

test('hidden in a presentation setup, the header shows the presentation status', () => {
  const { headerStatus } = section('// ---- presentation helpers', '// ---- end presentation helpers', ['headerStatus']);
  const update = (over = {}) => ({ snapshot: { slideCount: 32, offDeck: false, remainingMs: 1120000, pacing: { status: 'on', minutes: 0 }, ...over }, slide: { n: 7 } });
  assert.equal(headerStatus(update()), '✓ on track · 18:40');
  assert.equal(headerStatus(update({ pacing: { status: 'ahead', minutes: 2 } })), '▲ ahead 2 min · 18:40');
  assert.equal(headerStatus(update({ pacing: { status: 'behind', minutes: 4 } })), '▼ behind 4 min · 18:40');
  assert.equal(headerStatus(update({ offDeck: true })), 'off-deck · 18:40');
  assert.equal(headerStatus(update({ slideCount: 0, pacing: { status: 'none', minutes: 0 } })), '18:40', 'no deck: the time left only');
  assert.equal(headerStatus(null), '');
  const strip = functionBody('renderPresenterStrip');
  assert.match(strip, /\$\('#header-status'\)/);
  assert.match(strip, /headerStatus\(update\)/);
});

test('the publik consent card still shows on its own when consent is pending', () => {
  const { publikConsentPending } = section('// ---- publik consent helpers', '// ---- end publik consent helpers', ['publikConsentPending']);
  const p = (over = {}) => ({ available: true, disclosureAccepted: 0, disclosureVersion: 1, ...over });
  assert.equal(publikConsentPending({ provider: 'publik' }, p()), true);
  assert.equal(publikConsentPending({ provider: 'publik' }, p({ disclosureAccepted: 1, disclosureVersion: 2 })), true, 'a newer disclosure');
  assert.equal(publikConsentPending({ provider: 'publik' }, p({ disclosureAccepted: 1 })), false);
  assert.equal(publikConsentPending({ provider: 'openai' }, p()), false, 'a user on their own key');
  assert.equal(publikConsentPending({ provider: 'publik' }, p({ available: false })), false, 'a build without publik');
  assert.equal(publikConsentPending(null, p()), false);
  assert.equal(publikConsentPending({ provider: 'publik' }, null), false);
  const boot = src.slice(src.indexOf('(async function boot()'));
  assert.match(boot, /if \(publikConsentPending\(settings, publikState\)\) showPublikDisclosure\(\);/);
  for (const id of ['publik-scrim', 'publik-dialog', 'pd-title', 'pd-body', 'pd-buttons']) assert.match(html, new RegExp('id="' + id + '"'));
  // Settings → Keys and error actions still open the disclosure and the card.
  assert.match(src, /\$\('#publik-setup'\)\.addEventListener\('click', \(\) => showPublikDisclosure\(\)\);/);
  assert.match(src, /if \(action && action\.kind === 'card'\) \{ showPublikCard\(\); return; \}/);
});

test('click-through rectangles list the new header and menus, not removed elements', () => {
  const line = src.match(/const UI_SELECTORS = '([^']+)'/);
  assert.ok(line, 'UI_SELECTORS not found');
  const selectors = line[1].split(',').map((s) => s.trim());
  for (const s of ['#header', '#panel-menu', '#setup-menu', '#panel-wrap', '#settings-scrim', '#sessions-scrim', '#publik-scrim', '#consent-scrim']) {
    assert.ok(selectors.includes(s), s + ' is listed');
  }
  for (const s of ['#toolbar', '#onboard-scrim']) assert.ok(!selectors.includes(s), s + ' is not listed');
  for (const s of selectors) assert.match(html, new RegExp('id="' + s.slice(1) + '"'), s + ' exists in the page');
});

test('the header and menu add no transitions or animations', () => {
  const start = css.indexOf('/* ============================ Header');
  const end = css.indexOf('/* ============================', start + 10);
  assert.ok(start > -1 && end > start, 'header styles not found');
  assert.doesNotMatch(css.slice(start, end), /transition|animation/);
});

// ── Reading area, footer, Ask field and heard caption ────────────────────────

// A container with nested <div>s: up to its own closing tag.
function container(id) {
  const open = html.lastIndexOf('<div', html.indexOf('id="' + id + '"'));
  assert.ok(open > -1, '#' + id + ' not found');
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = open;
  let depth = 0;
  for (let m; (m = tags.exec(html));) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index);
  }
  assert.fail('#' + id + ' is not closed');
}

function cssRule(selector) {
  const at = css.indexOf('\n' + selector + ' {');
  assert.ok(at > -1, selector + ' rule not found');
  return css.slice(at, css.indexOf('}', at));
}

test('the reading area is the only scrolling zone between a fixed header and footer', () => {
  const reading = container('reading');
  assert.match(reading, /^<div id="reading"/);
  for (const id of ['latest', 'previous-toggle', 'previous-list']) assert.match(reading, new RegExp('id="' + id + '"'), '#' + id + ' is in #reading');
  assert.ok(reading.indexOf('id="latest"') < reading.indexOf('id="previous-toggle"'), 'the toggle sits below the latest answer');
  assert.match(cssRule('#reading'), /overflow-y: auto;/);
  assert.match(cssRule('#reading'), /flex: 1 1 auto;/);
  assert.match(cssRule('#header'), /flex: 0 0 auto;/);
  assert.match(cssRule('#footer'), /flex: 0 0 auto;/);
  for (const gone of ['id="messages"', 'id="composer"', 'id="input"', 'id="send-btn"', 'id="placeholder"', 'id="composer-bottom"']) {
    assert.ok(!html.includes(gone), gone + ' is still in index.html');
  }
  assert.ok(!src.includes("$('#messages')") && !src.includes("$('#input')") && !src.includes('send-btn'), 'renderer no longer drives the composer');
});

test('the footer is one row: answer actions, a gap, Smart, Auto and Ask', () => {
  const row = container('action-row');
  assert.ok(!/class="sep"/.test(row), 'no separators');
  assert.ok(!html.includes('shortcut-hint') && !src.includes('shortcut-hint') && !css.includes('shortcut-hint'), 'hint spans are gone');
  const order = ['data-mode="say"', 'data-mode="assist"', 'data-mode="followup"', 'data-mode="recap"', 'class="ar-gap"', 'id="smart-toggle"', 'id="auto-toggle"', 'id="ask-btn"'];
  let last = -1;
  for (const marker of order) {
    const at = row.indexOf(marker);
    assert.ok(at > last, marker + ' is in the footer row, in order');
    last = at;
  }
  assert.match(cssRule('#action-row'), /flex-wrap: nowrap;/);
  const footer = container('footer');
  for (const id of ['heard', 'ask-field', 'action-row', 'practice-row']) assert.match(footer, new RegExp('id="' + id + '"'), '#' + id + ' is in the footer');
  assert.ok(footer.indexOf('id="ask-field"') < footer.indexOf('id="action-row"'), 'the Ask field opens above the row');
});

test('compact makes Assist, Follow-up and Recap icon-only when the row would overflow', () => {
  const fit = functionBody('fitActionRow');
  assert.match(fit, /scrollWidth > row\.clientWidth/);
  assert.match(fit, /classList\.toggle\('compact'/);
  assert.match(src, /new ResizeObserver\(fitActionRow\)\.observe\(\$\('#action-row'\)\)/);
  assert.match(functionBody('applyModeLabels'), /fitActionRow\(\)/);
  assert.match(css, /#action-row\.compact \.act:not\(\.act-primary\) \.lbl \{ display: none; \}/);
});

test('shortcut hints live in each button title, which keeps the full name', () => {
  const { actionTitle } = section('// ---- action titles', '// ---- end action titles', ['actionTitle'],
    'function modeLabel(mode, kind) { return kind === "presentation" && mode === "say" ? "Answer audience" : ({ say: "What should I say?", followup: "Follow-up", assist: "Assist", recap: "Recap" })[mode]; }\n');
  assert.match(actionTitle('say', 'general', 'Ctrl+Shift+Enter'), /^What should I say\? \(Ctrl\+Shift\+Enter\)/);
  assert.match(actionTitle('say', 'presentation', ''), /^Answer audience · /);
  assert.match(actionTitle('assist', 'general', 'Ctrl+Enter'), /^Assist \(Ctrl\+Enter\)/);
  assert.equal(actionTitle('followup', 'general', ''), 'Follow-up');
  assert.equal(actionTitle('recap', 'general', ''), 'Recap');
  assert.match(functionBody('applyModeLabels'), /\.title = actionTitle\(/);
  assert.match(functionBody('updateShortcutHints'), /applyModeLabels\(\)/);
});

test('answers are sized from --answer-px; previous answers at 0.85x', () => {
  assert.match(cssRule('.ai-text'), /font-size: var\(--answer-px, 18px\);/);
  assert.match(cssRule('#previous-list .ai-text'), /font-size: calc\(var\(--answer-px, 18px\) \* 0\.85\);/);
});

test('no category pill, separators or speech auto-fill remain', () => {
  for (const gone of ['category-pill', 'response-sep', 'stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating',
    'latestSpeech', 'withoutTrimmedMark', 'inputFromSTT', 'autoFillInputFromSTT', 'Ready to answer', 'interim-transcript', 'input-interim']) {
    assert.ok(!src.includes(gone), gone + ' is still in renderer.js');
    assert.ok(!css.includes(gone), gone + ' is still in styles.css');
  }
});

test('the question above an answer is one muted line', () => {
  const bubble = cssRule('.user-bubble');
  assert.match(bubble, /white-space: nowrap;/);
  assert.match(bubble, /text-overflow: ellipsis;/);
  assert.match(bubble, /overflow: hidden;/);
});

test('Previous answers lists earlier answers newest first, collapsed when a new one starts', () => {
  const { previousLabel } = section('// ---- previous answers helpers', '// ---- end previous answers helpers', ['previousLabel']);
  assert.equal(previousLabel(3, false), '▸ Previous answers (3)');
  assert.equal(previousLabel(1, true), '▾ Previous answers (1)');
  const archive = functionBody('archiveLatest');
  assert.match(archive, /previousList\.prepend\(/);
  assert.match(archive, /setPreviousOpen\(false\)/);
  const start = src.slice(src.indexOf("cue.on('llm:start'"), src.indexOf("cue.on('", src.indexOf("cue.on('llm:start'") + 10));
  assert.match(start, /archiveLatest\(\)/);
  assert.match(html, /<button id="previous-toggle" class="previous-toggle hidden" type="button"/);
  assert.match(html, /<div id="previous-list" class="previous-list hidden"><\/div>/);
});

test('the Ask field sends through the ask path; Enter sends, Esc closes', () => {
  assert.match(html, /<div id="ask-field" class="ask-field hidden"><input id="ask-input" type="text"/);
  const send = functionBody('sendAsk');
  assert.match(send, /runMode\('ask', text\)/);
  assert.match(send, /closeAsk\(\)/);
  const keys = src.slice(src.indexOf("askInput.addEventListener('keydown'"), src.indexOf('});', src.indexOf("askInput.addEventListener('keydown'")));
  assert.match(keys, /e\.key === 'Enter'[\s\S]*sendAsk\(\)/);
  assert.match(keys, /e\.key === 'Escape'[\s\S]*closeAsk\(\)/);
  assert.match(src, /\$\('#ask-btn'\)\.addEventListener\('click'/);
});

test('the heard caption shows only final Them lines while listening', () => {
  const { heardCaption } = section('// ---- heard caption helpers', '// ---- end heard caption helpers', ['heardCaption']);
  assert.equal(heardCaption('Why us?'), 'Heard: “Why us?”');
  const handler = src.slice(src.indexOf("cue.on('transcript',"), src.indexOf("cue.on('", src.indexOf("cue.on('transcript',") + 10));
  assert.match(handler, /if \(channel === 'them' && capturing\) showHeard\(text\);/);
  assert.equal(src.split('showHeard(').length - 1, 2, 'showHeard is defined once and called only from the transcript handler');
  assert.match(functionBody('showHeard'), /\.textContent = heardCaption\(/);
  assert.doesNotMatch(functionBody('showHeard'), /innerHTML/);
  const capture = src.slice(src.indexOf("cue.on('capture:state', ({ active })"), src.indexOf("cue.on('", src.indexOf("cue.on('capture:state', ({ active })") + 10));
  assert.match(capture, /clearHeard\(\)/);
  assert.match(functionBody('clearConversationUI'), /clearHeard\(\)/);
  const heard = cssRule('#heard');
  assert.match(heard, /white-space: nowrap;/);
  assert.match(heard, /text-overflow: ellipsis;/);
});

test('the scroll shortcuts scroll the reading area', () => {
  const handler = src.slice(src.indexOf("cue.on('answers:scroll'"), src.indexOf('});', src.indexOf("cue.on('answers:scroll'")));
  assert.match(handler, /reading\.scrollBy\(/);
});

test('the reading area and footer add no transitions or animations', () => {
  for (const marker of ['/* ============================ Reading area', '/* ============================ Footer']) {
    const start = css.indexOf(marker);
    const end = css.indexOf('/* ============================', start + 10);
    assert.ok(start > -1 && end > start, marker + ' styles not found');
    assert.doesNotMatch(css.slice(start, end), /transition|animation/, marker);
  }
});

test('practice swaps the answer buttons only: Smart, Auto and Ask stay in the row', () => {
  const body = functionBody('setPracticeUI');
  assert.doesNotMatch(body, /\$\('#action-row'\)\.classList\.toggle\('hidden'/, 'the whole row is not hidden');
  assert.match(body, /\$\('#action-row'\)\.classList\.toggle\('practicing', active\)/);
  assert.match(css, /#action-row\.practicing > \.act\[data-mode\] \{ display: none; \}/);
  const row = container('action-row');
  for (const id of ['practice-row', 'smart-toggle', 'auto-toggle', 'ask-btn']) assert.match(row, new RegExp('id="' + id + '"'), '#' + id + ' is in the row');
  const practice = container('practice-row');
  for (const id of ['smart-toggle', 'auto-toggle', 'ask-btn']) assert.ok(!practice.includes('id="' + id + '"'), '#' + id + ' is not inside the practice controls');
  assert.ok(row.indexOf('id="practice-row"') < row.indexOf('class="ar-gap"'), 'practice controls sit where the answer buttons were');
});

test('an answer started without llm:start takes the scroll pin away from the archived one', () => {
  assert.match(functionBody('startAi'), /pinnedGroup = null;/);
});

test('the Auto tooltip describes the main button, not Enter', () => {
  const body = functionBody('syncAutoButton');
  assert.doesNotMatch(body, /press Enter/);
  assert.match(body, /the main button or its shortcut/);
});

// ── Layout modes, resize grip, overlays and the History drawer ───────────────

test('#app gets .narrow or .wide from layoutMode on load and on resize', () => {
  assert.match(preload, /panelLayout: \{ BREAKPOINT, layoutMode \}/);
  const body = functionBody('applyLayoutMode');
  assert.match(body, /cue\.panelLayout\.layoutMode\(window\.innerWidth\)/);
  assert.match(body, /classList\.toggle\('narrow', mode === 'narrow'\)/);
  assert.match(body, /classList\.toggle\('wide', mode === 'wide'\)/);
  assert.match(body, /fitActionRow\(\)/, 'the compact check re-runs on a mode change');
  assert.match(body, /renderPresenterStrip\(\)/);
  assert.match(src, /window\.addEventListener\('resize', applyLayoutMode\);\n\s*applyLayoutMode\(\);/);
});

test('the header and panel follow the window width instead of a fixed 624 px', () => {
  assert.doesNotMatch(cssRule('#header'), /624px/);
  assert.doesNotMatch(css, /#panel-wrap \{[^}]*624px/);
});

test('the resize grip starts and ends a main-side resize', () => {
  assert.match(container('panel'), /<div id="resize-grip"/, 'the grip is inside the panel, so Hide hides it');
  const start = src.indexOf("resizeGrip.addEventListener('pointerdown'");
  assert.ok(start > -1, 'pointerdown handler not found');
  const down = src.slice(start, src.indexOf('});', start));
  assert.match(down, /resizeGrip\.setPointerCapture\(e\.pointerId\)/);
  assert.match(down, /cue\.resizeStart\(\)/);
  assert.match(src, /resizeGrip\.addEventListener\('pointerup', endResize\)/);
  assert.match(src, /resizeGrip\.addEventListener\('lostpointercapture', endResize\)/);
  assert.match(functionBody('endResize'), /cue\.resizeEnd\(\)/);
  const selectors = src.match(/const UI_SELECTORS = '([^']+)'/)[1].split(',').map((s) => s.trim());
  assert.ok(selectors.includes('#resize-grip'), 'the grip is in the click-through rectangles');
  assert.match(css, /#panel\.collapsed \{ display: none; \}/);
});

test('Settings, Sessions and the publik card grow the window; History does not', () => {
  for (const name of ['openSettings', 'closeSettings', 'openSessions', 'closeSessions', 'renderPublikDialog', 'hidePublikDialog']) {
    assert.match(functionBody(name), /syncOverlay\(\)/, name + ' syncs the overlay');
  }
  const body = functionBody('syncOverlay');
  for (const id of ['settings-scrim', 'sessions-scrim', 'publik-scrim']) assert.match(body, new RegExp(id));
  assert.match(body, /cue\.setOverlay\(open\)/);
  for (const name of ['showSidebar', 'hideSidebar', 'toggleSidebar']) {
    assert.doesNotMatch(functionBody(name), /setOverlay|syncOverlay/, name + ' does not grow the window');
  }
  assert.match(functionBody('toggleHide'), /if \(!collapsed && overlayOpen\) cue\.setOverlay\(true\);/, 'an overlay left open while hidden grows again on Show');
});

test('History is a drawer inside the panel, over the reading area', () => {
  assert.match(container('panel-wrap'), /id="transcript-sidebar"/);
  const rule = cssRule('.transcript-sidebar');
  assert.match(rule, /position: absolute;/);
  assert.match(rule, /top: 0;/);
  assert.match(rule, /right: 0;/);
  assert.match(rule, /bottom: 0;/);
  assert.match(rule, /width: min\(360px, 90%\);/);
  assert.doesNotMatch(css, /sidebar-open/, 'the panel no longer shifts aside for it');
  assert.doesNotMatch(src, /sidebar-open/);
});

test('wide interview and general answers keep about 70 characters per line', () => {
  assert.match(css, /#app\.wide #panel-body:not\(\.presenting\) > #reading \{[^}]*70ch/);
});

test('practice re-checks whether the footer row fits', () => {
  assert.match(functionBody('setPracticeUI'), /fitActionRow\(\);\s*$/);
});

test('layout, grip and drawer add no transitions or animations', () => {
  const start = css.indexOf('/* ============================ Layout modes');
  const end = css.indexOf('/* end layout modes */', start);
  assert.ok(start > -1 && end > start, 'layout mode styles not found');
  assert.doesNotMatch(css.slice(start, end), /transition|animation/);
});
