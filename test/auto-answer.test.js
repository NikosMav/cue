const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoAnswer } = require('../src/auto-answer');
const { isLikelyCompleteQuestion } = require('../src/question-detector');

// Deterministic timers: run() advances time and fires what is due.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    run(ms) {
      now += ms;
      for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.fn(); }
    }
  };
}

function setup({ enabled = true } = {}) {
  const timers = fakeTimers();
  const transcript = [];
  const fired = [];
  let clock = 1000;
  const auto = new AutoAnswer({
    isEnabled: () => enabled,
    getTranscript: () => transcript,
    onFire: (q) => fired.push(q),
    delayMs: 1200,
    timers
  });
  const say = (channel, text) => {
    clock += 2000;
    transcript.push({ channel, text, ts: clock });
    auto.noteFinal(channel, text);
  };
  return { auto, timers, transcript, fired, say };
}

test('answers once the interviewer has finished a question', () => {
  const { timers, fired, say } = setup();
  say('them', 'Tell me about a time you disagreed with your manager.');
  timers.run(1000);
  assert.deepEqual(fired, []);
  timers.run(300);
  assert.deepEqual(fired, ['Tell me about a time you disagreed with your manager.']);
  timers.run(5000);
  assert.equal(fired.length, 1, 'the same question is answered once');
});

test('waits while the interviewer is still talking, then answers the joined question', () => {
  const { auto, timers, fired, say } = setup();
  say('them', 'So tell me about a time when');
  auto.noteInterim('them', 'you had to');
  timers.run(2000);
  assert.deepEqual(fired, []);
  say('them', 'you had to push back on a deadline.');
  timers.run(1300);
  assert.deepEqual(fired, ['So tell me about a time when you had to push back on a deadline.']);
});

test('speech with no reported end (background noise) delays the answer but never blocks it', () => {
  const { auto, timers, fired, say } = setup();
  say('them', 'Why should we hire you?');
  auto.noteSpeech('them', true); // noise: no matching "stopped speaking" ever arrives
  timers.run(1300);
  assert.deepEqual(fired, []);
  timers.run(2400);
  assert.deepEqual(fired, ['Why should we hire you?']);
});

test('voice activity holds the answer until the interviewer pauses', () => {
  const { auto, timers, fired, say } = setup();
  say('them', 'What would you do if a release broke production?');
  auto.noteSpeech('them', true);
  timers.run(3000);
  assert.deepEqual(fired, []);
  auto.noteSpeech('them', false);
  timers.run(1300);
  assert.equal(fired.length, 1);
});

test('when the interviewer keeps talking, the fuller question is answered next', () => {
  const { auto, timers, fired, say } = setup();
  say('them', 'What would you do if a release broke production?');
  timers.run(1300);
  say('them', 'And the rollback also failed?');
  timers.run(1300);
  assert.deepEqual(fired, [
    'What would you do if a release broke production?',
    'What would you do if a release broke production? And the rollback also failed?'
  ]);
});

test('a transcript that lands mid-speech waits longer instead of firing early', () => {
  const { auto, timers, fired, say } = setup();
  auto.noteSpeech('them', true);
  say('them', 'How would you design a URL shortener?');
  timers.run(1300);
  assert.deepEqual(fired, []);
  timers.run(2400); // fallback when no end of speech is ever reported
  assert.equal(fired.length, 1);
});

test('does not answer when the candidate starts answering, but ignores acknowledgements', () => {
  const a = setup();
  a.say('them', 'Why do you want to work here?');
  a.say('you', 'Mm-hm, sure.');
  a.timers.run(1300);
  assert.equal(a.fired.length, 1, 'an acknowledgement does not cancel');

  const b = setup();
  b.say('them', 'Why do you want to work here?');
  b.say('you', 'Honestly the payments work is what drew me in.');
  b.timers.run(5000);
  assert.deepEqual(b.fired, []);
});

test('statements, fragments and a disabled setting do not trigger', () => {
  const a = setup();
  a.say('them', 'Okay, great.');
  a.timers.run(5000);
  assert.deepEqual(a.fired, []);

  const b = setup({ enabled: false });
  b.say('them', 'What is your greatest strength?');
  b.timers.run(5000);
  assert.deepEqual(b.fired, []);
});

test('reset forgets the pending question', () => {
  const { auto, timers, fired, say } = setup();
  say('them', 'What is your greatest strength?');
  auto.reset();
  timers.run(5000);
  assert.deepEqual(fired, []);
});

test('question completeness heuristic', () => {
  for (const q of ['Why this company?', 'Tell me about a time you failed', 'Walk me through your resume',
    'How would you scale the write path for this service']) assert.equal(isLikelyCompleteQuestion(q), true, q);
  for (const q of ['Okay.', 'Right, so', 'That sounds good to me.', '']) assert.equal(isLikelyCompleteQuestion(q), false, q);
});
