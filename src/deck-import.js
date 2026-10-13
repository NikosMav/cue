// Import orchestration for presentation decks: change detection, carrying
// edits across re-imports, batched enrichment, and question appends. Pure:
// the caller supplies the extractor and the model call.
const crypto = require('crypto');
const { extractDeck, DeckError } = require('./deck-extract');
const { buildEnrichRequest, parseEnrichResponse } = require('./presentation-prompts');

const BATCH_SIZE = 8;
const MAX_QUESTIONS = 6;

async function importDeck({ buffer, type, fileName, previous, extract = extractDeck }) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (previous && previous.source && previous.source.sha256 === sha256) {
    return { deck: previous, unchanged: true, toEnrich: [] };
  }
  const extracted = await extract(buffer, type);
  const raw = extracted && Array.isArray(extracted.slides) ? extracted.slides : [];
  if (!raw.length) throw new DeckError('The deck has no visible slides.');

  const carried = new Map();
  for (const s of (previous && previous.slides) || []) {
    const has = s.edited || s.points.length || s.questions.length || s.keyIdea;
    if (has && s.fingerprint && !carried.has(s.fingerprint)) carried.set(s.fingerprint, s);
  }
  const toEnrich = [];
  const slides = raw.map((s) => {
    const old = carried.get(s.fingerprint);
    const base = { n: s.n, title: s.title, body: s.body, notes: s.notes, fingerprint: s.fingerprint };
    if (old) {
      return { ...base, points: [...old.points], questions: [...old.questions], keyIdea: old.keyIdea, edited: old.edited, enrichError: false };
    }
    toEnrich.push(s.n);
    return { ...base, points: [], questions: [], keyIdea: '', edited: false, enrichError: false };
  });
  const deck = { version: 1, source: { fileName, type, sha256 }, slides, matchCache: {} };
  return { deck, unchanged: false, toEnrich };
}

// Never throws. A failed call or an unparseable reply flags that batch only.
async function enrichDeck(deck, { ns, call, conversation, notes, onBatch, signal }) {
  let current = { ...deck, slides: deck.slides.map((s) => ({ ...s })) };
  const editedNs = new Set(current.slides.filter((s) => s.edited).map((s) => s.n));
  const wanted = new Set(ns || []);
  const targets = current.slides.filter((s) => wanted.has(s.n) && !editedNs.has(s.n)).map((s) => s.n);
  const titles = current.slides.map((s) => s.title);
  const total = Math.ceil(targets.length / BATCH_SIZE);
  for (let i = 0; i < total; i++) {
    if (signal && signal.aborted) break;
    const batchNs = targets.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const batch = batchNs.map((n) => {
      const s = current.slides.find((x) => x.n === n);
      return { n, title: s.title, body: s.body, notes: s.notes };
    });
    let results = [];
    try {
      const text = await call(buildEnrichRequest({ conversation, notes, titles, batch }));
      results = parseEnrichResponse(text, batchNs) || [];
    } catch (_) { results = []; }
    if (signal && signal.aborted) break;
    const byN = new Map();
    for (const r of results) if (batchNs.includes(r.n) && !byN.has(r.n)) byN.set(r.n, r);
    const failed = byN.size === 0;
    current = {
      ...current,
      slides: current.slides.map((s) => {
        if (!batchNs.includes(s.n)) return s;
        if (failed) return { ...s, enrichError: true };
        const r = byN.get(s.n);
        return r ? { ...s, points: r.points, questions: r.questions, keyIdea: r.keyIdea, enrichError: false } : { ...s, enrichError: true };
      }),
    };
    if (onBatch) onBatch(current, i + 1, total, batchNs);
  }
  return current;
}

function appendQuestions(deck, items) {
  const slides = deck.slides.map((s) => ({ ...s, questions: [...s.questions] }));
  for (const { n, question } of items || []) {
    const s = slides.find((x) => x.n === n);
    const q = typeof question === 'string' ? question.trim() : '';
    if (!s || !q) continue;
    if (s.questions.length >= MAX_QUESTIONS) continue;
    if (s.questions.some((x) => x.toLowerCase() === q.toLowerCase())) continue;
    s.questions.push(q);
    s.edited = true;
  }
  return { ...deck, slides };
}

module.exports = { importDeck, enrichDeck, appendQuestions, BATCH_SIZE };
