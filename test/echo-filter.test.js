const test = require('node:test');
const assert = require('node:assert/strict');
const { isEcho, ECHO_WINDOW_MS } = require('../src/echo-filter');

const them = (text, ts) => ({ channel: 'them', text, ts });

test('a mic line that repeats the meeting audio is echo', () => {
  const t = [them('Quick question', 1000), them('Does the formula still work if I leave out the role and only give context?', 5000)];
  assert.equal(isEcho('Does the formula still work if I leave out the role and only give context?', t, 6000), true);
  assert.equal(isEcho('does the formula still work if i leave out the role', t, 6000), true, 'a partial, lower-case repeat');
  assert.equal(isEcho('Quick question.', t, 6000), true);
});

test('the user answering in their own words is not echo', () => {
  const t = [them('Tell me about a time you led a team through a difficult deadline.', 1000)];
  assert.equal(isEcho('Sure, at my last job our release slipped by two weeks and I reorganised the work.', t, 3000), false);
  assert.equal(isEcho('A difficult deadline, yes: last spring we shipped a migration in ten days.', t, 3000), false);
});

test('old meeting audio, a single word, or no meeting audio is never echo', () => {
  const t = [them('Does the formula still work?', 1000)];
  assert.equal(isEcho('Does the formula still work?', t, 1000 + ECHO_WINDOW_MS + 1), false);
  assert.equal(isEcho('formula', t, 2000), false);
  assert.equal(isEcho('Does the formula still work?', [{ channel: 'you', text: 'Does the formula still work?', ts: 1000 }], 2000), false);
});
