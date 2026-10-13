const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// renderer.js is a browser script with no harness: the pure helpers are
// evaluated from their source, the wiring is guarded by inspection.
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer/styles.css'), 'utf8');

function helpers() {
  const start = src.indexOf('// ---- presentation helpers');
  const end = src.indexOf('// ---- end presentation helpers', start);
  assert.ok(start > -1 && end > start, 'presentation helpers not found');
  return new Function(src.slice(start, end) + '\nreturn { parseLines, deckStatusText, formatTimeLeft, pacingChip, toolbarStatus, stripStatusLine, displayOptions, visiblePoints };')();
}

test('deck status text', () => {
  const { deckStatusText } = helpers();
  assert.equal(deckStatusText({ fileName: 'l4.pptx', slideCount: 32, done: 3, total: 5 }), 'l4.pptx · 32 slides · Talking points: generating… 3 of 5 batches');
  assert.equal(deckStatusText({ fileName: 'l4.pptx', slideCount: 32, done: 5, total: 5, failed: 2 }), 'l4.pptx · 32 slides · 2 slides not generated');
  assert.equal(deckStatusText({ fileName: 'l4.pptx', slideCount: 32, done: 5, total: 5, failed: 0 }), 'l4.pptx · 32 slides');
  assert.equal(deckStatusText({ fileName: 'a.pdf', slideCount: 1, failed: 1 }), 'a.pdf · 1 slide · 1 slide not generated');
  assert.equal(deckStatusText({ fileName: 'a.pdf', slideCount: 4 }), 'a.pdf · 4 slides', 'no progress known');
});

test('parseLines splits on newlines, trims and drops empty lines', () => {
  const { parseLines } = helpers();
  assert.deepEqual(parseLines('  one \n\n two\r\n   \nthree'), ['one', 'two', 'three']);
  assert.deepEqual(parseLines(''), []);
  assert.deepEqual(parseLines(undefined), []);
});

test('the kind selector offers Presentation', () => {
  assert.match(html, /<button data-kind="presentation" type="button">Presentation<\/button>/);
});

test('presentation setups have duration, display, and a deck block', () => {
  assert.match(html, /<input id="setup-duration"[^>]*type="number"[^>]*min="5"[^>]*max="240"/);
  assert.match(html, /<div id="setup-display-block" class="hidden">[\s\S]*<select id="setup-display"/, 'display picker starts hidden');
  for (const id of ['deck-import', 'deck-status', 'deck-review']) assert.match(html, new RegExp('id="' + id + '"'));
});

test('the presentation form uses its own label and placeholder', () => {
  assert.match(src, /'Talk and audience'/);
  assert.match(src, /'e\.g\. Intro to graph algorithms, 2nd-year CS students, comfortable with Python\.'/);
  assert.match(src, /presentation: 'Talk'/, 'setups summary label');
});

test('switching to presentation with no content turns saving on', () => {
  assert.match(src, /if \(!s\.conversation && !s\.notes\) \$\('#setup-save'\)\.checked = b\.dataset\.kind !== 'general';/);
});

test('a missing deck file is reported', () => {
  assert.match(src, /'Deck file missing — import it again'/);
});

