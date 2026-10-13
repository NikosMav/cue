// In-memory PPTX / PDF builders for deck-extract tests (no binary fixtures committed).
const JSZip = require('jszip');

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (t) => (t === '' ? '<a:p/>' : `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`);
const sp = (ph, lines) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>` +
  `<p:txBody><a:bodyPr/>${lines.map(para).join('')}</p:txBody></p:sp>`;
const rels = (items) =>
  `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">` +
  items.map(([id, type, target]) =>
    `<Relationship Id="${id}" Type="${REL_TYPE}${type}" Target="${target}"/>`).join('') +
  '</Relationships>';

async function makePptx(slides, { order } = {}) {
  const zip = new JSZip();
  const seq = order || slides.map((_, i) => i + 1);
  zip.file('ppt/presentation.xml',
    `<p:presentation ${NS}><p:sldIdLst>${seq.map((n) => `<p:sldId id="${255 + n}" r:id="rId${n}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels',
    rels(slides.map((_, i) => [`rId${i + 1}`, 'slide', `slides/slide${i + 1}.xml`])));
  slides.forEach((s, i) => {
    const n = i + 1;
    let tree = '';
    if (s.title) tree += sp('type="title"', [s.title]);
    if (s.ctrTitle) tree += sp('type="ctrTitle"', [s.ctrTitle]);
    if (s.body) tree += sp('idx="1"', s.body);
    tree += s.xml || '';
    zip.file(`ppt/slides/slide${n}.xml`,
      `<p:sld ${NS}${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`);
    if (s.notes) {
      zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels([['rId1', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]]));
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`,
        `<p:notes ${NS}><p:cSld><p:spTree>${sp('type="sldImg"', [])}${sp('type="body" idx="1"', [s.notes])}${sp('type="sldNum"', [String(n)])}</p:spTree></p:cSld></p:notes>`);
    }
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

// pages: array of pages, each an array of text lines (empty array = page without text).
function makePdf(pages) {
  const objs = [];
  const fontNum = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  pages.forEach((lines, i) => {
    const pn = 3 + i * 2;
    const text = lines.map((l, j) =>
      `BT /F1 18 Tf 72 ${720 - j * 30} Td (${l.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n');
    objs[pn] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pn + 1} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`;
    objs[pn + 1] = `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  });
  objs[fontNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out);
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { makePptx, makePdf };
