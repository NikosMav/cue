// LLM factory — OpenAI, Anthropic, Gemini, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

const { createCompatibleClientOptions } = require('./openai-compatible');
const publik = require('./publik');

const CUSTOM_PROVIDER = 'custom';
const PUBLIK_PROVIDER = publik.PUBLIK_PROVIDER;
// gemini-2.0-flash was Google's default here until it was deprecated (Feb 2026)
// and fully retired (Mar 3 2026) — every request against it now 404s with a
// generic "exception parsing response" body. gemini-3.8-flash is the current
// Flash release (Aug 2026), so it is the single default used everywhere in
// this file and for Gemini transcription in stt.js / stt-streaming.js.
const CURRENT_GEMINI_DEFAULT = 'gemini-3.8-flash';
// Purpose-built speech-to-text model: no thinking tokens, returns nothing on
// silence, and answers with an `audioTranscription` part instead of `text`
// (see extractGeminiTranscript in stt.js). Falls back to
// CURRENT_GEMINI_DEFAULT if Google ever retires it.
const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
// Streaming counterpart over the Live API (bidiGenerateContent): word-by-word
// interim hypotheses plus a final on each pause. Used by GeminiLiveSTT in
// stt-streaming.js; the batch model above is the fallback when it fails.
const GEMINI_TRANSCRIBE_LIVE_MODEL = 'gemini-3.5-transcribe-live';
// claude-3-5-haiku-latest / claude-3-5-sonnet-latest were retired by Anthropic
// (every claude-2.x and claude-3.x id 404s with not_found_error). Fast is the
// current Haiku, which answers without thinking; Smart is the current Sonnet,
// which thinks by default (see anthropicRequestShape for how that is kept
// fast and untruncated). Sonnet costs less than half as much as Opus 5.
const CURRENT_ANTHROPIC_DEFAULT_FAST = 'claude-haiku-4-5';
const CURRENT_ANTHROPIC_DEFAULT_SMART = 'claude-sonnet-5-5';
const DEFAULT_MODELS = {
  cerebras: 'qwen-3.8-27b',
  openai: 'gpt-4.1-mini',
  anthropic: CURRENT_ANTHROPIC_DEFAULT_FAST,
  gemini: CURRENT_GEMINI_DEFAULT,
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  // deepseek-chat/deepseek-reasoner were retired 2026-07-24 and now 404; the
  // replacement aliases are deepseek-flash (non-thinking) and deepseek-v4-pro
  // (thinking), so those are the defaults used everywhere in this file.
  deepseek: 'deepseek-flash',
  azure: 'gpt-4o-mini',
  publik: publik.DEFAULT_MODELS.fast
};
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

// Gemini model ids that Google has since deprecated/retired (the 2.5 family
// went "no longer available to new users" in Sep 2026). A settings file saved
// before this fix can still have one of these persisted on disk, so
// resolveGeminiModel migrates them at read time rather than only fixing the
// default — otherwise an existing user would keep re-hitting the same 404
// forever.
const DEAD_GEMINI_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0|2\.5)(?:-|$)/i;

// Single place that answers "which Gemini model should this request use?".
// Both the chat path (createLLM) and the transcription paths (src/stt.js,
// src/stt-streaming.js) go through here. STT used to skip this and hardcode
// the default instead, so a user who picked a working model in Settings still
// got 404s from a model they had never selected — the app reported a failure
// against a model id that appeared nowhere in their config.
function resolveGeminiModel(settings) {
  const s = settings || {};
  const tier = s.smart ? 'smart' : 'fast';
  const configured = ((s.models || {}).gemini || {})[tier];
  if (!configured || DEAD_GEMINI_MODEL_RE.test(configured)) return CURRENT_GEMINI_DEFAULT;
  return configured;
}

// Same self-heal, for Anthropic: matches every retired claude-2.x/claude-3.x
// id (including the "-latest" aliases), so a settings file saved back when
// claude-3-5-haiku-latest/claude-3-5-sonnet-latest were the shipped defaults
// (store.js's DEFAULTS.models.anthropic, before this fix) gets migrated to a
// live model on next read instead of permanently re-hitting the same 404.
const DEAD_ANTHROPIC_MODEL_RE = /^claude-(2(?:\.\d+)?(?:-|$)|3-)/i;

// Same story for DeepSeek's retired chat/reasoner aliases — map each to its
// closest current replacement rather than collapsing both to one default.
const DEAD_DEEPSEEK_MODEL_RE = /^deepseek-(chat|reasoner)$/i;
const CURRENT_DEEPSEEK_FAST_DEFAULT = 'deepseek-flash';
const CURRENT_DEEPSEEK_SMART_DEFAULT = 'deepseek-v4-pro';

const PROVIDER_LABELS = { azure: 'Azure AI Foundry', cerebras: 'Cerebras', openai: 'OpenAI', minimax: 'MiniMax', publik: publik.PROVIDER_LABEL, deepseek: 'DeepSeek' };

// DeepSeek is OpenAI-compatible and reuses the OpenAI screenshot/streaming path via baseURL.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// A 429 on its own says only "slow down" — it never says the account is out of
// credit. So quota exhaustion is recognised ONLY from an upstream body that
// actually claims it (OpenAI `insufficient_quota`, Gemini `RESOURCE_EXHAUSTED`,
// or plain "exceeded your current quota"/quota/billing wording); every other
// 429 is reported as the rate limit it is. Anthropic's API has no quota concept
// at all — every Anthropic 429 is a per-minute rate_limit_error whose envelope
// is {type:'error', error:{type:'rate_limit_error', message}} (SDKs expose the
// whole envelope as error.error, so the real type sits at error.error.error.type)
// — so under the old `status === 429` rule an Anthropic user could never avoid
// the false "free-tier quota exhausted" message.
function errorSignals(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const upstreamType = error && (error.error?.error?.type || error.error?.type);
  const rawMessage = (error && (error.message || String(error))) || '';
  return { status, code, upstreamType, text: `${rawMessage} ${code || ''} ${upstreamType || ''}`.toLowerCase() };
}

