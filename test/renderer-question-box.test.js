const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// renderer.js is a browser script with no harness: the trimming helpers are
// evaluated from their source, the rest is guarded by inspection.
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/renderer.js'), 'utf8');

function speechHelpers() {
  const start = src.indexOf('const STT_FILL_MAX_CHARS');
  const end = src.indexOf('// ---- Auto-fill the input box', start);
  assert.ok(start > -1 && end > start, 'speech helpers not found');
  return new Function(src.slice(start, end) + '\nreturn { latestSpeech, withoutTrimmedMark, STT_FILL_MAX_CHARS };')();
}

test('the question box keeps only the latest words of a long stretch of speech', () => {
  const { latestSpeech, withoutTrimmedMark, STT_FILL_MAX_CHARS } = speechHelpers();
  assert.equal(latestSpeech('How does that sound to you?'), 'How does that sound to you?');

  const monologue = Array.from({ length: 30 }, (_, i) => 'This is point number ' + i + ' of the explanation.').join(' ');
  const kept = latestSpeech(monologue);
  assert.ok(kept.length <= STT_FILL_MAX_CHARS + 2, 'bounded: ' + kept.length);
  assert.ok(kept.startsWith('… This is point number'), 'starts at a sentence: ' + kept.slice(0, 40));
  assert.ok(kept.endsWith('point number 29 of the explanation.'));
  // Growing again trims again instead of piling up.
  assert.ok(latestSpeech(kept + ' ' + monologue).length <= STT_FILL_MAX_CHARS + 2);

  const noStops = Array.from({ length: 80 }, (_, i) => 'word' + i).join(' ');
  assert.match(latestSpeech(noStops), /^… word\d+ /, 'starts at a whole word');
  assert.equal(withoutTrimmedMark(kept).startsWith('This is point'), true, 'the mark is not sent as part of the question');
  assert.equal(withoutTrimmedMark('Why us?'), 'Why us?');
});

test('every spoken answer clears the speech-filled box, not only Auto', () => {
  const start = src.indexOf("cue.on('llm:start'");
  const handler = src.slice(start, src.indexOf("cue.on('", start + 10));
  assert.match(handler, /if \(inputFromSTT && \(auto \|\| SPOKEN_ANSWER_MODES\.has\(mode\)\)\) hardClearSTTFill\(\);/);
  assert.match(src, /const SPOKEN_ANSWER_MODES = new Set\(\['assist', 'say', 'answerThis'\]\);/);
});

test('speech fills at most three lines; typed questions keep more room', () => {
  assert.match(src, /const STT_INPUT_MAX_HEIGHT = 66;/);
  assert.match(src, /const max = inputFromSTT \? STT_INPUT_MAX_HEIGHT : TYPED_INPUT_MAX_HEIGHT;/);
  assert.match(src, /latestSpeech\(current \? current \+ ' ' \+ text : text\)/, 'auto-fill trims what it appends');
});
