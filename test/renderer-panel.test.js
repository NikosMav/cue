const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const panelLayout = require('../src/panel-layout');

// renderer.js is a browser script with no harness: the pure helpers are
// evaluated from their source, the wiring is guarded by inspection.
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(root, 'renderer/styles.css'), 'utf8').replace(/\r\n/g, '\n');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n/g, '\n');

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

// A row whose content width depends on the fit classes on it.
function fakeRow(clientWidth, widths) {
  const classes = new Set();
  return {
    clientWidth,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n)
    },
    get scrollWidth() { return classes.has('tight') ? widths.tight : classes.has('compact') ? widths.compact : widths.full; },
    classes
  };
}

test('the footer row compacts, then compacts further, instead of clipping', () => {
  const { fitRow } = section('// ---- footer fit', '// ---- end footer fit', ['fitRow']);
  const widths = { full: 700, compact: 560, tight: 400 };
  const roomy = fakeRow(800, widths);
  fitRow(roomy);
  assert.deepEqual([...roomy.classes], [], 'a row that fits keeps its labels');
  const medium = fakeRow(600, widths);
  fitRow(medium);
  assert.deepEqual([...medium.classes], ['compact']);
  const narrow = fakeRow(450, widths);
  fitRow(narrow);
  assert.deepEqual([...narrow.classes].sort(), ['compact', 'tight']);
  // Re-fitting a wider row drops the classes it no longer needs.
  narrow.clientWidth = 800;
  fitRow(narrow);
  assert.deepEqual([...narrow.classes], []);
  assert.match(functionBody('fitActionRow'), /fitRow\(\$\('#action-row'\)\)/);
  assert.match(src, /new ResizeObserver\(fitActionRow\)\.observe\(\$\('#action-row'\)\)/);
  assert.match(functionBody('applyModeLabels'), /fitActionRow\(\)/);
});