// The two upstream codes that mean "this is a burst/per-minute limit", never
// "your account is empty".
function hasRateLimitSignal({ code, upstreamType }) {
  return code === 'rate_limit_exceeded' || upstreamType === 'rate_limit_error';
}

// Pulled out so both the LLM and STT error paths (llm.js and stt.js) agree on
// what counts as a quota failure instead of drifting independently.
function isQuotaError(error) {
  const signals = errorSignals(error);
  const { code, upstreamType, text } = signals;
  if (code === 'insufficient_quota' || code === 'RESOURCE_EXHAUSTED' ||
      upstreamType === 'insufficient_quota' || upstreamType === 'RESOURCE_EXHAUSTED') return true;
  if (hasRateLimitSignal(signals)) return false;
  return /insufficient_quota|resource_exhausted|exceeded your current quota|\bquota\b|\bbilling\b/i.test(text);
}

// Everything else that 429s (including a bare 429 with no body at all, which is
// what most providers send under load) is a rate limit, not exhaustion.
function isRateLimitError(error) {
  if (isQuotaError(error)) return false;
  const signals = errorSignals(error);
  const { status, code, text } = signals;
  return status === 429 || code === 429 || hasRateLimitSignal(signals) ||
    /\b429\b|too many requests|rate limit/i.test(text);
}

// 401: the key itself is wrong or revoked. 403: the key is valid but may not
// use this model or API (e.g. an OpenAI project key limited to other models).
function authStatus(error) {
  const { status, code, upstreamType, text } = errorSignals(error);
  if (status === 401 || code === 'invalid_api_key' || upstreamType === 'authentication_error' ||
      /incorrect api key|invalid api key|api key not valid|invalid x-api-key|unauthori[sz]ed/i.test(text)) return 401;
  if (status === 403 || upstreamType === 'permission_error' || /permission denied|does not have access|forbidden/i.test(text)) return 403;
  return 0;
}

// The request (mostly the prep notes) does not fit the model's context window.
function isContextLengthError(error) {
  const { code, text } = errorSignals(error);
  return code === 'context_length_exceeded' ||
    /context[_ ]length|maximum context|prompt is too long|too many tokens|input is too long|exceeds the (?:maximum|context)/i.test(text);
}

// The provider is down or overloaded: nothing on the user's side to fix.
function isOutageError(error) {
  const { status, upstreamType, text } = errorSignals(error);
  return (Number(status) >= 500 && Number(status) <= 599) || upstreamType === 'overloaded_error' ||
    /overloaded|service unavailable|bad gateway|internal server error|\b50[0234]\b|\b529\b/i.test(text);
}

// User cancellations also abort the request; those are not network failures.
function isNetworkError(error) {
  if (!error || error.name === 'AbortError' || error.cancelled) return false;
  const text = (error.message || String(error)) || '';
  return error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError' ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|getaddrinfo|network error|connection error|request timed out/i.test(text);
}

// Errors the user fixes in Settings get an "Open Settings" button in the UI.
function isSettingsFixable(error) {
  return isQuotaError(error) || isNotFoundError(error) || authStatus(error) > 0 || isContextLengthError(error);
}

function isNotFoundError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 404 || code === 404 || /\b404\b|is not found for api version|model not found/i.test(text);
}

// Gemini 429 bodies often carry a google.rpc.RetryInfo detail like
// {"retryDelay":"38s"} inside the JSON error text. Not every quota error has
// one (OpenAI/Anthropic don't), so this is best-effort and returns null when
// absent instead of guessing a wait time.
function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Structured errors for publik so main.js can offer a button, not just a sentence.
function publikError(message, action) {
  const e = new Error(message);
  e.action = action || null;
  return e;
}

function isConnectionError(error) {
  const name = error && error.name;
  const text = (error && (error.message || String(error))) || '';
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|connection error|aborted/i.test(text);
}

// publik gateway failures, mapped BEFORE isQuotaError: its regex matches
// "billing"/"quota" in message text and the generic 429 copy tells the user to
// "add billing to your publik API account", which is wrong for publik. Reads
// the openai SDK's APIError shape (status, error = the envelope's inner
// object, headers) and falls through (null) for anything not publik-specific.
function describePublikError(error, model) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const body = error && (error.error || error.response?.data?.error || null);
  const headers = error && error.headers;
  const retryAfter = headers ? (typeof headers.get === 'function' ? headers.get('retry-after') : (headers['retry-after'] || headers['Retry-After'])) : null;
  if (!status && !isConnectionError(error)) return null;
  const described = publik.describeGatewayError({ status, body, model, retryAfter });
  return described ? publikError(described.message, described.action) : null;
}

