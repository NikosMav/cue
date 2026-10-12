// About me is sent with every setup, so a line written for one conversation
// ("open to relocating to Germany" for one interview) leaks into all the
// others. This finds lines that look written for one setup, so Settings can
// suggest moving them to that setup's Notes. A hint, never a block: it only
// reads the text and both checks can be wrong.

const FIELD_LABELS = { resumeText: 'CV', stories: 'Stories', workStyle: 'Work style' };

// Words in setup names that say what kind of conversation it is, not whom it
// is with, so they are no sign that a line belongs to one setup.
const GENERIC_NAME_WORDS = new Set([
  'any', 'conversation', 'conversations', 'interview', 'interviews', 'intro', 'introduction', 'call', 'calls',
  'meeting', 'meetings', 'sync', 'team', 'weekly', 'daily', 'standup', 'review', 'chat', 'screen', 'screening',
  'round', 'first', 'second', 'third', 'final', 'technical', 'onsite', 'online', 'job', 'role', 'new', 'setup',
  'untitled', 'with', 'and', 'the', 'for', 'about', 'prep', 'practice', 'client', 'customer', 'sales', 'demo'
]);

// Phrases that position the user for one opportunity rather than describe them.
const POSITIONING = [
  [/\b(?:open|willing|happy|ready) to relocat/i, 'relocation is usually specific to one opportunity'],
  [/\b(?:for|in|at|about|join|with) this (?:role|position|job|company|interview|call|meeting|opportunity)\b/i, 'refers to one role or conversation'],
  [/\bapplying (?:for|to)\b/i, 'refers to one application'],
  [/\b(?:salary|day rate|hourly rate|compensation|notice period|start date)\b/i, 'pay and availability usually differ per setup']
];

function nameTerms(setups, builtinId) {
  const terms = [];
  for (const setup of setups || []) {
    if (!setup || setup.id === builtinId) continue;
    for (const word of String(setup.name || '').split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= 4 && !GENERIC_NAME_WORDS.has(word.toLowerCase())) terms.push({ word, setup: setup.name });
    }
  }
  return terms;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{resumeText?: string, stories?: string, workStyle?: string}} aboutMe
 * @param {{id: string, name: string}[]} setups
 * @returns {{field: string, label: string, line: number, text: string, reason: string}[]}
 */
function findSetupSpecificLines(aboutMe, setups, { builtinId = 'any' } = {}) {
  // Letter-aware boundaries: \b only knows ASCII words, and names can be Greek.
  const terms = nameTerms(setups, builtinId)
    .map((t) => ({ ...t, re: new RegExp('(?<![\\p{L}\\p{N}])' + escape(t.word) + '(?![\\p{L}\\p{N}])', 'iu') }));
  const found = [];
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const lines = String((aboutMe && aboutMe[field]) || '').split(/\r?\n/);
    lines.forEach((raw, index) => {
      const text = raw.trim();
      if (!text) return;
      const term = terms.find((t) => t.re.test(text));
      const phrase = term ? null : POSITIONING.find(([re]) => re.test(text));
      if (!term && !phrase) return;
      found.push({
        field, label, line: index + 1, text,
        reason: term ? 'mentions "' + term.word + '" from the setup "' + term.setup + '"' : phrase[1]
      });
    });
  }
  return found;
}

module.exports = { findSetupSpecificLines };
