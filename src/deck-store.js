// Durable per-setup deck files (imported slides + enrichment + slide-match
// cache). File mechanics come from settings-store-core; no Electron here.
const fs = require('fs');
const path = require('path');
const { createFileStore } = require('./settings-store-core');

const ID_RE = /^[A-Za-z0-9_-]+$/;
// 256-bit difference hashes (slides.js dhashRGBA). Keys from the earlier
// 64-bit hash matched different slides of one template, so they are dropped.
const HASH_RE = /^[0-9a-f]{64}$/;

const str = (v) => (typeof v === 'string' ? v : '');
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function normalizeSlide(s, i) {
  return {
    n: Number.isFinite(s.n) ? s.n : i + 1,
    title: str(s.title),
    body: str(s.body),
    notes: str(s.notes),
    fingerprint: str(s.fingerprint),
    points: strList(s.points),
    questions: strList(s.questions),
    keyIdea: str(s.keyIdea),
    script: str(s.script),
    edited: s.edited === true,
    enrichError: s.enrichError === true,
  };
}

function normalizeDeck(raw) {
  if (!isObj(raw) || !Array.isArray(raw.slides)) return null;
  const src = isObj(raw.source) ? raw.source : {};
  const slides = [];
  raw.slides.forEach((s, i) => { if (isObj(s)) slides.push(normalizeSlide(s, i)); });
  const matchCache = {};
  if (isObj(raw.matchCache)) {
    for (const [k, v] of Object.entries(raw.matchCache)) {
      if (HASH_RE.test(k) && Number.isInteger(v) && v >= 0 && v <= 150) matchCache[k] = v;
    }
  }
  return {
    version: 1,
    source: { fileName: str(src.fileName), type: src.type === 'pdf' ? 'pdf' : 'pptx', sha256: str(src.sha256) },
    slides,
    matchCache,
  };
}

class DeckStore {
  constructor({ dir }) {
    this.dir = dir;
  }

  fileFor(setupId) {
    if (typeof setupId !== 'string' || !ID_RE.test(setupId)) throw new Error('Invalid setup id');
    return setupId + '.json';
  }

  _store(file) {
    if (typeof file !== 'string' || !ID_RE.test(file.replace(/\.json$/, ''))) throw new Error('Invalid deck file');
    return createFileStore(() => this.dir, file);
  }

  load(file) {
    const result = this._store(file).load();
    return result ? normalizeDeck(result.data) : null;
  }

  save(file, deck) {
    fs.mkdirSync(this.dir, { recursive: true });
    this._store(file).persist(deck);
  }

  remove(file) {
    const s = this._store(file);
    for (const p of [s.mainPath(), s.bakPath(), s.tmpPath()]) {
      try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
    }
  }
}

module.exports = { DeckStore, normalizeDeck };