function formatProviderErrorMessage(error, provider, model) {
  // An empty or cut answer already carries its plain sentence (settleAnswer).
  if (error && error.emptyAnswer) return error;
  const label = normalizeProviderName(provider);
  const rawMessage = (error && (error.message || String(error))) || '';

  if (provider === PUBLIK_PROVIDER) {
    const described = describePublikError(error, model);
    if (described) return described;
  }

  if (isQuotaError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `Your ${label} account is out of quota or credit (429).${waitHint} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.`;
  }

  if (isRateLimitError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} is rate-limiting requests right now (429 Too Many Requests).${waitHint} and try again — this is a temporary per-minute/request limit, not your account running out of credit.`;
  }

  const auth = authStatus(error);
  if (auth === 401) {
    return `${label} rejected your API key (401). It may be mistyped, revoked or for another provider. Check or replace it in Settings → Keys.`;
  }
  if (auth === 403) {
    const modelHint = model ? ` "${model}"` : ' this model';
    return `Your ${label} key is not allowed to use${modelHint} (403). Enable the model for this key in your ${label} account, or pick another model in Settings → Keys.`;
  }

  if (isNotFoundError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is unavailable (404) — it may have been renamed, retired by the provider, or misspelled. Open Settings and pick a current model for ${label} (or clear the field to use cue's default), then try again.`;
  }

  if (isContextLengthError(error)) {
    return `Your prep notes are too long for ${model || `this ${label} model`}. Shorten the knowledge base on the Prep tab, or pick a model with a larger context window in Settings → Keys.`;
  }

  if (isNetworkError(error)) {
    const local = provider === 'ollama' || provider === CUSTOM_PROVIDER;
    return local
      ? `Can't reach ${label} at its URL. Check that the server is running and the URL in Settings → Keys is right.`
      : `Can't reach ${label}. Check your internet connection (and any VPN or proxy), then try again.`;
  }

  if (isOutageError(error)) {
    return `${label} is having problems right now. Try again in a moment, or switch to another provider in Settings.`;
  }

  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || []).filter(t => valid.has(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }));
}

// MiniMax is OpenAI-compatible and exposes two regional gateways. MiniMax-M3
// accepts image input, so it reuses the OpenAI screenshot path via baseURL.
const MINIMAX_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1'
};

// Groq's OpenAI-compatible endpoint validates `messages[].content` per model.
// Only its multimodal models — the Llama 4 Scout / Maverick family — accept
// the [{type:'text'},{type:'image_url'}] array the screenshot path sends;
// every text-only model, the default llama-3.1-8b-instant included, rejects
// the whole request with `400 messages[1].content must be a string`. So the
// screenshot rides along only when the chosen model can read it; otherwise
// the turn goes as plain text and the answer comes back without screen
// context, not as an error.
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_VISION_MODEL_RE = /llama-4-(scout|maverick)/i;
function groqAcceptsImages(model) {
  return GROQ_VISION_MODEL_RE.test(String(model || ''));
}

// One screenshot (imageDataUrl) or several in order (imageDataUrls), e.g. a
// coding problem captured in parts while scrolling.
function imagesOf(imageDataUrl, imageDataUrls) {
  if (Array.isArray(imageDataUrls) && imageDataUrls.length) return imageDataUrls.filter(Boolean);
  return imageDataUrl ? [imageDataUrl] : [];
}

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

// ---- How an answer ended (ported from upstream 0.2.11-0.2.13) ----------
// Only a clean stop is a whole answer. A stream that ends with no usable
// text says why instead of leaving a blank bubble; one that was cut off, or
// stopped by a safety filter, keeps its text with a short note.
// Reasoning models think inside the output cap: when the thinking uses it
// all, the stream ends with "length" and no text.
const LENGTH_EMPTY_MESSAGE = 'The model used its whole output budget before answering. Try again with Smart off, or pick another model in Settings.';
const EMPTY_ANSWER_MESSAGE = 'The model sent back an empty answer. Ask again.';
const LENGTH_CUT_NOTE = '\n\n(Cut off: the answer reached its length limit.)';
const FILTER_EMPTY_MESSAGE = "The AI provider's safety filter stopped this answer. Ask again with different words.";
const FILTER_CUT_NOTE = "\n\n(Incomplete: the AI provider's safety filter stopped this answer. Ask again with different words to get the rest.)";
const RECITATION_EMPTY_MESSAGE = 'The AI provider stopped this answer because it repeated published text. Ask again with different words.';
const RECITATION_CUT_NOTE = '\n\n(Incomplete: the AI provider stopped this answer because it repeated published text.)';
const INCOMPLETE_CUT_NOTE = '\n\n(Incomplete: the answer stopped before the model finished. Ask again to get the rest.)';

// Every stop reason cue knows, lower-cased: OpenAI-style finish_reason,
// Anthropic stop_reason, Gemini finishReason, and the end-of-turn words that
// OpenAI-compatible servers send instead of "stop". Anything else is
// 'incomplete'.
const CLEAN_STOPS = new Set([
  'stop', 'stopped', 'end_turn', 'end_of_turn', 'end', 'eos', 'eos_token', 'eot', 'eot_id', 'eog',
  'stop_sequence', 'stop_token', 'stop_word', 'tool_calls', 'tool_use', 'function_call',
  'complete', 'completed', 'finished', 'done', 'pause_turn'
]);
const LENGTH_STOPS = new Set(['length', 'max_tokens', 'max_output_tokens', 'max_length', 'max_new_tokens', 'limit', 'model_context_window_exceeded']);
const FILTER_STOPS = new Set(['content_filter', 'refusal', 'safety', 'prohibited_content', 'blocklist', 'spii', 'image_safety', 'image_prohibited_content']);
const RECITATION_STOPS = new Set(['recitation', 'image_recitation']);
// Gemini's "not set" value means the same as no reason at all.
const NO_REASON = new Set(['', 'finish_reason_unspecified']);

// evidence.cutShort: the stream itself shows it did not reach its end (cue
// cancelled it; on publik, it closed before "data: [DONE]"; on Anthropic, no
// message_stop). Without such evidence a missing stop reason is a whole
// answer: many OpenAI-compatible servers send none.
function stopKind(reason, refused, evidence) {
  if (refused) return 'filter';
  const r = String(reason || '').toLowerCase();
  if (NO_REASON.has(r)) return evidence && evidence.cutShort ? 'incomplete' : 'clean';
  if (CLEAN_STOPS.has(r)) return 'clean';
  if (LENGTH_STOPS.has(r)) return 'length';
  if (FILTER_STOPS.has(r)) return 'filter';
  if (RECITATION_STOPS.has(r)) return 'recitation';
  return 'incomplete';
}

