// Slides — auto slide tracking for meetings. Pure + testable.
// No Electron imports here: main.js supplies { width, height, data (RGBA Buffer) }
// from a small desktopCapturer thumbnail, plus full-res dataURLs for the VLM.
// Memory-only by design (forward-only, no disk writes).

const crypto = require('crypto');

const DEFAULT_THRESHOLD = 5; // max Hamming distance to still count as "same slide"
const DEFAULT_STABLE_REQUIRED = 2; // consecutive changed polls before emitting
const DEFAULT_MAX_SLIDES = 50;

// Convert RGBA buffer to grayscale array (0-255).
function toGray(width, height, rgba) {
  const n = width * height;
  const gray = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] || 0;
    const g = rgba[i * 4 + 1] || 0;
    const b = rgba[i * 4 + 2] || 0;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

// Box-average downsample any grayscale image to 8x8.
function downsample8x8(width, height, gray) {
  const out = new Array(64).fill(0);
  const counts = new Array(64).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ox = Math.min(7, Math.floor((x * 8) / width));
      const oy = Math.min(7, Math.floor((y * 8) / height));
      const idx = oy * 8 + ox;
      out[idx] += gray[y * width + x];
      counts[idx] += 1;
    }
  }
  for (let i = 0; i < 64; i++) {
    if (counts[i]) out[i] /= counts[i];
  }
  return out;
}

// Average hash: 64 bits as 16-char hex. Bit i = 1 when pixel > mean.
function hashRGBA(width, height, rgba) {
  if (!width || !height || !rgba || rgba.length < width * height * 4) return null;
  if (width < 8 || height < 8) return null;
  const gray = toGray(width, height, rgba);
  const small = downsample8x8(width, height, gray);
  const avg = small.reduce((a, b) => a + b, 0) / 64;
  let h = 0n;
  for (let i = 0; i < 64; i++) {
    if (small[i] > avg) h |= 1n << BigInt(i);
  }
  return h.toString(16).padStart(16, '0');
}

// Box-average a grayscale image down to outW x outH cells.
function downsampleGray(width, height, gray, outW, outH) {
  const out = new Array(outW * outH).fill(0);
  const counts = new Array(outW * outH).fill(0);
  for (let y = 0; y < height; y++) {
    const oy = Math.min(outH - 1, Math.floor((y * outH) / height));
    for (let x = 0; x < width; x++) {
      const ox = Math.min(outW - 1, Math.floor((x * outW) / width));
      out[oy * outW + ox] += gray[y * width + x];
      counts[oy * outW + ox] += 1;
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (counts[i]) out[i] /= counts[i];
  }
  return out;
}

// Difference hash: n*n bits as hex, bit = 1 when a cell is brighter than its
// right-hand neighbour on an (n+1) x n grid. Slides built on one template
// differ in where the text sits more than in overall brightness, which the
// 64-bit average hash misses: two such slides measured 4 bits apart, under
// the "same slide" threshold. This hash put them 24 of 256 bits apart, while
// the same slide with cue's panel changing stayed within 7.
const PRESENTATION_HASH_SIZE = 16;
const PRESENTATION_HASH_HEX = (PRESENTATION_HASH_SIZE * PRESENTATION_HASH_SIZE) / 4;
const PRESENTATION_THRESHOLD = 12;

function dhashRGBA(width, height, rgba, n = PRESENTATION_HASH_SIZE) {
  if (!width || !height || !rgba || rgba.length < width * height * 4) return null;
  if (width < n + 1 || height < n) return null;
  const grid = downsampleGray(width, height, toGray(width, height, rgba), n + 1, n);
  let h = 0n;
  let bit = 0n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (grid[y * (n + 1) + x] > grid[y * (n + 1) + x + 1]) h |= 1n << bit;
      bit += 1n;
    }
  }
  return h.toString(16).padStart((n * n) / 4, '0');
}

