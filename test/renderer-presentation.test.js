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
  return new Function(src.slice(start, end) + '\nreturn { parseLines, deckStatusText };')();
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
  assert.match(html, /<select id="setup-display"[^>]*class="[^"]*hidden/, 'display picker stays hidden until Task 11');
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
