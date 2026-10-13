const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDeck, fingerprint, DeckError } = require('../src/deck-extract');
const { makePptx, makePdf } = require('./fixtures/make-deck');

test('pptx order follows sldIdLst, not file names, and hidden slides are skipped', async () => {
  const slides = Array.from({ length: 11 }, (_, i) => ({ title: 'T' + (i + 1) }));
  slides[2].hidden = true;
  const buf = await makePptx(slides, { order: [10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11] });
  const { slides: out } = await extractDeck(buf, 'pptx');
  assert.deepEqual(out.map(s => s.title), ['T10', 'T1', 'T2', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T11']);
  assert.deepEqual(out.map(s => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('pptx title, body lines and notes body only', async () => {
  const buf = await makePptx([{ ctrTitle: 'Big-O', body: ['Count steps', '', 'Drop constants'], notes: 'Say the phone book analogy' }]);
  const [s] = (await extractDeck(buf, 'pptx')).slides;
  assert.equal(s.title, 'Big-O');
  assert.equal(s.body, 'Count steps\nDrop constants');
  assert.equal(s.notes, 'Say the phone book analogy');
  assert.equal(s.fingerprint, fingerprint('Big-O', 'Count steps\nDrop constants'));
});

test('text in grouped shapes, tables and fields is extracted', async () => {
  const xml = '<p:grpSp><p:sp><p:txBody><a:p><a:r><a:t>Grouped</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp>' +
    '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
    '<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>Field</a:t></a:fld></a:p></p:txBody></p:sp>';
  const [s] = (await extractDeck(await makePptx([{ title: 'X', xml }]), 'pptx')).slides;
  assert.equal(s.body, 'Grouped\nCell\nField');
});

test('a slide with no text becomes "Slide N"; long text is truncated', async () => {
  const buf = await makePptx([{ title: 'A' }, {}, { title: 'C', body: ['x'.repeat(2500)], notes: 'y'.repeat(3500) }]);
  const out = (await extractDeck(buf, 'pptx')).slides;
  assert.equal(out[1].title, 'Slide 2');
  assert.equal(out[2].body.length, 2000 + '\n[…truncated]'.length);
  assert.ok(out[2].body.endsWith('\n[…truncated]'));
  assert.equal(out[2].notes.length, 3000 + '\n[…truncated]'.length);
});

test('a non-zip or encrypted pptx fails with a DeckError', async () => {
  await assert.rejects(extractDeck(Buffer.from('D0CF11E0 not a zip'), 'pptx'), (e) => e instanceof DeckError && /not a valid PowerPoint file/.test(e.message));
});

test('more than 150 visible slides fails with a DeckError', async () => {
  const buf = await makePptx(Array.from({ length: 151 }, (_, i) => ({ title: 'S' + i })));
  await assert.rejects(extractDeck(buf, 'pptx'), (e) => e instanceof DeckError && /150/.test(e.message));
});

test('pdf: one slide per page, first line is the title, no notes; a text-less page is an image slide', async () => {
  const out = (await extractDeck(makePdf([['Graphs', 'Nodes and edges'], []]), 'pdf')).slides;
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].title, out[0].body, out[0].notes], ['Graphs', 'Nodes and edges', '']);
  assert.equal(out[1].title, 'Slide 2');
});

test('a:br soft line breaks become a space in titles and body lines', async () => {
  const run = (t) => '<a:r><a:t>' + t + '</a:t></a:r>';
  const ph = (attrs, inner) => '<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr><p:ph ' + attrs + '/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>' + inner + '</p:txBody></p:sp>';
  const xml = ph('type="title"', '<a:p>' + run('Line1') + '<a:br/>' + run('Line2') + '</a:p>') +
    ph('idx="1"', '<a:p>' + run('alpha') + '<a:br><a:rPr lang="en-US"/></a:br>' + run('beta') + '</a:p><a:p>' + run('gamma ') + '<a:br/>' + run('delta') + '</a:p>');
  const [s] = (await extractDeck(await makePptx([{ xml }]), 'pptx')).slides;
  assert.equal(s.title, 'Line1 Line2');
  assert.equal(s.body, 'alpha beta\ngamma delta');
});