test('compact makes the secondary actions, Smart, Auto and Ask icon-only and shortens practice', () => {
  assert.match(css, /#action-row\.compact \.act:not\(\.act-primary\) \.lbl \{ display: none; \}/);
  assert.match(css, /#action-row\.compact \.smart-pill \.lbl \{ display: none; \}/);
  assert.match(css, /#action-row \.lbl-short \{ display: none; \}/);
  assert.match(css, /#action-row\.compact #practice-row \.lbl \{ display: none; \}/);
  assert.match(css, /#action-row\.compact #practice-row \.lbl-short \{ display: inline-flex; \}/);
  assert.match(css, /#action-row\.tight \.act-primary \.lbl, #action-row\.tight \.practice-badge \{ display: none; \}/);
  for (const id of ['smart-toggle', 'auto-toggle', 'ask-btn']) {
    const at = html.indexOf('id="' + id + '"');
    const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('</button>', at));
    assert.match(tag, /<span class="lbl">/, '#' + id + ' has a label span');
    assert.match(tag, /title="/, '#' + id + ' keeps its name in the title');
  }
  const practice = container('practice-row');
  for (const [id, short] of [['practice-next', 'Next'], ['practice-rate', 'Rate'], ['practice-end', 'End']]) {
    const at = practice.indexOf('id="' + id + '"');
    const tag = practice.slice(at, practice.indexOf('</button>', at));
    assert.match(tag, /<span class="lbl">/, '#' + id + ' has a full label');
    assert.match(tag, new RegExp('<span class="lbl-short">' + short + '</span>'), '#' + id + ' is "' + short + '" in compact');
  }
  const voiceAt = practice.indexOf('id="practice-voice"');
  const voice = practice.slice(voiceAt, practice.indexOf('</button>', voiceAt));
  assert.match(voice, /<span class="lbl-short ic"><\/span>/, 'Voice is an icon in compact');
  const sync = functionBody('syncPracticeVoice');
  assert.match(sync, /\.lbl'\)\.textContent = 'Voice: '/);
  assert.match(sync, /icon\(on \? 'volume-2' : 'volume-x'/);
  assert.doesNotMatch(sync, /\$\('#practice-voice'\)\.textContent =/, 'the label spans are not overwritten');
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

test('the question above an answer is muted and clipped', () => {
  const bubble = cssRule('.user-bubble');
  assert.match(bubble, /overflow: hidden;/);
  assert.match(bubble, /color: var\(--tx-mut\)/);
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
  // A long question keeps its latest words: the end is what is being answered.
  const long = Array.from({ length: 80 }, (_, i) => 'word' + i).join(' ');
  const capped = heardCaption(long);
  assert.ok(capped.startsWith('Heard: “… '), capped.slice(0, 20));
  assert.ok(capped.endsWith('word79”'));
  assert.ok(capped.length <= 'Heard: “… ”'.length + 240);
  const handler = src.slice(src.indexOf("cue.on('transcript',"), src.indexOf("cue.on('", src.indexOf("cue.on('transcript',") + 10));
  assert.match(handler, /if \(channel === 'them' && capturing\) showHeard\(question \|\| text\);/);
  assert.equal(src.split('showHeard(').length - 1, 2, 'showHeard is defined once and called only from the transcript handler');
  assert.match(functionBody('showHeard'), /\.textContent = heardCaption\(/);
  assert.doesNotMatch(functionBody('showHeard'), /innerHTML/);
  const capture = src.slice(src.indexOf("cue.on('capture:state', ({ active })"), src.indexOf("cue.on('", src.indexOf("cue.on('capture:state', ({ active })") + 10));
  assert.match(capture, /clearHeard\(\)/);
  assert.match(functionBody('clearConversationUI'), /clearHeard\(\)/);
  const heard = cssRule('#heard');
  assert.match(heard, /overflow: hidden;/);
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
  assert.match(body, /anyOverlayOpen\(\)/);
  const scrims = src.slice(src.indexOf('const OVERLAY_SCRIMS = ['), src.indexOf('];', src.indexOf('const OVERLAY_SCRIMS = [')));
  for (const id of ['settings-scrim', 'sessions-scrim', 'publik-scrim']) assert.ok(scrims.includes("'" + id + "'"), id + ' is an overlay');
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

test('the empty state names the Start button, not the old ■ icon', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(src, /■ button above/);
  assert.match(src, /Press <strong>Start<\/strong> above to listen/);
});

test('a button-started answer is labelled with the button name for the active setup', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /userBubble === modeLabel\(mode\) \? modeLabel\(mode, setup && setup\.kind\) : userBubble/);
});

test('a text size step takes the saved revision so the next Settings save is not rejected', () => {
  const body = functionBody('changeTextSize');
  assert.match(body, /const saved = await queueSettingsPatch\(\{ answerTextPx: size \}\);/);
  assert.match(body, /if \(saved && saved\.settingsMeta && settings\) settings\.settingsMeta = saved\.settingsMeta;/);
});

test('an app-link consent request shows the panel first and grows a small window', () => {
  const at = src.indexOf("cue.on('applink:consent-request'");
  const handler = src.slice(at, src.indexOf('\n  });', at));
  const shown = handler.indexOf('showPanel();');
  assert.ok(shown > -1 && shown < handler.indexOf("consentScrim.classList.remove('hidden')"), 'the panel is shown before the sheet');
  assert.match(handler, /consentScrim\.classList\.remove\('hidden'\);\s*syncOverlay\(\);/);
  assert.match(functionBody('answerConsent'), /consentScrim\.classList\.add\('hidden'\);\s*syncOverlay\(\);/);
  assert.match(src, /const OVERLAY_SCRIMS = \['settings-scrim', 'sessions-scrim', 'publik-scrim', 'consent-scrim'\];/);
  assert.match(functionBody('syncOverlay'), /anyOverlayOpen\(\)/);
});

test('Hide is ignored while Settings, Sessions, the publik card or the consent sheet is open', () => {
  const { anyOverlayOpen, open } = section('// ---- overlay state', '// ---- end overlay state', ['anyOverlayOpen', 'open'],
    'const open = new Set(); const document = { getElementById: (id) => ({ classList: { contains: (c) => c === "hidden" && !open.has(id) } }) };\n');
  assert.equal(anyOverlayOpen(), false);
  for (const id of ['settings-scrim', 'sessions-scrim', 'publik-scrim', 'consent-scrim']) {
    open.clear(); open.add(id);
    assert.equal(anyOverlayOpen(), true, id);
  }
  assert.match(functionBody('toggleHide'), /if \(!panelHidden\(\) && anyOverlayOpen\(\)\) return;/);
  const toggle = functionBody('toggleHide');
  assert.ok(toggle.indexOf('anyOverlayOpen()') < toggle.indexOf("classList.toggle('collapsed')"), 'the check comes before anything changes');
});

test('"Use my own key" waits for Settings to fill before choosing the provider', () => {
  assert.match(src, /action: async \(\) => \{ hidePublikDialog\(\); await openSettings\(\); selectByoProvider\(\); \}/);
});

test('the panel, dialogs and history drawer have no drop shadow', () => {
  const rule = (selector) => {
    const start = css.indexOf(selector + ' {');
    assert.ok(start > -1, selector + ' rule not found');
    return css.slice(start, css.indexOf('}', start));
  };
  assert.doesNotMatch(rule('.glass'), /box-shadow/);
  assert.doesNotMatch(rule('.transcript-sidebar'), /box-shadow/);
});

test('the top bar is a compact pill sized to its contents, aligned with the panel', () => {
  const start = css.indexOf('#header {');
  const header = css.slice(start, css.indexOf('}', start));
  assert.doesNotMatch(header, /(^|[^-])width:\s*calc\(100%/m, 'the bar must not stretch to the panel width');
  assert.match(header, /align-self:\s*flex-start/);
  assert.match(header, /margin-left:\s*12px/);
  assert.match(header, /max-width:\s*calc\(100% - 24px\)/);
  const gap = css.slice(css.indexOf('.hd-gap {'), css.indexOf('}', css.indexOf('.hd-gap {')));
  assert.doesNotMatch(gap, /flex:\s*1/, 'the gap no longer grows to fill the bar');
});

test('the ⋯ menu opens under its button, not at the window edge', () => {
  assert.match(src, /function placePanelMenu\(\)/);
  const open = src.slice(src.indexOf("panelMenu.classList.remove('hidden');") - 200, src.indexOf("panelMenu.classList.remove('hidden');") + 120);
  assert.match(open, /placePanelMenu\(\)/);
});

test('Heard shows the whole current question, up to three readable lines, and opens the transcript', () => {
  assert.match(main, /send\('transcript', \{ \.\.\.turn, question: channel === 'them' \? currentQuestion\(transcript, answeredQuestion\) : '' \}\)/);
  assert.match(src, /showHeard\(question \|\| text\)/);
  const rule = css.slice(css.indexOf('#heard {'), css.indexOf('}', css.indexOf('#heard {')));
  assert.match(rule, /-webkit-line-clamp:\s*3/);
  assert.match(rule, /font-size:\s*15px/);
  assert.doesNotMatch(rule, /white-space:\s*nowrap/);
  assert.match(src, /heardEl\.addEventListener\('click', \(\) => showSidebar\(\)\)/);
});

test('the question above an answer shows up to two lines', () => {
  const rule = css.slice(css.indexOf('.user-bubble {'), css.indexOf('}', css.indexOf('.user-bubble {')));
  assert.match(rule, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(rule, /white-space:\s*nowrap/);
});

test('dialog overlays do not darken or blur the window behind them', () => {
  for (const sel of ['#settings-scrim {', '#sessions-scrim {', '#publik-scrim {', '#consent-scrim {']) {
    const rule = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
    assert.doesNotMatch(rule, /background:\s*rgba\(0,\s*0,\s*0/, sel + ' darkens the window');
    assert.doesNotMatch(rule, /backdrop-filter/, sel + ' blurs the window');
  }
});

test('the wide presenter column shows the speaker script, in paragraphs, under smaller key points', () => {
  assert.match(html, /<div id="ps-script" class="ps-script"><\/div>/);
  assert.match(src, /function renderScript\(/);
  const body = src.slice(src.indexOf('function renderScript('), src.indexOf('\n  }\n', src.indexOf('function renderScript(')));
  assert.ok(body.includes(String.raw`.split(/\n\s*\n/)`), 'blank lines separate paragraphs');
  assert.match(body, /\.textContent = /);
  assert.doesNotMatch(body, /innerHTML = [^'"]/);
  assert.match(css, /\.ps-script p \{[^}]*font-size: calc\(var\(--answer-px, 18px\) \* 0\.9\)/);
  assert.match(css, /#app\.narrow \.ps-script \{ display: none; \}/);
  assert.match(css, /\.presenter-strip\.has-script \.ps-points li \{[^}]*font-size: calc\(var\(--answer-px, 18px\) \* 0\.72\)/);
});

test('Review slides edits a Script per slide', () => {
  assert.match(src, /script\.dataset\.field = 'script';/);
  assert.match(src, /script: fields\.script\.value\.trim\(\)\.slice\(0, 2400\)/);
  assert.match(src, /const DECK_BATCH_SIZE = 4;/);
  assert.doesNotMatch(src, /\/ 8\)/, 'batch estimates use DECK_BATCH_SIZE');
  assert.match(src, /points: parseLines\(fields\.points\.value\)\.map\(\(line\) => line\.slice\(0, 160\)\)/);
  assert.match(src, /script: slide\.script \|\| ''/);
});

test('wide presenting: the script column widens while no answer is shown', () => {
  assert.match(src, /strip\.classList\.toggle\('has-answer', !!presentationAnswerShown\);/);
  assert.match(css, /#app\.wide #panel-body\.presenting > \.presenter-strip:not\(\.has-answer\) \{ flex-basis: 60%; \}/);
});

test('the empty state says cue is listening once listening has started', () => {
  const { emptyStateText } = section('// ---- empty state helpers', '// ---- end empty state helpers', ['emptyStateText']);
  assert.match(emptyStateText('presentation', false), /Press <strong>Start<\/strong> above to listen/);
  assert.match(emptyStateText('presentation', true), /^<strong>Listening\.<\/strong>/);
  assert.doesNotMatch(emptyStateText('presentation', true), /Press <strong>Start/);
  assert.match(emptyStateText('interview', true), /What should I say\?/);
  assert.match(emptyStateText('general', false), /^<strong>Ready\.<\/strong>/);
  const capture = src.slice(src.indexOf("cue.on('capture:state', (st) =>"), src.indexOf('\n', src.indexOf("cue.on('capture:state', (st) =>")));
  assert.match(capture, /refreshEmptyState\(\)/);
});

test('Settings has a Script length choice for presentation setups', () => {
  assert.match(html, /<select id="setup-script-length"[^>]*>/);
  for (const v of ['short', 'standard', 'detailed']) assert.match(html, new RegExp('<option value="' + v + '"'));
  assert.match(src, /\$\('#setup-script-length'\)\.value = setup\.scriptLength \|\| 'standard';/);
  assert.match(src, /patch\.scriptLength = \$\('#setup-script-length'\)\.value;/);
  assert.match(html, /Applies to newly generated scripts/);
});

test('slide frames come from a low-rate screen stream, sized and laid out like the main-process grab', () => {
  const { frameSize, toBgra } = section('// ---- slide frame helpers', '// ---- end slide frame helpers', ['frameSize', 'toBgra']);
  assert.deepEqual(frameSize(3440, 1440, 68, 64), { width: 68, height: 28 }, 'fits inside the box, keeping the aspect ratio');
  assert.deepEqual(frameSize(1920, 1080, 68, 64), { width: 68, height: 38 });
  assert.deepEqual(frameSize(1080, 1920, 68, 64), { width: 36, height: 64 });
  assert.deepEqual(Array.from(toBgra(new Uint8ClampedArray([10, 20, 30, 255, 1, 2, 3, 4]))), [30, 20, 10, 255, 3, 2, 1, 4], 'NativeImage bitmaps are BGRA');
  assert.match(src, /chromeMediaSource: 'desktop'/);
  assert.match(src, /cue\.on\('frames:start'/);
  assert.match(src, /cue\.on\('frames:stop'/);
});