function popcountBigInt(x) {
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function hammingDistance(hashA, hashB) {
  if (!hashA || !hashB) return Infinity;
  try {
    const a = BigInt('0x' + hashA);
    const b = BigInt('0x' + hashB);
    return popcountBigInt(a ^ b);
  } catch {
    return Infinity;
  }
}

// Decide whether a new hash represents a genuinely new slide.
// Caller keeps stableCount across polls: reset to 0 when same, +1 when changed.
// Emit only when changed AND stableCount+1 >= requiredStable (debounces flicker).
function shouldEmitSlide(lastHash, newHash, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const requiredStable = opts.requiredStable != null ? opts.requiredStable : DEFAULT_STABLE_REQUIRED;
  const stableCount = opts.stableCount || 0;
  if (!newHash) return { emit: false, stableCount: 0 };
  if (!lastHash) return { emit: true, stableCount: requiredStable };
  const dist = hammingDistance(lastHash, newHash);
  if (dist <= threshold) return { emit: false, stableCount: 0, distance: dist };
  const next = stableCount + 1;
  if (next >= requiredStable) return { emit: true, stableCount: next, distance: dist };
  return { emit: false, stableCount: next, distance: dist };
}

// In-memory slide session. Slide: { id, ts, hash, caption, txStart, txEnd }.
// Images are never stored — only hash + VLM caption + transcript window.
function createSlideStore(opts = {}) {
  const max = opts.maxSlides || DEFAULT_MAX_SLIDES;
  let slides = [];
  return {
    list() { return slides.slice(); },
    count() { return slides.length; },
    clear() { slides = []; },
    add({ hash, caption, txStart, txEnd }) {
      const slide = {
        id: crypto.randomBytes(8).toString('hex'),
        ts: Date.now(),
        hash: hash || null,
        caption: String(caption || '').trim(),
        txStart: txStart != null ? txStart : 0,
        txEnd: txEnd != null ? txEnd : txStart != null ? txStart : 0
      };
      slides.push(slide);
      if (slides.length > max) slides.splice(0, slides.length - max);
      return slide;
    }
  };
}

function clampSlidesConfig(input = {}) {
  const intervalMs = Math.max(1500, Math.min(15000, Number(input.intervalMs) || 3000));
  const threshold = Math.max(0, Math.min(20, Number(input.threshold) || DEFAULT_THRESHOLD));
  const maxSlides = Math.max(10, Math.min(200, Number(input.maxSlides) || DEFAULT_MAX_SLIDES));
  return {
    enabled: !!input.enabled,
    intervalMs,
    threshold,
    maxSlides,
    stableRequired: DEFAULT_STABLE_REQUIRED
  };
}

// Presentation setups poll faster and never cap the slide count: each change is
// matched to a deck slide instead of captioned. Frames are hashed with
// dhashRGBA, so the threshold is out of 256 bits.
function presentationSlidesConfig() {
  return {
    enabled: true,
    intervalMs: 1000,
    threshold: PRESENTATION_THRESHOLD,
    maxSlides: Infinity,
    stableRequired: DEFAULT_STABLE_REQUIRED
  };
}

function buildSlideSystem() {
  return 'You are cue, captioning a meeting slide. Describe the slide concisely: ' +
    'title on the first line, then 3-5 bullets for key points, visuals/charts, and any visible slide number. ' +
    'Plain text only, no preamble.';
}

function buildSlideUser(transcriptSlice) {
  const lines = (transcriptSlice || [])
    .map((t) => (t.channel === 'them' ? 'Them: ' : 'You: ') + t.text)
    .join('\n');
  return 'Caption the slide in the screenshot.' +
    (lines ? '\n\nSpoken context:\n' + lines.slice(0, 1200) : '');
}

module.exports = {
  DEFAULT_THRESHOLD,
  DEFAULT_STABLE_REQUIRED,
  DEFAULT_MAX_SLIDES,
  toGray,
  downsample8x8,
  hashRGBA,
  dhashRGBA,
  PRESENTATION_HASH_SIZE,
  PRESENTATION_HASH_HEX,
  PRESENTATION_THRESHOLD,
  hammingDistance,
  shouldEmitSlide,
  createSlideStore,
  clampSlidesConfig,
  presentationSlidesConfig,
  buildSlideSystem,
  buildSlideUser
};
