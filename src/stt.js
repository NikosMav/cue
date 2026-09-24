// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { formatProviderErrorMessage, isQuotaError, isRateLimitError, CURRENT_GEMINI_DEFAULT } = require('./llm');

// Generic interview/software vocabulary. The candidate's own terms (from the
// job description and prep notes) come first and matter far more.
const BASE_VOCAB = 'API, REST, GraphQL, SQL, NoSQL, PostgreSQL, Redis, Kafka, Docker, Kubernetes, ' +
  'AWS, Azure, GCP, CI/CD, microservices, TypeScript, JavaScript, Python, Java, Go, React, Node.js, ' +
  'LeetCode, big O, hash map, binary search, dynamic programming, STAR, stakeholder';

// Capitalized words that start sentences or are otherwise not domain terms.
const VOCAB_STOPWORDS = new Set(('I A An The This That These Those It Its We Our Us You Your He She They Them ' +
  'My Me In On At To For Of And Or But If As By With From Into Over Under About After Before During While ' +
  'When Where What Why How Who Which Also Then Than So Not No Yes Is Are Was Were Be Been Being Do Did Does ' +
  'Have Has Had Will Would Can Could Should May Might Must Led Built Worked Managed Developed Designed Created ' +
  'Improved Reduced Increased Implemented Responsible Experience Education Skills Summary Projects Work ' +
  'January February March April May June July August September October November December ' +
  'Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Present Current Senior Junior Lead').split(' '));

// Tokens that look like names, products or technologies: capitalized words,
// acronyms, and tokens with internal capitals, digits or tech punctuation
// (Node.js, C++, C#, gRPC, k8s).
const TERM_RE = /(?:^|[^\w.+#])([A-Za-z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9+#]+)*[+#]*)/g;

function looksLikeTerm(token) {
  if (token.length < 2 || token.length > 32) return false;
  if (VOCAB_STOPWORDS.has(token)) return false;
  if (/^[A-Z][a-z]+$/.test(token)) return token.length >= 3; // Capitalized word
  if (/^[A-Z0-9]{2,8}$/.test(token)) return /[A-Z]/.test(token); // Acronym
  return /[A-Z]/.test(token.slice(1)) || /\d/.test(token) || /[.+#]/.test(token); // gRPC, k8s, Node.js, C++
}

/**
 * Domain terms from the candidate's own material, most useful first: the
 * interviewer talks about the target role, so job-description terms rank
 * ahead of résumé and notes, then by frequency.
 *
 * @param {object} settings
 * @param {number} limit
 * @returns {string[]}
 */
function extractProfileTerms(settings, limit = 60) {
  const s = settings || {};
  const sources = [s.jobDescription, s.resumeText, s.starStories, s.knowledgeBase, s.questionsToAsk];
  const scores = new Map();
  sources.forEach((text, sourceIndex) => {
    if (typeof text !== 'string' || !text) return;
    const weight = sourceIndex === 0 ? 3 : 1;
    for (const match of text.matchAll(TERM_RE)) {
      const token = match[1].replace(/[.-]+$/, '');
      if (!looksLikeTerm(token)) continue;
      const entry = scores.get(token) || { score: 0, first: scores.size };
      entry.score += weight;
      scores.set(token, entry);
    }
  });
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first)
    .slice(0, limit)
    .map(([token]) => token);
}

// Whisper only considers the last ~224 tokens of its prompt; 850 characters
// stays inside that.
function buildVocabPrompt(settings) {
  const terms = extractProfileTerms(settings, 60);
  const base = BASE_VOCAB.split(', ').filter(term => !terms.includes(term));
  let prompt = [...terms, ...base].join(', ');
  if (prompt.length > 850) prompt = prompt.slice(0, prompt.lastIndexOf(', ', 850));
  return prompt;
}

function looksLikeHallucination(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const t = trimmed.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  const artifacts = new Set([
    'thank you', 'thank you very much', 'thank you for watching', 'thanks for watching',
    'please subscribe', 'like and subscribe', 'bye-bye', 'bye bye', 'bye', 'you', 'okay'
  ]);
  return artifacts.has(t);
}

async function transcribeOpenAI(apiKey, wav, model, baseURL, prompt) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey, baseURL });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    language: 'en',
    temperature: 0,
    prompt: prompt || ''
  });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const chain = [];
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel, undefined, vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'groq') && keys.groq) {
    chain.push({ p: 'groq', fn: (wav) => transcribeOpenAI(keys.groq, wav, 'whisper-large-v3-turbo', 'https://api.groq.com/openai/v1', vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'gemini') && keys.gemini) {
    chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });
  }
  // Custom (OpenAI-compatible) endpoint: same shape as the Groq branch above,
  // just pointed at the user's own Base URL. Deliberately NOT part of 'auto' —
  // unlike a named provider, an arbitrary custom endpoint isn't known to speak
  // the audio-transcription API at all, so this only fires on an explicit
  // choice, and only once both the URL and the key it needs are actually set.
  if (selectedProvider === 'custom' && keys.custom && settings.baseUrl) {
    chain.push({ p: 'custom', fn: (wav) => transcribeOpenAI(keys.custom, wav, settings.sttModel, settings.baseUrl, vocabPrompt) });
  }
  if (keys.openai && chain.length > 1) chain.unshift(chain.splice(chain.findIndex((c) => c.p === 'openai'), 1)[0]);

  let disabledUntil = 0;
  let lastProvider = null;

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const now = Date.now();
      if (disabledUntil && now < disabledUntil) return { text: '', error: { provider: lastProvider, message: `Temporary ${lastProvider || 'provider'} quota or rate-limit; waiting 30s before retrying.` } };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          disabledUntil = 0;
          lastProvider = c.p;
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          // Shares detection/wording with the LLM error path (src/llm.js) so a
          // 404 (dead/misspelled model) or 429 (quota) reads the same whether it
          // came from a chat request or a transcription request.
          // Both exhaustion and a plain rate limit mean "stop hammering this
          // provider" — the 30s cooldown below covers both (it always did, via
          // the old status===429 catch-all inside isQuotaError; now that a
          // rate limit is classified separately, it has to be named here too).
          const backOff = isQuotaError(e) || isRateLimitError(e);
          const message = formatProviderErrorMessage(e, c.p);
          lastErr = { status: e && e.status, code: e && e.code, message, provider: c.p };
          if (backOff) {
            lastProvider = c.p;
            disabledUntil = now + 30000;
            break;
          }
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT, looksLikeHallucination, buildVocabPrompt, extractProfileTerms };
