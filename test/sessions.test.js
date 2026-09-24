const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SessionStore, SessionRecorder, newSession, sessionTitle, sessionToMarkdown, exportFileName, isValidId
} = require('../src/sessions');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sessions-'));
function manualTimers() {
  const pending = [];
  return { setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout: () => { pending.length = 0; }, fire: () => pending.splice(0).forEach((fn) => fn()) };
}

test('store saves, lists newest first, searches and deletes', () => {
  const store = new SessionStore({ dir: path.join(tmp(), 'sessions') });
  assert.deepEqual(store.list(), [], 'a missing folder is an empty list');
  const a = newSession({ now: Date.UTC(2026, 0, 1, 10) });
  a.transcript.push({ channel: 'them', text: 'Why do you want to work here?', ts: a.startedAt + 1000 });
  const b = newSession({ kind: 'practice', now: Date.UTC(2026, 0, 2, 10) });
  b.answers.push({ mode: 'say', prompt: 'x', text: 'I love distributed systems.', ts: b.startedAt + 500 });
  store.save(a); store.save(b);
  assert.deepEqual(store.list().map((s) => s.id), [b.id, a.id]);
  assert.equal(store.list()[1].questionCount, 1);
  assert.deepEqual(store.list('distributed').map((s) => s.id), [b.id]);
  assert.deepEqual(store.list('work here').map((s) => s.id), [a.id]);
  assert.equal(store.get(a.id).transcript[0].text, 'Why do you want to work here?');
  assert.equal(store.remove(a.id), true);
  assert.equal(store.get(a.id), null);
});

test('ids are validated, so no path outside the folder can be read or deleted', () => {
  const store = new SessionStore({ dir: tmp() });
  assert.equal(isValidId(newSession().id), true);
  for (const bad of ['../cue-data', '..\\\\x', '', 'a.json', null]) {
    assert.equal(isValidId(bad), false);
    assert.throws(() => store.get(bad), /Invalid session id/);
  }
});

test('corrupt files are skipped instead of breaking the list', () => {
  const dir = tmp();
  const store = new SessionStore({ dir });
  const s = newSession(); s.transcript.push({ channel: 'you', text: 'hi', ts: 1 });
  store.save(s);
  fs.writeFileSync(path.join(dir, '20260101-000000-abcdef.json'), '{ not json');
  assert.equal(store.list().length, 1);
});

test('recorder saves nothing while saving is off', () => {
  const dir = tmp();
  let enabled = false;
  const recorder = new SessionRecorder({ store: new SessionStore({ dir }), isEnabled: () => enabled, timers: manualTimers() });
  recorder.addTurn({ channel: 'them', text: 'Tell me about yourself.', ts: 1 });
  assert.equal(recorder.end(), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  enabled = true;
  recorder.addTurn({ channel: 'them', text: 'Tell me about yourself.', ts: 2 });
  assert.ok(recorder.end());
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('recorder saves after changes, on end, and writes a Markdown copy when asked', () => {
  const dir = tmp();
  const exportDir = tmp();
  const timers = manualTimers();
  const saved = [];
  const store = new SessionStore({ dir });
  const recorder = new SessionRecorder({ store, isEnabled: () => true, exportDir: () => exportDir, timers, onSaved: (s) => saved.push(s) });
  recorder.addTurn({ channel: 'them', text: 'How would you design a cache?', ts: 1000, source: 'practice' });
  timers.fire();
  const id = recorder.current().id;
  assert.equal(store.get(id).transcript[0].source, 'practice');
  recorder.addAnswer({ mode: 'answerThis', prompt: 'How would you design a cache?', text: 'Start with LRU.', ts: 2000 });
  assert.equal(recorder.end(), id);
  const session = store.get(id);
  assert.ok(session.endedAt);
  assert.equal(session.answers.length, 1);
  assert.equal(saved.length, 2);
  const md = fs.readFileSync(path.join(exportDir, exportFileName(session)), 'utf8');
  assert.match(md, /Start with LRU/);
  assert.equal(recorder.current(), null, 'the next turn starts a new session');
  assert.equal(recorder.end(), null, 'ending an empty session saves nothing');
});

test('practice sessions are marked as practice', () => {
  const store = new SessionStore({ dir: tmp() });
  const recorder = new SessionRecorder({ store, isEnabled: () => true, timers: manualTimers() });
  recorder.setKind('practice');
  recorder.addTurn({ channel: 'them', text: 'Why this role?', ts: 1 });
  const id = recorder.end();
  assert.equal(store.get(id).kind, 'practice');
  assert.match(sessionTitle(store.get(id)), /^Practice · Why this role\?/);
});

test('Markdown export interleaves the conversation and cue answers in time order', () => {
  const s = newSession({ now: Date.UTC(2026, 8, 24, 9, 0) });
  s.transcript.push({ channel: 'them', text: 'Why us?', ts: s.startedAt + 1000 });
  s.transcript.push({ channel: 'you', text: 'Because of the team.', ts: s.startedAt + 9000 });
  s.answers.push({ mode: 'answerThis', prompt: 'Why us?', text: 'Line one\nLine two', ts: s.startedAt + 3000 });
  s.debrief = '## Summary\nWent well.';
  s.endedAt = s.startedAt + 30 * 60000;
  const md = sessionToMarkdown(s);
  assert.match(md, /^# Interview · Why us\?/);
  assert.match(md, /\*\*Duration:\*\* 30 min/);
  assert.match(md, /## Debrief\n\n## Summary\nWent well\./);
  const order = ['**Interviewer**', '**cue · Answer this**', '**You**'].map((m) => md.indexOf(m));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(md, /> Line one\n> Line two/);
  assert.match(exportFileName(s), /^\d{4}-\d{2}-\d{2} \d{4} Interview \(cue [0-9a-f]{6}\)\.md$/);
});