const EMPTY_MESSAGES = { length: LENGTH_EMPTY_MESSAGE, filter: FILTER_EMPTY_MESSAGE, recitation: RECITATION_EMPTY_MESSAGE };
const CUT_NOTES = { length: LENGTH_CUT_NOTE, filter: FILTER_CUT_NOTE, recitation: RECITATION_CUT_NOTE, incomplete: INCOMPLETE_CUT_NOTE };

function emptyAnswerError(kind, finishReason) {
  const error = new Error(EMPTY_MESSAGES[kind] || EMPTY_ANSWER_MESSAGE);
  error.emptyAnswer = true;
  error.filtered = kind === 'filter';
  error.stopKind = kind;
  error.finishReason = finishReason || null;
  return error;
}

// Refusal messages some hosts stream as if they were the answer (provider
// messages only, never "I can't help with that" phrases, which can be real
// content). Rules:
// - A clean stop counts as refused only when the WHOLE answer is one of the
//   exact messages, with nothing but closing punctuation around it.
// - A filter stop cuts the provider's message off from its start to the end
//   of the text, if that start is within the last REFUSAL_WINDOW characters.
// - Any other stop keeps all of its text, with its own note.
const REFUSALS = [
  // Xiaomi MiMo (publik-balanced); Moonshot uses the same words.
  { start: 'The request was rejected because', exact: ['The request was rejected because it was considered high risk'] },
  // Alibaba Qwen (DashScope "data_inspection_failed").
  { start: 'Input data may contain inappropriate content', exact: ['Input data may contain inappropriate content'] },
  { start: 'Output data may contain inappropriate content', exact: ['Output data may contain inappropriate content'] },
  // DeepSeek.
  { start: 'Content Exists Risk', exact: ['Content Exists Risk'] },
  // Zhipu GLM, code 1301: the whole notice, or its first sentence alone.
  { start: '系统检测到输入或生成内容可能包含不安全或敏感内容', exact: ['系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。', '系统检测到输入或生成内容可能包含不安全或敏感内容'] }
];
const REFUSAL_SENTENCES = REFUSALS.flatMap((r) => r.exact);
const REFUSAL_WINDOW = 240;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WHOLE_REFUSAL = new RegExp('^\\s*(?:(?:' +
  REFUSAL_SENTENCES.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|') +
  ')[\\s.。!！,，;；:："\'”’)\\]}]*)+$', 'u');

// Does text[i..] start with `start`? Case-sensitive; any run of whitespace
// counts as one space. 'full', 'partial' (the text ends inside it) or null.
function startsAt(text, i, start) {
  let t = i;
  for (let k = 0; k < start.length; k++) {
    if (t >= text.length) return 'partial';
    if (start[k] === ' ') {
      if (!/\s/u.test(text[t])) return null;
      while (t < text.length && /\s/u.test(text[t])) t++;
    } else if (text[t] === start[k]) {
      t++;
    } else {
      return null;
    }
  }
  return 'full';
}

// Takes the streamed text piece by piece and gives back what is safe to
// show. Text from a possible refusal start in the last REFUSAL_WINDOW
// characters is held until the stream ends; anything earlier streams at once.
function refusalFilter(refusals = REFUSALS) {
  let text = '';
  let shown = 0;
  let refused = false;
  const from = () => Math.max(shown, text.length - REFUSAL_WINDOW);
  function startAt(i) {
    let found = null;
    for (const r of refusals) {
      const m = startsAt(text, i, r.start);
      if (m === 'full') return 'full';
      if (m) found = m;
    }
    return found;
  }
  function holdFrom() {
    for (let i = from(); i < text.length; i++) if (startAt(i)) return i;
    return text.length;
  }
  function refusalFrom() {
    for (let i = from(); i < text.length; i++) if (startAt(i) === 'full') return i;
    return -1;
  }
  function release(to) {
    const out = text.slice(shown, to);
    shown = to;
    return out;
  }
  function drop(at) {
    refused = true;
    const out = release(at);
    shown = text.length;
    return out;
  }
  return {
    push(piece) {
      text += piece;
      return release(holdFrom());
    },
    end(kind = 'clean') {
      if (kind === 'clean') {
        return WHOLE_REFUSAL.test(text) && !text.slice(0, shown).trim() ? drop(shown) : release(text.length);
      }
      if (kind !== 'filter') return release(text.length);
      const at = refusalFrom();
      return at < 0 ? release(text.length) : drop(at);
    },
    get refused() { return refused; }
  };
}

// The visible answer of one stream: pieces pass the refusal filter on their
// way to onToken; finish() takes the stop reason and returns the shown text
// with its stop kind.
function answerText(onToken) {
  const filter = refusalFilter();
  let text = '';
  const emit = (piece) => { if (piece) { text += piece; onToken(piece); } };
  return {
    add(piece) { emit(filter.push(piece)); },
    finish(finishReason, evidence) {
      const kind = stopKind(finishReason, false, evidence);
      emit(filter.end(kind));
      return { text, kind: filter.refused ? 'filter' : kind, finishReason: finishReason || null };
    }
  };
}

// The end of a stream: never a blank answer, never a refusal sentence shown
// as the answer, and an answer that did not stop cleanly says why. lengthCut
// 'ellipsis' (slide captions) trims a cut text and ends it with "…" instead.
function settleAnswer(answer, onToken, lengthCut) {
  const { text, kind, finishReason } = answer;
  if (!String(text || '').trim()) throw emptyAnswerError(kind, finishReason);
  if (kind === 'clean') return text;
  if (lengthCut === 'ellipsis') return trimCut(text) + '…';
  const note = CUT_NOTES[kind];
  onToken(note);
  return text + note;
}

// A cut caption ends without a dangling space, comma, colon or dash.
function trimCut(text) {
  return String(text).replace(/[\s,;:\-–—]+$/u, '');
}

// Tells the caller what kind of chunk just arrived ('text', 'thinking' or
// 'other'), so a model that thinks for a while is not taken for a stalled
// stream. The reasoning text itself never leaves this module.
function activity(onActivity, kind) {
  if (typeof onActivity !== 'function') return;
  try { onActivity(kind); } catch { /* a watchdog hook must never break the answer */ }
}

