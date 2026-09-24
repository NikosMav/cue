// The user's own "AI rules" (how answers should be written), appended to every non-coding system prompt.

// Generous but bounded cap on the user-written response rules. Same idea as
// the résumé cap: anything longer should live in a real prompt file, not in
// a settings field.
const MAX_AI_RULES_CHARS = 2000;

/**
 * Adds the user-written "AI rules" — instructions on HOW the AI should write —
 * to the system prompt. Treated as authoritative instruction (unlike the
 * résumé, which is wrapped as untrusted data): the user wrote these rules for
 * themselves, so there is no prompt-injection concern.
 *
 * Each rule is a short imperative line. Examples:
 *   - "Never use em-dashes."
 *   - "Reply in 2-3 short bullet points."
 *   - "Use a casual, first-person tone."
 *   - "Avoid jargon; explain technical terms."
 *
 * Applied to every mode EXCEPT LeetCode (kept strict for coding problems) —
 * the caller decides whether to skip it.
 *
 * @param {string} systemPrompt The mode-specific prompt cue would otherwise send.
 * @param {unknown} aiRules The user's locally-saved rules text.
 * @returns {string} The prompt, with the rules appended when non-empty.
 */
function appendAiRules(systemPrompt, aiRules) {
  const rules = typeof aiRules === 'string' ? aiRules.trim() : '';
  if (!rules) return systemPrompt;
  const clipped = rules.slice(0, MAX_AI_RULES_CHARS);
  return systemPrompt +
    '\n\nThe user has set the following rules for how you write. Follow them strictly — they override any default tone or formatting in the instructions above. ' +
    'If two rules conflict, prefer the rule that is more specific.\n' +
    '--- USER RULES ---\n' + clipped + '\n--- END USER RULES ---';
}

module.exports = {
  MAX_AI_RULES_CHARS,
  appendAiRules,
};