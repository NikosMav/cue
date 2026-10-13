const { hammingDistance } = require('./slides');

function createMatcher({ getCache, setCache, slideCount, identify, threshold = 5 }) {
  let busy = false;
  let waiter = null; // { hash, hint, resolve, reject }

  function lookup(hash) {
    const cache = getCache() || {};
    let best = null, bestDist = Infinity;
    for (const h of Object.keys(cache)) {
      const d = hammingDistance(hash, h);
      if (d <= threshold && d < bestDist) { best = h; bestDist = d; }
    }
    if (best === null) return null;
    const v = cache[best];
    if (Number.isInteger(v) && v >= 1 && v <= slideCount) return { n: v, cached: true };
    if (v === 0) return { n: null, cached: true };
    return null;
  }

  async function runIdentify(hash, hint) {
    const raw = await identify(hint);
    const n = Number.isInteger(raw) && raw >= 1 && raw <= slideCount ? raw : null;
    setCache(hash, n === null ? 0 : n);
    return { n, cached: false };
  }

  async function run(hash, hint) {
    busy = true;
    let result, error, failed = false;
    try { result = await runIdentify(hash, hint); }
    catch (e) { failed = true; error = e; }
    busy = false;
    drain();
    if (failed) throw error;
    return result;
  }

  function drain() {
    if (busy || !waiter) return;
    const w = waiter;
    waiter = null;
    const hit = lookup(w.hash);
    if (hit) { w.resolve(hit); return; }
    run(w.hash, w.hint).then(w.resolve, w.reject);
  }

  async function match(hash, hint) {
    const hit = lookup(hash);
    if (hit) return hit;
    if (!busy) return run(hash, hint);
    if (waiter) waiter.resolve({ n: null, cached: false, superseded: true });
    return new Promise((resolve, reject) => { waiter = { hash, hint, resolve, reject }; });
  }

  function correct(hash, n) {
    if (Number.isInteger(n) && n >= 1 && n <= slideCount) setCache(hash, n);
  }

  return { match, correct };
}

module.exports = { createMatcher };