// One OpenAI-style chunk: its text (if any) and its finish reason (if any).
function readChunk(part, onActivity) {
  const choice = part && part.choices && part.choices[0];
  const delta = (choice && choice.delta) || {};
  const text = delta.content || '';
  const thinking = !text && !!(delta.reasoning || delta.reasoning_content ||
    (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length));
  activity(onActivity, text ? 'text' : thinking ? 'thinking' : 'other');
  return { text, finish: (choice && choice.finish_reason) || '' };
}

// publik (OpenRouter behind it) always ends a stream with a finish reason and
// "data: [DONE]". The SDK hides [DONE], so this fetch passes the bytes
// through unchanged and notes whether it came; a stream that closed before
// it was cut short.
function doneWatcher() {
  const seen = { done: false };
  const watchedFetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.ok || !res.body || !/event-stream/i.test(res.headers.get('content-type') || '')) return res;
    const decoder = new TextDecoder();
    let tail = '\n';
    const watch = new TransformStream({
      transform(chunk, controller) {
        const s = tail + decoder.decode(chunk, { stream: true });
        if (/\ndata: ?\[DONE\]/.test(s)) seen.done = true;
        tail = s.slice(-16);
        controller.enqueue(chunk);
      }
    });
    return new Response(res.body.pipeThrough(watch), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return { seen, fetch: watchedFetch };
}

// OpenAI's reasoning models (o-series, GPT-5 except the -chat variants)
// reject max_tokens on Chat Completions, and their hidden reasoning tokens
// count against the output limit. OpenAI itself gets max_completion_tokens,
// which every current OpenAI chat model accepts; reasoning models also get
// room to reason and an effort level. OpenAI-compatible servers (Custom,
// Groq, publik, MiniMax) keep max_tokens, which is what they support.
const OPENAI_REASONING_RE = /^(o\d|gpt-5)(?!.*-chat)/i;

function openAIRequestShape(model, maxTokens, effort, nativeOpenAI) {
  if (!nativeOpenAI) return { max_tokens: maxTokens };
  if (!OPENAI_REASONING_RE.test(model || '')) return { max_completion_tokens: maxTokens };
  return { max_completion_tokens: maxTokens + THINKING_HEADROOM_TOKENS, reasoning_effort: effort || 'medium' };
}

async function streamOpenAI({ apiKey, baseURL, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, effort, nativeOpenAI = false, onToken, onActivity, onResponse, lengthCut, signal, watchDone }) {
  const images = imagesOf(imageDataUrl, imageDataUrls);
  const OpenAI = require('openai');
  const watcher = watchDone ? doneWatcher() : null;
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), ...(watcher ? { fetch: watcher.fetch } : {}) });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && images.length && t.role === 'user') {
      messages.push({
        role: 'user', content: [
          { type: 'text', text: t.text },
          ...images.map(url => ({ type: 'image_url', image_url: { url } }))
        ]
      });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const pending = client.chat.completions.create({ model, messages, stream: true, ...openAIRequestShape(model, maxTokens, effort, nativeOpenAI) }, { signal });
  let stream;
  if (typeof onResponse === 'function' && pending && typeof pending.withResponse === 'function') {
    // The gateway stamps x-publik-* headers at admission; hand the raw
    // Response to the caller so the balance line can move before settlement.
    const { data, response } = await pending.withResponse();
    try { onResponse(response); } catch { /* a display hook must never break the answer */ }
    stream = data;
  } else {
    stream = await pending;
  }
  const answer = answerText(onToken);
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) answer.add(chunk.text);
    if (chunk.finish) finish = chunk.finish;
  }
  const cutShort = !!(signal && signal.aborted) || !!(watcher && !watcher.seen.done);
  return settleAnswer(answer.finish(finish, { cutShort }), onToken, lengthCut);
}

// Azure AI Foundry Models API (cognitiveservices.azure.com hosts) lives under
// {endpoint}/openai/v1 and authenticates with the `api-key` header.
function normalizeAzureBaseURL(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!u) return '';
  if (/cognitiveservices\.azure\.com/i.test(u) && !/\/openai\/v1$/i.test(u)) {
    u += '/openai/v1';
  }
  return u;
}

async function streamAzure({ apiKey, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, onToken, onActivity, endpoint, lengthCut, signal }) {
  const images = imagesOf(imageDataUrl, imageDataUrls);
  const url = normalizeAzureBaseURL(endpoint);
  if (!url) throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && images.length && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        ...images.map(url => ({ type: 'image_url', image_url: { url } }))
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const OpenAI = require('openai');
  let client;
  if (/openai\.azure\.com/i.test(url)) {
    client = new OpenAI.AzureOpenAI({ endpoint: url.replace(/\/openai$/i, ''), apiKey, apiVersion: '2024-10-21' });
  } else {
    // Foundry / OpenAI-compatible base: force the `api-key` header and drop the
    // Authorization header the SDK adds by default (those hosts don't take a Bearer key).
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    client = new OpenAI({ baseURL: url, apiKey, fetch: azureFetch });
  }
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_completion_tokens: maxTokens }, { signal });
  const answer = answerText(onToken);
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) answer.add(chunk.text);
    if (chunk.finish) finish = chunk.finish;
  }
  return settleAnswer(answer.finish(finish, { cutShort: !!(signal && signal.aborted) }), onToken, lengthCut);
}

// Anthropic caches only on request: mark the end of the stable reference
// prefix so repeat questions skip reprocessing the résumé and notes. Prefixes
// below the model's minimum cacheable length are simply not cached.
function anthropicSystem(system, cachePrefix) {
  if (!cachePrefix || typeof system !== 'string' || !system.startsWith(cachePrefix) || system === cachePrefix) return system;
  return [
    { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: system.slice(cachePrefix.length) }
  ];
}

