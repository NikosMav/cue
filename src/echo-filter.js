// On speakers instead of headphones, the mic hears the meeting audio too and
// its transcript repeats the other side's words a moment later, as if the
// user had said them. That reads as the user answering (Auto stands down)
// and splits the question in two. A mic line is echo when nearly all of its
// words were just said on the meeting channel.
const ECHO_WINDOW_MS = 6000;
const ECHO_MIN_WORDS = 2;
const ECHO_MATCH = 0.8;

function words(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
}

function isEcho(text, transcript, now) {
  const mine = words(text);
  if (mine.length < ECHO_MIN_WORDS) return false;
  const heard = new Set();
  for (const turn of transcript || []) {
    if (turn.channel === 'them' && now - turn.ts <= ECHO_WINDOW_MS) for (const w of words(turn.text)) heard.add(w);
  }
  if (!heard.size) return false;
  const hits = mine.filter((w) => heard.has(w)).length;
  return hits / mine.length >= ECHO_MATCH;
}

module.exports = { isEcho, ECHO_WINDOW_MS };
