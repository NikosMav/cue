// Heuristic: does this interviewer text read like a finished question? Shared
// by the main process (auto-answer) and the renderer (the "ready" state of the
// input box, via preload) so both agree on when a question is complete.

const COMPLETE_PATTERNS = [
  /tell me about a time/i,
  /give me an example/i,
  /describe a (situation|time|project|challenge)/i,
  /walk me through/i,
  /can you (tell|describe|explain|share)/i,
  /what (was|were|is|are) your/i,
  /how (did|do|would) you/i,
  /why (did|do|are|should)/i,
  /what (did|do|would) you/i,
  /tell me about yourself/i,
  /tell me about your/i,
  /what.{1,30}(biggest|greatest|most|hardest|proudest)/i,
  /have you ever/i
];

const QUESTION_STARTERS = /^(what|how|why|when|where|who|which|tell|describe|explain|can|could|would|should|have|did|do|is|are|was|were)/i;
const QUESTION_ENDINGS = /(about that|for us|to us|with you|for you|about it|to share|you handle|you approach|your experience|your background)\s*$/i;

function isLikelyCompleteQuestion(text) {
  const trimmed = String(text || '').trim();
  // Must be substantial (not just filler words)
  if (trimmed.length < 12) return false;
  // High confidence: ends with a question mark
  if (/\?$/.test(trimmed)) return true;
  // High confidence: interview phrasings that are complete without a "?"
  if (COMPLETE_PATTERNS.some((p) => p.test(trimmed))) return true;
  // Medium confidence: question starters with substantial content
  if (QUESTION_STARTERS.test(trimmed) && trimmed.length > 25) return true;
  // Medium confidence: common question endings
  return QUESTION_ENDINGS.test(trimmed);
}

module.exports = { isLikelyCompleteQuestion };
