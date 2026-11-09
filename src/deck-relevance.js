// deck-relevance.js — pure helpers that turn a loaded deck into prompt
// context: a one-line-per-slide outline for the cached system prefix, and a
// keyword picker for slides an audience question may be about.

const str = (value) => (typeof value === 'string' ? value : '');

/**
 * One line per slide: `n. title — keyIdea` (the key idea omitted when empty).
 * @param {{ slides?: { n: number, title?: string, keyIdea?: string }[] } | null} deck
 * @returns {string}
 */
function deckOutline(deck) {
  const slides = deck && Array.isArray(deck.slides) ? deck.slides : [];
  return slides.map((s) => {
    const keyIdea = str(s.keyIdea).trim();
    return s.n + '. ' + str(s.title).trim() + (keyIdea ? ' — ' + keyIdea : '');
  }).join('\n');
}

// Common English words that say nothing about a slide's topic.
const STOP_WORDS = new Set((
  'a about above after again against all am an and any are as at be because been before being below between both but by ' +
  'can could did do does doing down during each few for from further had has have having he her here hers herself him himself his ' +
  'how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out ' +
  'over own same she should so some such than that the their theirs them themselves then there these they this those through to too ' +
  'under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves ' +
  'also get got like may might must one let lets s t ll ve re d m okay ok yeah yes please tell say said'
).split(' '));
// The same for Greek, without accents (words() compares unaccented forms).
const GREEK_STOP_WORDS = (
  'και το τα του της των τη την τον τους τις ο η οι ενα ενας μια μιας ενος σε στο στα στη στην στον στους στις στης στου ' +
  'απο με για προς που πως τι ποιο ποια ποιος ποιοι ποιες ειναι ηταν εχει εχουν εχω εχετε να θα δεν μη μην αν οτι ' +
  'αυτο αυτα αυτη αυτος αυτον αυτην αυτοι αυτες εγω εσυ εμεις εσεις μου σου μας σας πολυ πιο ομως αλλα επισης ' +
  'μπορει μπορειτε μπορεις λοιπον ναι οχι εδω εκει οταν γιατι ποτε ετσι καθε κατι'
).split(' ');
for (const word of GREEK_STOP_WORDS) STOP_WORDS.add(word);

// Lower case without accents, so "πώς" and "πως" (or "café" and "cafe") match.
function words(text) {
  const out = new Set();
  const plain = str(text).toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  for (const word of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (word && !STOP_WORDS.has(word)) out.add(word);
  }
  return out;
}

const MIN_SCORE = 2;

/**
 * Slides other than the current one and its neighbours that share at least
 * two content words with the question (over title, body, notes and questions),
 * best first, ties by lower slide number.
 * @param {string} question
 * @param {{ n: number, title?: string, body?: string, questions?: string[] }[]} slides
 * @param {number|null} currentN
 * @param {number} [limit=3]
 */
function relevantSlides(question, slides, currentN, limit = 3) {
  if (!Array.isArray(slides)) return [];
  const asked = words(question);
  if (!asked.size) return [];
  const near = Number.isFinite(currentN) ? (n) => n >= currentN - 1 && n <= currentN + 1 : () => false;
  const scored = [];
  for (const slide of slides) {
    if (!slide || near(slide.n)) continue;
    // Speaker notes count too: with notes as the script they are the whole talk.
    const own = words([str(slide.title), str(slide.body), str(slide.notes), ...(Array.isArray(slide.questions) ? slide.questions.map(str) : [])].join(' '));
    let score = 0;
    for (const word of asked) if (own.has(word)) score++;
    if (score >= MIN_SCORE) scored.push({ slide, score });
  }
  scored.sort((a, b) => b.score - a.score || a.slide.n - b.slide.n);
  return scored.slice(0, Math.max(0, limit)).map((x) => x.slide);
}

/**
 * Slide context for a prompt: the current slide, the slides either side of it
 * and the other slides the question may be about.
 * @param {{ slides?: object[] } | null} deck
 * @param {number|null} currentN
 * @param {string} question
 * @returns {{ current: object|null, neighbours: object[], relevant: object[] }}
 */
function slideContext(deck, currentN, question) {
  const slides = deck && Array.isArray(deck.slides) ? deck.slides : [];
  if (!slides.length) return { current: null, neighbours: [], relevant: [] };
  const byN = (n) => slides.find((s) => s && s.n === n) || null;
  const current = Number.isFinite(currentN) ? byN(currentN) : null;
  if (!current) return { current: null, neighbours: [], relevant: relevantSlides(question, slides, 0) };
  const neighbours = [byN(currentN - 1), byN(currentN + 1)].filter(Boolean);
  return { current, neighbours, relevant: relevantSlides(question, slides, currentN) };
}

module.exports = { deckOutline, relevantSlides, slideContext };