// Reasoning effort per request: 'low' for spoken answers (latency matters),
// 'medium' for coding and debriefs. Smart raises it one level.
const EFFORT_LEVELS = ['low', 'medium', 'high'];
function resolveEffort(effort, smart) {
  const index = Math.max(0, EFFORT_LEVELS.indexOf(effort || 'medium'));
  return EFFORT_LEVELS[Math.min(EFFORT_LEVELS.length - 1, index + (smart ? 1 : 0))];
}

// Thinking tokens count against the output limit. Models that think get room
// for it on top of the answer budget, so thinking cannot cut the answer off.
const THINKING_HEADROOM_TOKENS = 8000;

// Claude models that think unless told otherwise (Opus 5 and later, Sonnet 5,
// Fable, Mythos). They take an effort level; Haiku 4.5 and older models reject
// it. Opus 5, Sonnet 5.5 and Fable also get server-side refusal fallbacks: when
// a safety classifier declines a request, Anthropic re-runs it on its
// recommended fallback model inside the same call. Sonnet 5 (before 5.5) has
// no fallbacks.
const ANTHROPIC_THINKS_BY_DEFAULT_RE = /^claude-(opus-5|sonnet-5|fable-5|mythos-5)/;
const ANTHROPIC_FALLBACKS_RE = /^claude-(opus-5|sonnet-5-5|fable-5)/;
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function anthropicRequestShape(model, maxTokens, effort) {
  if (!ANTHROPIC_THINKS_BY_DEFAULT_RE.test(model || '')) return { body: { max_tokens: maxTokens }, headers: {} };
  const body = { max_tokens: maxTokens + THINKING_HEADROOM_TOKENS, output_config: { effort } };
  const headers = {};
  if (ANTHROPIC_FALLBACKS_RE.test(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  }
  return { body, headers };
}

// Gemini 2.5 models think by default and count it against maxOutputTokens,
// which could leave a short spoken answer empty. Low effort turns thinking off
// on Flash (Pro cannot turn it off; 128 is its minimum). Gemini 3.x takes a
// thinking level instead of a budget: "low" is the one level every 3.x model
// accepts, and on Flash it means no thinking at all (about 3x faster). Other
// Gemini models keep their own thinking defaults and just get room for it.
const GEMINI_THINKING_BUDGET = { low: 0, medium: 1024, high: 4096 };
const GEMINI3_LOW_HEADROOM_TOKENS = 1024;
function geminiOutputConfig(model, maxTokens, effort) {
  const id = model || '';
  if (/^gemini-2\.5-(flash|pro)/.test(id)) {
    const minimum = /^gemini-2\.5-pro/.test(id) ? 128 : 0;
    const budget = Math.max(minimum, GEMINI_THINKING_BUDGET[effort] ?? GEMINI_THINKING_BUDGET.medium);
    return { maxOutputTokens: maxTokens + budget, thinkingConfig: { thinkingBudget: budget } };
  }
  if (/^gemini-3/.test(id) && effort === 'low') {
    return { maxOutputTokens: maxTokens + GEMINI3_LOW_HEADROOM_TOKENS, thinkingConfig: { thinkingLevel: 'low' } };
  }
  if (/^gemini-/.test(id)) return { maxOutputTokens: maxTokens + THINKING_HEADROOM_TOKENS };
  return { maxOutputTokens: maxTokens };
}

async function streamAnthropic({ apiKey, model, system, cachePrefix, turns, imageDataUrl, imageDataUrls, maxTokens, effort, onToken, onActivity, lengthCut, signal }) {
  const images = imagesOf(imageDataUrl, imageDataUrls);
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && images.length && t.role === 'user') {
      const content = [];
      for (const img of images.map(stripDataUrl).filter(Boolean)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      }
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const shape = anthropicRequestShape(model, maxTokens, effort);
  const stream = await client.messages.create(
    { model, ...shape.body, system: anthropicSystem(system, cachePrefix), messages, stream: true },
    { signal, headers: shape.headers }
  );
  // stop_reason comes in message_delta (end_turn, max_tokens, refusal, ...);
  // a stream without message_stop did not finish. Thinking deltas count as
  // activity, so a long think is not taken for a stall.
  const answer = answerText(onToken);
  let stop = '';
  let ended = false;
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      activity(onActivity, 'text');
      answer.add(ev.delta.text);
    } else if (ev.type === 'content_block_delta' && ev.delta && (ev.delta.type === 'thinking_delta' || ev.delta.type === 'signature_delta')) {
      activity(onActivity, 'thinking');
    } else {
      activity(onActivity, 'other');
      if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === 'message_stop') ended = true;
    }
  }
  return settleAnswer(answer.finish(stop, { cutShort: !ended || !!(signal && signal.aborted) }), onToken, lengthCut);
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, effort, onToken, onActivity, lengthCut, signal }) {
  const images = imagesOf(imageDataUrl, imageDataUrls);
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && images.length && t.role === 'user') {
      for (const img of images.map(stripDataUrl).filter(Boolean)) {
        parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
      }
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const config = { systemInstruction: system, ...geminiOutputConfig(model, maxTokens, effort), abortSignal: signal };
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model, contents, config });
  } catch (e) {
    // A model that predates thinkingLevel (or a custom id that rejects it)
    // should still answer: retry once without the thinking setting.
    if (!config.thinkingConfig || !/thinking/i.test((e && e.message) || '')) throw e;
    delete config.thinkingConfig;
    stream = await ai.models.generateContentStream({ model, contents, config });
  }
  // finishReason comes on the last candidate (STOP, MAX_TOKENS, SAFETY,
  // RECITATION, ...). A blocked prompt has no candidate, only
  // promptFeedback.blockReason: the safety filter stopped it.
  const answer = answerText(onToken);
  let stop = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    activity(onActivity, t ? 'text' : 'other');
    if (t) answer.add(t);
    const candidate = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
    if (candidate && candidate.finishReason) stop = candidate.finishReason;
    else if (!stop && chunk && chunk.promptFeedback && chunk.promptFeedback.blockReason) stop = 'SAFETY';
  }
  return settleAnswer(answer.finish(stop, { cutShort: !!(signal && signal.aborted) }), onToken, lengthCut);
}

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, onToken, onActivity, lengthCut, signal }) {
  const images = imagesOf(imageDataUrl, imageDataUrls);
  const baseUrl = apiKey || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && images.length && t.role === 'user') {
      const b64 = images.map(stripDataUrl).filter(Boolean).map(img => img.b64);
      if (b64.length) {
        messages.push({ role: 'user', content: t.text, images: b64 });
      } else {
        messages.push({ role: 'user', content: t.text });
      }
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
  } catch (err) {
    throw new Error(`Ollama fetch failed: ${err.message}. Is Ollama running at ${baseUrl}?`);
  }

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  // Each line is one JSON object; the last has done: true and done_reason
  // ("stop", "length", ...).
  const decoder = new TextDecoder();
  const answer = answerText(onToken);
  let stop = '';
  let ended = false;
  let buffer = '';
  const readLine = (line) => {
    if (!line.trim()) return;
    let data;
    try { data = JSON.parse(line); } catch { return; }
    const text = data.message && data.message.content;
    const thinking = !text && !!(data.message && data.message.thinking);
    activity(onActivity, text ? 'text' : thinking ? 'thinking' : 'other');
    if (text) answer.add(text);
    if (data.done) {
      ended = true;
      stop = data.done_reason || 'stop';
    }
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    lines.forEach(readLine);
  }
  readLine(buffer);
  return settleAnswer(answer.finish(stop, { cutShort: !ended || !!(signal && signal.aborted) }), onToken, lengthCut);
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  let apiKey = keys[provider];
  let baseURL = '';
  let configurationError = '';
  let missingKey = false;
  const tier = settings.smart ? 'smart' : 'fast';
  const models = settings.models || {};
  let model = (models[provider] || {})[tier];
  if (provider === 'gemini') {
    model = resolveGeminiModel(settings);
  }
  if (provider === PUBLIK_PROVIDER && !model) model = publik.DEFAULT_MODELS[tier];
  if (provider === 'anthropic' && DEAD_ANTHROPIC_MODEL_RE.test(model || '')) {
    model = tier === 'smart' ? CURRENT_ANTHROPIC_DEFAULT_SMART : CURRENT_ANTHROPIC_DEFAULT_FAST;
  }
  if (provider === 'deepseek' && DEAD_DEEPSEEK_MODEL_RE.test(model || '')) {
    model = /reasoner/i.test(model) ? CURRENT_DEEPSEEK_SMART_DEFAULT : CURRENT_DEEPSEEK_FAST_DEFAULT;
  }
  if (!model) model = DEFAULT_MODELS[provider] || '';
  const minimaxRegion = settings.minimaxRegion || 'global_en';
  const endpoint = settings.azureEndpoint || '';

  if (provider === PUBLIK_PROVIDER) {
    // The packaged-build default: an OpenAI-compatible endpoint with a fixed
    // base URL (the provisioning response's, else the build's) and the key the
    // install minted. Never settings.baseUrl — that is the user's Custom slot.
    const base = (settings.publik && settings.publik.baseUrl) || publik.DEFAULT_BASE_URL;
    try {
      baseURL = createCompatibleClientOptions(apiKey, base).baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!apiKey) configurationError = `${publik.PROVIDER_LABEL} is not set up on this computer yet.`;
  } else if (provider === CUSTOM_PROVIDER) {
    try {
      const clientOptions = createCompatibleClientOptions(apiKey, settings.baseUrl);
      apiKey = clientOptions.apiKey;
      baseURL = clientOptions.baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!model && !configurationError) {
      configurationError = 'Set a Fast or Smart model for the Custom provider.';
    }
  } else if (provider !== 'ollama' && !apiKey) {
    // Ollama is a local server: the field holds a URL, and no key is required.
    configurationError = `Add your ${normalizeProviderName(provider)} key in Settings.`;
    missingKey = true;
  }

  // Azure needs a second credential: the resource endpoint.
  if (!configurationError && provider === 'azure' && !endpoint) {
    configurationError = 'Add your Azure AI Foundry endpoint in Settings.';
  }

  const ready = !configurationError && !!model;
  const maxTokens = settings.smart ? 1400 : 700;
  // publik's fast tier reads a screenshot too coarsely, so a question that
  // carries one goes to the smart alias (upstream 0.2.7).
  const visionModel = provider === PUBLIK_PROVIDER ? publikVisionModel(settings, model) : model;

  // publik branches return an Error carrying `.action`; the string branches
  // become an Error here.
  const wrap = (error, failedModel) => {
    const wrapped = formatProviderErrorMessage(error, provider, failedModel);
    if (wrapped instanceof Error) return wrapped;
    const friendly = new Error(wrapped);
    if (isSettingsFixable(error)) friendly.action = { kind: 'settings' };
    if (error && error.cancelled) friendly.cancelled = true; // keep cancellation visible to the caller
    return friendly;
  };

  return {
    provider, model, visionModel, apiKey, baseURL,
    ready,
    configurationError,
    missingKey,
    providerName: normalizeProviderName(provider),
    async stream(params) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const hasImage = !!(params && (params.imageDataUrl || (Array.isArray(params.imageDataUrls) && params.imageDataUrls.length)));
      const useModel = hasImage ? visionModel : model;
      const args = { apiKey, baseURL, endpoint, model: useModel, maxTokens, ...params, effort: resolveEffort(params.effort, settings.smart), turns: sanitizeTurns(params.turns) };
      // An explicit maxTokens: undefined (or any non-number) falls back to the
      // default cap; it must never reach the request as NaN.
      if (!(Number.isFinite(args.maxTokens) && args.maxTokens > 0)) args.maxTokens = maxTokens;
      const visibleTokens = args.maxTokens;
      if (provider === PUBLIK_PROVIDER) {
        args.maxTokens = publikOutputCap(visibleTokens, useModel);
        args.watchDone = true;
      } else {
        delete args.watchDone; // own keys: no publik-only behaviour
      }
      try {
        return await streamWith(provider, args, minimaxRegion);
      } catch (error) {
        const retryModel = provider === PUBLIK_PROVIDER ? publikRefusalRetryModel(error, useModel, settings, hasImage) : '';
        if (!retryModel || (args.signal && args.signal.aborted)) throw wrap(error, useModel);
        if (typeof args.onRetry === 'function') {
          try { args.onRetry({ from: useModel, to: retryModel, finishReason: error.finishReason || null }); } catch { /* a log hook must never break the answer */ }
        }
        try {
          return await streamOpenAI({ ...args, model: retryModel, maxTokens: publikOutputCap(visibleTokens, retryModel) });
        } catch (retryError) {
          // The retry's own empty or refused answer says what happened to it;
          // any other failure of the retry leaves the first, honest answer.
          if (retryError && retryError.emptyAnswer) throw wrap(retryError, retryModel);
          error.retryFailed = (retryError && retryError.message) || String(retryError);
          throw wrap(error, useModel);
        }
      }
    }
  };
}

