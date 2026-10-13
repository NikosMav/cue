// Live presentation runtime: ties the pacing state, the deck matcher and the
// deck's match cache together for one listening session. Pure: main.js injects
// the screen capture, the LLM call and the cache-save scheduler.
const { createPresentationState } = require('./presentation-state');
const { createMatcher } = require('./deck-match');
const { PRESENTATION_THRESHOLD } = require('./slides');
const { buildMatchRequest, parseMatchResponse, coverageFlag } = require('./presentation-prompts');

// Same pattern pollSlides uses to stop paid calls a key cannot make.
const FATAL_RE = /429|quota|401|403|model_not_found/i;
function isMatchingFatal(message) {
  return FATAL_RE.test(String(message || ''));
}

function slideCountOf(deck) {
  return deck && Array.isArray(deck.slides) ? deck.slides.length : 0;
}

// The deck's identity changed (rebuild state) vs only its text (swap it in).
function deckChanged(prev, next) {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  if (slideCountOf(prev) !== slideCountOf(next)) return true;
  const a = prev.source && prev.source.sha256;
  const b = next.source && next.source.sha256;
  return a !== b;
}

// The `presentation:update` payload.
function buildPresentationUpdate({ deck, snapshot, matching }) {
  const slides = deck && Array.isArray(deck.slides) ? deck.slides : [];
  const find = n => slides.find(s => s.n === n) || null;
  const cur = snapshot && Number.isInteger(snapshot.current) ? find(snapshot.current) : null;
  const nextN = snapshot && Number.isInteger(snapshot.current) ? snapshot.current + 1 : 1;
  const nx = find(nextN);
  return {
    snapshot,
    slide: cur ? { n: cur.n, title: cur.title || '', points: (cur.points || []).slice(), script: cur.script || '' } : null,
    next: nx ? { n: nx.n, title: nx.title || '' } : null,
    matching
  };
}

// deck: the loaded deck or null. identify(hint) may be given directly; else it
// is built from capture() -> imageDataUrl and callLLM(request) -> text.
// onCacheWrite() is called after every cache write (main debounces the save).
function createPresentationRuntime({ deck, durationMin, now, identify, capture, callLLM, onCacheWrite }) {
  let current = deck || null;
  let plannedMin = durationMin;
  const slideCount = slideCountOf(current);
  const state = createPresentationState({ durationMin, slideCount, now });
  let writes = {};
  let matching = slideCount ? 'ok' : 'disabled';
  let latestHash = null;
  const coverage = {}; // slide n -> { status, missing }
  const inflight = new Map(); // hash -> pending onFrame count
  const corrections = new Map(); // hash -> n set manually while identify was in flight

  const doIdentify = identify || (async (hint) => {
    const imageDataUrl = await capture();
    if (!imageDataUrl) throw new Error('No screenshot of the watched display.');
    const req = buildMatchRequest({ slides: current.slides, hint });
    const text = await callLLM({ ...req, imageDataUrl });
    return parseMatchResponse(text, slideCount);
  });

  function setCache(hash, n) {
    if (!current) return;
    if (!current.matchCache || typeof current.matchCache !== 'object') current.matchCache = {};
    current.matchCache[hash] = n;
    writes[hash] = n;
    if (onCacheWrite) onCacheWrite();
  }

  const matcher = slideCount ? createMatcher({
    getCache: () => (current && current.matchCache) || {},
    setCache,
    slideCount,
    identify: doIdentify,
    threshold: PRESENTATION_THRESHOLD
  }) : null;

  async function onFrame(hash) {
    if (!matcher || matching === 'disabled') return { changed: false };
    latestHash = hash;
    inflight.set(hash, (inflight.get(hash) || 0) + 1);
    let result, error = null;
    try {
      result = await matcher.match(hash, state.snapshot().current);
    } catch (e) {
      error = e;
    } finally {
      const left = inflight.get(hash) - 1;
      if (left > 0) inflight.set(hash, left); else inflight.delete(hash);
    }
    if (corrections.has(hash)) {
      // A manual correction beats the result, and the matcher's own write.
      const n = corrections.get(hash);
      if (!inflight.has(hash)) corrections.delete(hash);
      if (!error && !result.cached) setCache(hash, n);
      return { changed: false };
    }
    // Paused meanwhile: nothing more until resumeMatching().
    if (matching === 'disabled') return { changed: false };
    if (error) {
      const message = (error && error.message) || String(error);
      // An auth/quota error pauses matching whichever frame hit it.
      if (isMatchingFatal(message)) {
        matching = 'disabled';
        return { changed: true, message };
      }
      if (hash !== latestHash) return { changed: false };
      const was = matching;
      matching = 'failed';
      return { changed: was !== 'failed', error: message };
    }
    if (result.superseded || hash !== latestHash) return { changed: false };
    matching = 'ok';
    if (result.n === null) {
      state.setOffDeck(true);
      return { changed: true, left: null };
    }
    const { left } = state.setSlide(result.n, { source: 'match' });
    return { changed: true, left };
  }

  function step(delta) {
    const before = state.snapshot().current;
    const n = before === null ? 1 : before + delta;
    const { left } = state.setSlide(n, { source: 'manual' });
    const after = state.snapshot().current;
    if (after === before) return { changed: false, left: null };
    if (matcher && latestHash) {
      if (inflight.has(latestHash)) corrections.set(latestHash, after);
      matcher.correct(latestHash, after);
    }
    return { changed: true, left };
  }

  // Same deck identity: take the fresh text, keep state and unsaved cache entries.
  function swapDeck(fresh) {
    if (deckChanged(current, fresh)) return false;
    if (!fresh) return true;
    fresh.matchCache = { ...(fresh.matchCache || {}), ...((current && current.matchCache) || {}) };
    current = fresh;
    return true;
  }

  // Listening restarted or settings saved (perhaps a fixed key): try again.
  function resumeMatching() {
    if (matcher && matching === 'disabled') matching = 'ok';
  }

  function takeCacheWrites() {
    const out = writes;
    writes = {};
    return out;
  }

  return {
    get deck() { return current; },
    state,
    coverage,
    // The slide's latest result; its flag replaces an earlier one (or goes when covered).
    recordCoverage: (n, result) => {
      coverage[n] = result;
      state.setSlideFlag(n, coverageFlag(n, result));
    },
    get durationMin() { return plannedMin; },
    setDurationMin: (min) => { plannedMin = min; state.setDurationMin(min); },
    matcher,
    onFrame,
    step,
    swapDeck,
    takeCacheWrites,
    resumeMatching,
    noteTranscript: () => state.start(),
    matching: () => matching,
    update: () => buildPresentationUpdate({ deck: current, snapshot: state.snapshot(), matching })
  };
}

module.exports = { createPresentationRuntime, buildPresentationUpdate, deckChanged, isMatchingFatal };
