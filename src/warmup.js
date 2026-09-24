// Warm-up. The first answer of a session paid for a cold connection and an
// uncached prompt: about 5 s to first text, against under 1 s afterwards. A
// tiny request that starts with the same reference block as every answer
// opens the connection and primes the provider's prompt cache (OpenAI,
// Anthropic and Gemini cache by prompt prefix), so the first real answer is
// fast. main.js runs it shortly after launch and when listening starts. It
// runs at most once per interval, never over a request in progress, and never
// on publik, whose balance must not be spent without the user asking.
// Settings → Style can turn it off. Failures are ignored: a warm-up is only
// an optimisation.

const WARMUP_MIN_INTERVAL_MS = 4 * 60 * 1000;
const WARMUP_TIMEOUT_MS = 20000;
const WARMUP_MAX_TOKENS = 16;

function createWarmUp({ getSettings, createLLM, buildPromptRequest, isBusy = () => false, now = Date.now, log = () => {}, skipProviders = [] }) {
  let lastAt = 0;
  return async function warmUp(reason) {
    const settings = getSettings();
    if (settings.warmUp === false || skipProviders.includes(settings.provider)) return 'disabled';
    if (isBusy()) return 'busy';
    if (lastAt && now() - lastAt < WARMUP_MIN_INTERVAL_MS) return 'recent';
    const llm = createLLM(settings);
    if (!llm.ready) return 'not-ready';
    lastAt = now();
    // Same builder and mode family as a real answer, so the prompt prefix matches.
    const request = buildPromptRequest(settings, 'answerThis', [], 'Reply with OK.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
    try {
      await llm.stream({
        system: request.system, cachePrefix: request.cachePrefix, effort: 'low', turns: request.turns,
        maxTokens: WARMUP_MAX_TOKENS, imageDataUrls: [], onToken: () => {}, signal: controller.signal
      });
      log(`[cue] provider warmed up (${reason})`);
      return 'warmed';
    } catch (error) {
      log(`[cue] warm-up failed (${reason}): ${error && error.message ? error.message : error}`);
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createWarmUp, WARMUP_MIN_INTERVAL_MS, WARMUP_MAX_TOKENS };