function streamWith(provider, args, minimaxRegion) {
  if (provider === 'openai') return streamOpenAI({ ...args, nativeOpenAI: true });
  if (provider === CUSTOM_PROVIDER) return streamOpenAI(args);
  if (provider === PUBLIK_PROVIDER) return streamOpenAI(args);
  if (provider === 'ollama') return streamOllama(args);
  if (provider === 'groq') {
    const images = groqAcceptsImages(args.model);
    return streamOpenAI({ ...args, baseURL: GROQ_BASE_URL, imageDataUrl: images ? args.imageDataUrl : null, imageDataUrls: images ? args.imageDataUrls : null });
  }
  if (provider === 'cerebras') return streamOpenAI({ ...args, baseURL: CEREBRAS_BASE_URL });
  if (provider === 'minimax') return streamOpenAI({ ...args, baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en });
  if (provider === 'deepseek') return streamOpenAI({ ...args, baseURL: DEEPSEEK_BASE_URL });
  if (provider === 'anthropic') return streamAnthropic(args);
  if (provider === 'gemini') return streamGemini(args);
  if (provider === 'azure') return streamAzure(args);
  return Promise.reject(new Error('unknown provider: ' + provider));
}

// publik's tiers are reasoning models whose thinking counts inside the output
// cap (prod: publik-fast p99 628 reasoning tokens, publik-balanced p99 2,691),
// so the cap gets room for it and maxTokens stays the visible budget. The
// user pays for tokens used, not for the cap.
const PUBLIK_THINKING_HEADROOM = { fast: 2048, smart: 4096 };
function publikOutputCap(visibleTokens, model) {
  const room = model === publik.DEFAULT_MODELS.fast ? PUBLIK_THINKING_HEADROOM.fast : PUBLIK_THINKING_HEADROOM.smart;
  return visibleTokens + room;
}

