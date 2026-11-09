// Copy rule (CONTRACT §1, R25 S7), mirrored from publik's own copy guard:
// in every file that talks about publik API the strings "OpenAI API access",
// "ChatGPT credits", "credits" as a unit, and any per-token dollar figure are
// forbidden. Money is shown in dollars; "credit" (singular, meaning balance)
// is fine. The provider is always called "publik API".
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['src/publik.js', 'src/llm.js', 'src/store.js', 'main.js', 'renderer/renderer.js', 'renderer/index.html'];
const FORBIDDEN = [
  /OpenAI API access/i,
  /ChatGPT credits?/i,
  /\bcredits\b/i,
  /\$\s?\d[\d.,]*\s*(?:per|\/)\s*(?:\d+[kKmM]?\s*)?(?:million\s+|thousand\s+|1[kKmM]\s+)?tokens?\b/i,
  /\bper[- ]token\b/i
];

for (const rel of FILES) {
  test(`${rel} obeys the publik API copy rule`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const re of FORBIDDEN) {
      const m = re.exec(text);
      assert.equal(m, null, `${rel} contains forbidden copy: ${m && JSON.stringify(m[0])}`);
    }
  });
}
