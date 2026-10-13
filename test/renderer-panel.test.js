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