// The publik model a screenshot question uses: on the smart tier, the model
// already chosen; on the fast tier, the smart alias, unless the user typed
// their own Fast model (an explicit choice stands).
function publikVisionModel(settings, fastOrSmartModel) {
  if (settings.smart) return fastOrSmartModel;
  const tierModels = (settings.models || {})[PUBLIK_PROVIDER] || {};
  const fast = String(tierModels.fast || '').trim();
  if (fast && !publik.TIER_NAMES.includes(fast)) return fastOrSmartModel;
  return String(tierModels.smart || '').trim() || publik.DEFAULT_MODELS.smart;
}

// A publik-balanced answer the safety filter stopped before any text showed
// is asked once more on another tier, never in a loop: publik-smart on a
// linked install, else publik-fast for a text-only question (publik-fast
// reads screenshots too coarsely).
const PUBLIK_BALANCED = 'publik-balanced';
function publikRefusalRetryModel(error, model, settings, hasImage) {
  if (!error || !error.filtered || !error.emptyAnswer) return '';
  if (model !== PUBLIK_BALANCED) return '';
  const p = (settings && settings.publik) || {};
  const claimed = ((p.wallet && p.wallet.claimState) || p.claimState) === 'claimed';
  if (claimed) return 'publik-smart';
  return hasImage ? '' : publik.DEFAULT_MODELS.fast;
}

module.exports = {
  createLLM,
  groqAcceptsImages,
  anthropicSystem,
  anthropicRequestShape,
  openAIRequestShape,
  geminiOutputConfig,
  resolveEffort,
  formatProviderErrorMessage,
  isQuotaError,
  isNotFoundError,
  resolveGeminiModel,
  CURRENT_GEMINI_DEFAULT,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  CURRENT_ANTHROPIC_DEFAULT_FAST,
  CURRENT_ANTHROPIC_DEFAULT_SMART,
  PUBLIK_PROVIDER,
  isRateLimitError,
  normalizeProviderName,
  publikOutputCap,
  PUBLIK_THINKING_HEADROOM,
  LENGTH_EMPTY_MESSAGE,
  EMPTY_ANSWER_MESSAGE,
  LENGTH_CUT_NOTE,
  FILTER_EMPTY_MESSAGE,
  FILTER_CUT_NOTE,
  RECITATION_EMPTY_MESSAGE,
  RECITATION_CUT_NOTE,
  INCOMPLETE_CUT_NOTE,
  REFUSAL_SENTENCES,
  refusalFilter,
  stopKind
};