test('slides are saved on blur through deckUpdateSlide with parsed lines', () => {
  assert.match(src, /cue\.deckUpdateSlide\(setupId, slide\.n, \{/);
  assert.match(src, /points: parseLines\(/);
  assert.match(src, /questions: parseLines\(/);
  assert.match(src, /cue\.deckRegenerate\(setupId, 'unedited'\)/);
  assert.match(src, /cue\.deckRegenerate\(setupId, slide\.n\)/);
});

test('a deck pointer written by main keeps the next Save current', () => {
  const start = src.indexOf("cue.on('settings:changed'");
  const handler = src.slice(start, src.indexOf("cue.on('", start + 10));
  assert.match(handler, /if \('setups' in patch\) \{/);
  assert.match(handler, /refreshSettingsRevision\(\)/);
  assert.match(src, /settings\.settingsMeta = fresh\.settingsMeta;/);
});

test('import saves the setup first so main can find it', () => {
  const start = src.indexOf("$('#deck-import').addEventListener");
  assert.ok(start > -1);
  const body = src.slice(start, start + 1200);
  assert.ok(body.indexOf('saveSettings()') > -1 && body.indexOf('saveSettings()') < body.indexOf('cue.deckImport('));
});

test('the deck UI adds no transitions or animations', () => {
  const start = css.indexOf('/* Presentation setups');
  assert.ok(start > -1, 'presentation styles not found');
  const block = css.slice(start, css.indexOf('/* end presentation setups */', start));
  assert.doesNotMatch(block, /transition|animation/);
});

test('the deck block renders while Settings is still loading its form', () => {
  // openSettings fills the form (and so renders the deck) before it sets
  // settingsFormReady; the deck block only reads, so it must not wait for it.
  const start = src.indexOf('async function renderDeckBlock()');
  assert.ok(start > -1);
  const guard = src.slice(start, src.indexOf('\n', src.indexOf('return;', start)));
  assert.doesNotMatch(guard, /settingsFormReady/);
});

function update({ current = 7, slideCount = 32, offDeck = false, status = 'on', minutes = 0, title = 'Big-O intuition', matching = 'ok' } = {}) {
  return {
    snapshot: { current, slideCount, offDeck, remainingMs: 1120000, pacing: { status, minutes }, skipped: [], flags: [], timeline: [] },
    slide: current ? { n: current, title, points: ['a', 'b'] } : null,
    next: null,
    matching
  };
}

test('formatTimeLeft renders m:ss and never goes negative', () => {
  const { formatTimeLeft } = helpers();
  assert.equal(formatTimeLeft(0), '0:00');
  assert.equal(formatTimeLeft(-5000), '0:00');
  assert.equal(formatTimeLeft(1120000), '18:40');
  assert.equal(formatTimeLeft(65000), '1:05');
  assert.equal(formatTimeLeft(45 * 60000), '45:00');
  assert.equal(formatTimeLeft(undefined), '0:00');
});

test('pacingChip', () => {
  const { pacingChip } = helpers();
  assert.equal(pacingChip({ status: 'on', minutes: 0 }), '✓ on track');
  assert.equal(pacingChip({ status: 'ahead', minutes: 2 }), '▲ ahead 2 min');
  assert.equal(pacingChip({ status: 'behind', minutes: 4 }), '▼ behind 4 min');
  assert.equal(pacingChip({ status: 'none', minutes: 0 }), '');
  assert.equal(pacingChip(null), '');
});

test('toolbarStatus', () => {
  const { toolbarStatus } = helpers();
  assert.equal(toolbarStatus(update()), '7/32 · ✓');
  assert.equal(toolbarStatus(update({ status: 'ahead', minutes: 2 })), '7/32 · ▲');
  assert.equal(toolbarStatus(update({ status: 'behind', minutes: 4 })), '7/32 · ▼');
  assert.equal(toolbarStatus(update({ offDeck: true })), 'off-deck');
  assert.equal(toolbarStatus(update({ current: null, slideCount: 0, status: 'none' })), '');
  assert.equal(toolbarStatus(null), '');
});

test('stripStatusLine', () => {
  const { stripStatusLine } = helpers();
  assert.equal(stripStatusLine(update()), 'Slide 7 / 32 · Big-O intuition');
  assert.equal(stripStatusLine(update({ current: null })), 'Slide – / 32');
  assert.equal(stripStatusLine(update({ offDeck: true })), 'Slide 7 / 32 · Big-O intuition · off-deck');
  assert.equal(stripStatusLine(update({ matching: 'failed' })), 'Slide 7 / 32 · Big-O intuition · ?');
  assert.equal(stripStatusLine(update({ matching: 'disabled' })), 'Slide 7 / 32 · Big-O intuition · ?', 'deck but matching off');
  assert.equal(stripStatusLine(update({ current: null, slideCount: 0, matching: 'disabled' })), '', 'no deck: no slide line');
  assert.equal(stripStatusLine(update({ title: '' })), 'Slide 7 / 32');
});

test('visiblePoints collapse to the first bullet while an answer is shown', () => {
  const { visiblePoints } = helpers();
  assert.deepEqual(visiblePoints(['a', 'b', 'c'], false), ['a', 'b', 'c']);
  assert.deepEqual(visiblePoints(['a', 'b', 'c'], true), ['a']);
  assert.deepEqual(visiblePoints([], true), []);
  assert.deepEqual(visiblePoints(undefined, false), []);
});

test('displayOptions: picker only with more than one display; a missing display is reported', () => {
  const { displayOptions } = helpers();
  const two = [{ id: '1', label: 'Built-in', width: 1512, height: 982 }, { id: '2', label: 'Display 2', width: 1920, height: 1080 }];
  const a = displayOptions(two, '');
  assert.equal(a.show, true);
  assert.equal(a.missing, false);
  assert.deepEqual(a.options.map((o) => o.value), ['', '1', '2']);
  assert.equal(a.options[0].label, 'Primary display');
  assert.equal(a.options[2].label, 'Display 2 · 1920×1080');
  assert.equal(displayOptions([two[0]], '').show, false);
  const gone = displayOptions(two, '99');
  assert.equal(gone.missing, true);
  assert.equal(gone.show, true);
  assert.ok(gone.options.some((o) => o.value === '99'), 'the saved choice is kept until changed');
  assert.equal(displayOptions([two[0]], '99').show, true, 'shown so a missing display can be cleared');
  assert.equal(displayOptions([], '').show, false);
});

test('the presenter strip, toolbar pill and display note are in the page', () => {
  assert.match(html, /<div id="panel-main">\s*<div id="presenter-strip" class="presenter-strip hidden"/);
  for (const id of ['ps-status', 'ps-time', 'ps-pace', 'ps-points', 'ps-next', 'ps-flags', 'tb-presentation', 'setup-display-note']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(src, /'That display is not connected; watching the primary display\.'/);
  assert.match(src, /'Share a window \(your slideshow\), not your whole screen, and keep cue on your laptop display\.'/);
});

test('the strip follows presentation:update and the active setup kind', () => {
  assert.match(src, /cue\.on\('presentation:update'/);
  assert.match(src, /setup\.kind === 'presentation'/);
  assert.match(src, /cue\.displaysList\(\)/);
});

test('the first-use hint is remembered per setup with guarded storage', () => {
  const start = src.indexOf('function maybeShowPresentationHint');
  assert.ok(start > -1);
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /try \{/);
  assert.match(body, /localStorage/);
  assert.match(body, /setup\.id/);
});

test('the strip adds no transitions or animations', () => {
  const start = css.indexOf('/* Presenter strip');
  assert.ok(start > -1, 'presenter strip styles not found');
  const block = css.slice(start, css.indexOf('/* end presenter strip */', start));
  assert.doesNotMatch(block, /transition|animation/);
});

test('modeLabel relabels say and followup for presentation setups only', () => {
  const start = src.indexOf('// ---- mode label');
  const end = src.indexOf('// ---- end mode label', start);
  assert.ok(start > -1 && end > start, 'mode label helper not found');
  const { modeLabel } = new Function(src.slice(start, end) + '\nreturn { modeLabel };')();
  assert.equal(modeLabel('say', 'presentation'), 'Answer audience');
  assert.equal(modeLabel('followup', 'presentation'), 'Check understanding');
  assert.equal(modeLabel('say', 'interview'), 'What should I say?');
  assert.equal(modeLabel('say', 'general'), 'What should I say?');
  assert.equal(modeLabel('followup', undefined), 'Follow-up');
  assert.equal(modeLabel('recap', 'presentation'), 'Recap');
  assert.match(src, /applyModeLabels\(\)/);
});
