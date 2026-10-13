// Turns a PPTX or PDF buffer into per-slide text records. Text layer only, no OCR.
const crypto = require('crypto');
const path = require('path');

const MAX_SLIDES = 150;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const BODY_CHARS = 2000;
const NOTES_CHARS = 3000;
const TRUNC = '\n[…truncated]';

class DeckError extends Error {
  constructor(message) { super(message); this.name = 'DeckError'; }
}

function fingerprint(title, body) {
  const norm = (title + '\n' + body).toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex');
}

const cut = (s, max) => (s.length > max ? s.slice(0, max) + TRUNC : s);

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*"([^"]*)"').exec(tag);
  return m ? decode(m[1]) : null;
}

// Paragraph texts (a:p -> joined a:t), empty paragraphs dropped. A soft line
// break (a:br) inside a paragraph becomes a single space.
function paragraphs(xml) {
  const out = [];
  const pRe = /<a:p(?=[\s>])[^>]*>([\s\S]*?)<\/a:p>/g;
  let m;
  while ((m = pRe.exec(xml))) {
    const tRe = /<a:t(?=[\s>])[^>]*>([\s\S]*?)<\/a:t>|<a:br(?=[\s>\/])[^>]*>/g;
    let t, text = '';
    while ((t = tRe.exec(m[1]))) {
      if (t[1] !== undefined) text += decode(t[1]);
      else if (text && !/\s$/.test(text)) text += ' ';
    }
    text = text.trim();
    if (text) out.push(text);
  }
  return out;
}

// Visits every p:sp element (they never nest); fn returns a replacement string.
function mapShapes(xml, fn) {
  return xml.replace(/<p:sp(?=[\s>])[^>]*>[\s\S]*?<\/p:sp>/g, (sp) => {
    const ph = /<p:ph(?=[\s>\/])([^>]*)>/.exec(sp);
    return fn(sp, ph ? (attr(ph[1], 'type') || 'body') : null);
  });
}

function relsOf(xml) {
  const map = {};
  const re = /<Relationship(?=[\s>\/])([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (attr(m[1], 'TargetMode') === 'External') continue;
    const id = attr(m[1], 'Id');
    if (id) map[id] = { type: attr(m[1], 'Type') || '', target: attr(m[1], 'Target') || '' };
  }
  return map;
}

function resolve(baseDir, target) {
  return target.startsWith('/') ? target.slice(1) : path.posix.join(baseDir, target);
}

const INVALID_PPTX = 'This is not a valid PowerPoint file (it may be password-protected).';

async function extractPptx(buffer) {
  const JSZip = require('jszip');
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw new DeckError(INVALID_PPTX); }
  const read = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };

  const pres = await read('ppt/presentation.xml');
  const presRels = await read('ppt/_rels/presentation.xml.rels');
  if (pres == null || presRels == null) throw new DeckError(INVALID_PPTX);
  const rels = relsOf(presRels);
  const ids = [];
  const idRe = /<p:sldId(?=[\s>\/])([^>]*)>/g;
  let m;
  while ((m = idRe.exec(pres))) {
    const rid = attr(m[1], 'r:id');
    if (rid && rels[rid]) ids.push(rels[rid].target);
  }

  const slides = [];
  for (const target of ids) {
    const slidePath = resolve('ppt', target);
    const xml = await read(slidePath);
    if (xml == null) throw new DeckError(INVALID_PPTX);
    const root = /<p:sld(?=[\s>])[^>]*>/.exec(xml);
    if (root && attr(root[0], 'show') === '0') continue;
    if (slides.length >= MAX_SLIDES) throw new DeckError('The deck has more than ' + MAX_SLIDES + ' slides.');

    const titles = [];
    const bodyXml = mapShapes(xml, (sp, type) => {
      if (type === 'title' || type === 'ctrTitle') { titles.push(...paragraphs(sp)); return ''; }
      return ['sldNum', 'ftr', 'dt'].includes(type) ? '' : sp;
    });
    const title = titles.join(' ').trim();
    const bodyLines = paragraphs(bodyXml);

    let notes = '';
    const slideRelsXml = await read(path.posix.join(path.posix.dirname(slidePath), '_rels', path.posix.basename(slidePath) + '.rels'));
    if (slideRelsXml) {
      const nr = Object.values(relsOf(slideRelsXml)).find((r) => /\/notesSlide$/.test(r.type));
      const nxml = nr ? await read(resolve(path.posix.dirname(slidePath), nr.target)) : null;
      if (nxml) {
        const lines = [];
        mapShapes(nxml, (sp, type) => { if (type === 'body') lines.push(...paragraphs(sp)); return ''; });
        notes = lines.join('\n');
      }
    }
    slides.push({ title, body: bodyLines.join('\n'), notes });
  }
  return slides;
}

async function extractPdf(buffer) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const pages = [];
  const pagerender = async (pageData) => {
    const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    const lines = [];
    let lastY = null, cur = '';
    for (const it of tc.items) {
      const y = it.transform[5];
      if (lastY !== null && y !== lastY) { lines.push(cur); cur = ''; }
      cur += it.str;
      lastY = y;
    }
    if (lastY !== null) lines.push(cur);
    pages.push(lines.map((l) => l.trim()).filter(Boolean));
    return '';
  };
  // pdf.js logs a "Warning: …" line per font quirk; one exported deck printed
  // about 58,000 of them. Drop those while parsing; other output passes through.
  const log = console.log;
  console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('Warning:'))) log(...args); };
  let res;
  try { res = await pdfParse(buffer, { pagerender, max: MAX_SLIDES + 1 }); } catch {
    throw new DeckError('This is not a valid PDF file (it may be password-protected).');
  } finally {
    console.log = log;
  }
  if (res.numpages > MAX_SLIDES || pages.length > MAX_SLIDES) throw new DeckError('The deck has more than ' + MAX_SLIDES + ' slides.');
  return pages.map((lines) => ({ title: lines[0] || '', body: lines.slice(1).join('\n'), notes: '' }));
}

async function extractDeck(buffer, type) {
  if (!Buffer.isBuffer(buffer)) throw new DeckError('The deck file could not be read.');
  if (buffer.length > MAX_FILE_BYTES) throw new DeckError('The deck is larger than 50 MB.');
  let raw;
  if (type === 'pptx') raw = await extractPptx(buffer);
  else if (type === 'pdf') raw = await extractPdf(buffer);
  else throw new DeckError('Unsupported deck type. Use a PPTX or PDF file.');
  const slides = raw.map((s, i) => {
    const title = s.title || 'Slide ' + (i + 1);
    const body = cut(s.body, BODY_CHARS);
    return { n: i + 1, title, body, notes: cut(s.notes, NOTES_CHARS), fingerprint: fingerprint(title, body) };
  });
  return { slides };
}

module.exports = { extractDeck, fingerprint, DeckError, MAX_SLIDES, MAX_FILE_BYTES, BODY_CHARS, NOTES_CHARS };
