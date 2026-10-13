const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SessionStore, SessionRecorder, newSession, sessionTitle, kindLabel, presentationBlock, sessionToMarkdown, exportFileName, isValidId, planResume, QUIT_WHILE_LISTENING
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

test('sessions from a general setup are titled "Conversation" and record the setup', () => {
  const { summarize } = require('../src/sessions');
  const s = newSession({ now: 1, setupName: 'Team sync', setupKind: 'general' });
  s.transcript.push({ channel: 'them', text: 'Where are we on the release?', ts: 2 });
  const summary = summarize(s);
  assert.equal(summary.title, 'Conversation · Where are we on the release?');
  assert.equal(summary.setupName, 'Team sync');
  assert.match(sessionToMarkdown(s), /\*\*Setup:\*\* Team sync/);
});

test('sessions record the id of their setup so a debrief can find it after a rename', () => {
  assert.equal(newSession({ now: 1 }).setupId, '');
  assert.equal(newSession({ now: 1, setupId: 'sync', setupName: 'Team sync', setupKind: 'general' }).setupId, 'sync');
});

test('exported general conversations label the other side "Them", interviews keep "Interviewer"', () => {
  const general = newSession({ now: 1, setupName: 'Team sync', setupKind: 'general' });
  general.transcript.push({ channel: 'them', text: 'Where are we on the release?', ts: 2 });
  const md = sessionToMarkdown(general);
  assert.match(md, /\*\*Them\*\* \(/);
  assert.doesNotMatch(md, /Interviewer/);
  const interview = newSession({ now: 1 });
  interview.transcript.push({ channel: 'them', text: 'Why us?', ts: 2 });
  assert.match(sessionToMarkdown(interview), /\*\*Interviewer\*\* \(/);
});

test('sessions without setup metadata keep their old titles', () => {
  const { summarize } = require('../src/sessions');
  const s = newSession({ now: 1 });
  s.transcript.push({ channel: 'them', text: 'Tell me about yourself.', ts: 2 });
  assert.equal(summarize(s).title, 'Interview · Tell me about yourself.');
});

test('the recorder stamps each new session with the setup active when it starts', () => {
  const { SessionRecorder } = require('../src/sessions');
  const saved = [];
  let meta = { setupName: 'Interview', setupKind: 'interview' };
  const recorder = new SessionRecorder({ store: { save: (s) => saved.push(s) }, isEnabled: () => true, meta: () => meta, debounceMs: 0 });
  recorder.addTurn({ channel: 'them', text: 'Hi', ts: 1 });
  assert.equal(recorder.current().setupName, 'Interview');
  meta = { setupName: 'Team sync', setupKind: 'general' };
  recorder.end();
  recorder.addTurn({ channel: 'them', text: 'Hello', ts: 2 });
  assert.equal(recorder.current().setupName, 'Team sync');
});

// Crash recovery: the recorder saves while a conversation runs and only a normal
// quit or Clear marks it ended, so an unended session means cue stopped mid-call.
function unended({ now, updatedAt, setupId = 'interview', kind = 'interview', turns = 1 }) {
  const s = newSession({ kind, now: updatedAt - 60000, setupId, setupName: 'Interview' });
  for (let i = 0; i < turns; i++) s.transcript.push({ channel: 'them', text: 'Question ' + i, ts: updatedAt - 1000 });
  s.updatedAt = updatedAt;
  return s;
}

test('planResume picks the newest recent unended session of the active setup and closes the rest', () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const recent = unended({ now, updatedAt: now - 5 * 60000 });
  const older = unended({ now, updatedAt: now - 20 * 60000 });
  const stale = unended({ now, updatedAt: now - 3 * 3600000 });
  const ended = unended({ now, updatedAt: now - 60000 }); ended.endedAt = now - 60000;
  const plan = planResume([older, ended, stale, recent], { now, setupId: 'interview', saving: true });
  assert.equal(plan.resume.id, recent.id);
  assert.deepEqual(plan.close.map((s) => s.id).sort(), [older.id, stale.id].sort(), 'ended sessions are left alone');
});

test('planResume never resumes practice, another setup, a stale or empty session, or when saving is off', () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const cases = [
    [unended({ now, updatedAt: now - 60000, kind: 'practice' }), { setupId: 'interview', saving: true }],
    [unended({ now, updatedAt: now - 60000, setupId: 'team-sync' }), { setupId: 'interview', saving: true }],
    [unended({ now, updatedAt: now - 31 * 60000 }), { setupId: 'interview', saving: true }],
    [unended({ now, updatedAt: now - 60000, turns: 0 }), { setupId: 'interview', saving: true }],
    [unended({ now, updatedAt: now - 60000 }), { setupId: 'interview', saving: false }]
  ];
  for (const [session, opts] of cases) {
    const plan = planResume([session], { now, ...opts });
    assert.equal(plan.resume, null);
    assert.deepEqual(plan.close.map((s) => s.id), hasTurns(session) ? [session.id] : []);
  }
});
function hasTurns(s) { return s.transcript.length > 0 || s.answers.length > 0; }

test('store lists unended sessions in full; a resumed recorder keeps writing the same session', () => {
  const store = new SessionStore({ dir: tmp() });
  const now = Date.UTC(2026, 8, 25, 12);
  const open = unended({ now, updatedAt: now - 60000 });
  const done = unended({ now, updatedAt: now - 60000 }); done.endedAt = now;
  store.save(open); store.save(done);
  const found = store.unended();
  assert.deepEqual(found.map((s) => s.id), [open.id]);
  assert.equal(found[0].transcript[0].text, 'Question 0');

  const timers = manualTimers();
  const recorder = new SessionRecorder({ store, isEnabled: () => true, timers, now: () => now });
  assert.equal(recorder.resume(found[0]), true);
  recorder.addTurn({ channel: 'you', text: 'My answer', ts: now });
  timers.fire();
  const saved = store.get(open.id);
  assert.deepEqual(saved.transcript.map((t) => t.text), ['Question 0', 'My answer']);
  assert.equal(saved.endedAt, null);
  assert.equal(recorder.end(), open.id);
  assert.equal(store.get(open.id).endedAt, now);
  assert.equal(new SessionRecorder({ store, isEnabled: () => false }).resume(open), false, 'nothing resumes while saving is off');
});

// A quit while still listening is usually an accident mid-call: that session is
// picked back up like a crashed one. Any other quit or Clear ends it for good.
test('a session quit while listening is resumable; other ended sessions are not', () => {
  const store = new SessionStore({ dir: tmp() });
  const now = Date.UTC(2026, 9, 12, 14);
  const timers = manualTimers();
  const recorder = new SessionRecorder({ store, isEnabled: () => true, timers, now: () => now - 60000 });
  recorder.addTurn({ channel: 'them', text: 'So the day rates are', ts: now - 120000 });
  const quitId = recorder.end(QUIT_WHILE_LISTENING);
  const saved = store.get(quitId);
  assert.equal(saved.endReason, QUIT_WHILE_LISTENING);
  assert.equal(saved.endedAt, now - 60000);
  const cleared = unended({ now, updatedAt: now - 30000 }); cleared.endedAt = now - 30000;
  store.save(cleared);

  const found = store.unended();
  assert.deepEqual(found.map((s) => s.id), [quitId]);
  const plan = planResume(found, { now, setupId: '', saving: true });
  assert.equal(plan.resume.id, quitId);
  assert.deepEqual(plan.close, [], 'an ended session is never rewritten as closed');

  const next = new SessionRecorder({ store, isEnabled: () => true, timers, now: () => now });
  assert.equal(next.resume(plan.resume), true);
  next.addTurn({ channel: 'them', text: 'between 350 and 700 euros.', ts: now });
  timers.fire();
  const resumed = store.get(quitId);
  assert.deepEqual(resumed.transcript.map((t) => t.text), ['So the day rates are', 'between 350 and 700 euros.']);
  assert.equal(resumed.endedAt, null);
  assert.equal(resumed.endReason, undefined);
  assert.equal(new SessionRecorder({ store, isEnabled: () => true }).resume(cleared), false, 'a cleared session stays ended');
});

test('a session quit while listening is not resumed after the window', () => {
  const now = Date.UTC(2026, 9, 12, 14);
  const old = unended({ now, updatedAt: now - 31 * 60000 });
  old.endedAt = old.updatedAt; old.endReason = QUIT_WHILE_LISTENING;
  const plan = planResume([old], { now, setupId: 'interview', saving: true });
  assert.equal(plan.resume, null);
  assert.deepEqual(plan.close, []);
});

// ---- presentation block ----
function talk() {
  const s = newSession({ now: Date.UTC(2026, 9, 13, 10), setupKind: 'presentation', setupName: 'Talk' });
  const t0 = s.startedAt;
  s.transcript.push({ channel: 'you', text: 'Welcome everyone.', ts: t0 + 1000 });
  s.transcript.push({ channel: 'you', text: 'Now complexity.', ts: t0 + 61000 });
  s.transcript.push({ channel: 'them', text: 'What about space?', ts: t0 + 121000 });
  s.presentation = {
    deckFileName: 'talk.pptx', slideCount: 3, durationMin: 45,
    titles: { 1: 'Intro', 2: 'Big-O intuition' },
    timeline: [
      { n: 1, enterTs: t0, leaveTs: t0 + 60000 },
      { n: 2, enterTs: t0 + 60000, leaveTs: t0 + 150000 },
      { n: 3, enterTs: t0 + 150000, leaveTs: null }
    ],
    coverage: { 1: { status: 'covered', missing: [] } },
    skipped: []
  };
  return s;
}

test('the presentation block round-trips through the store', () => {
  const store = new SessionStore({ dir: path.join(tmp(), 'sessions') });
  const s = talk();
  store.save(s);
  assert.deepEqual(store.get(s.id).presentation, s.presentation);
});

test('a presentation session is labelled Presentation', () => {
  const s = talk();
  assert.equal(kindLabel(s), 'Presentation');
  assert.match(sessionTitle(s), /^Presentation/);
  assert.match(sessionToMarkdown(s), /- \*\*Type:\*\* Presentation\n/);
});

test('markdown marks slide changes before the first line at or after each enter', () => {
  const md = sessionToMarkdown(talk()).split('## Conversation')[1];
  const i1 = md.indexOf('— Slide 1 · Intro —');
  const w = md.indexOf('Welcome everyone.');
  const i2 = md.indexOf('— Slide 2 · Big-O intuition —');
  const c = md.indexOf('Now complexity.');
  const q = md.indexOf('What about space?');
  const i3 = md.indexOf('— Slide 3 —');
  assert.ok(i1 >= 0 && i1 < w && w < i2 && i2 < c && c < q && q < i3, md);
});

test('visits with no transcript between them collapse to the last; trailing visits are appended', () => {
  const s = talk();
  const t0 = s.startedAt;
  s.transcript = [{ channel: 'you', text: 'Hello.', ts: t0 + 10000 }];
  s.presentation.timeline = [
    { n: 1, enterTs: t0, leaveTs: t0 + 2000 },
    { n: 2, enterTs: t0 + 2000, leaveTs: t0 + 5000 },
    { n: 3, enterTs: t0 + 5000, leaveTs: t0 + 20000 },
    { n: 1, enterTs: t0 + 20000, leaveTs: null }
  ];
  const md = sessionToMarkdown(s);
  assert.ok(!md.includes('— Slide 1 · Intro —\n\n— Slide'), 'no stacked markers');
  assert.equal((md.match(/— Slide 1/g) || []).length, 1, 'first Slide 1 visit collapsed away, trailing one kept');
  assert.ok(!md.includes('— Slide 2'));
  assert.ok(md.indexOf('— Slide 3 —') < md.indexOf('Hello.'));
  assert.ok(md.indexOf('Hello.') < md.indexOf('— Slide 1 · Intro —'));
});

test('a session without the block renders as before', () => {
  const s = newSession({ now: Date.UTC(2026, 0, 1, 10) });
  s.transcript.push({ channel: 'them', text: 'Hi', ts: s.startedAt + 1 });
  const md = sessionToMarkdown(s);
  assert.ok(!md.includes('Slide'));
  assert.match(md, /- \*\*Type:\*\* Live interview/);
});

test('presentationBlock keeps titles only for visited slides', () => {
  const block = presentationBlock({
    deck: { source: { fileName: 'talk.pptx' }, slides: [{ n: 1, title: 'A' }, { n: 2, title: 'B' }, { n: 3, title: 'C' }] },
    snapshot: { slideCount: 3, skipped: [2], timeline: [{ n: 1, enterTs: 1, leaveTs: 2 }, { n: 3, enterTs: 2, leaveTs: null }] },
    coverage: { 1: { status: 'covered', missing: [] } },
    durationMin: 30
  });
  assert.deepEqual(block, {
    deckFileName: 'talk.pptx', slideCount: 3, durationMin: 30,
    titles: { 1: 'A', 3: 'C' },
    timeline: [{ n: 1, enterTs: 1, leaveTs: 2 }, { n: 3, enterTs: 2, leaveTs: null }],
    coverage: { 1: { status: 'covered', missing: [] } },
    skipped: [2]
  });
  assert.equal(presentationBlock({ deck: null, snapshot: { slideCount: 0, skipped: [], timeline: [] }, coverage: {}, durationMin: 45 }).deckFileName, '');
});

test('setPresentation needs a timeline entry to create a session, and saves when enabled', () => {
  const saved = [];
  let on = true;
  const recorder = new SessionRecorder({ store: { save: (s) => saved.push(s) }, isEnabled: () => on, debounceMs: 0, meta: () => ({ setupKind: 'presentation' }) });
  recorder.setPresentation({ timeline: [], titles: {}, coverage: {}, skipped: [] });
  assert.equal(recorder.current(), null);
  const block = { deckFileName: '', slideCount: 1, durationMin: 45, titles: {}, timeline: [{ n: 1, enterTs: 5, leaveTs: null }], coverage: {}, skipped: [] };
  on = false;
  recorder.setPresentation(block);
  assert.equal(recorder.current(), null, 'no-op when disabled');
  on = true;
  recorder.setPresentation(block);
  assert.deepEqual(recorder.current().presentation, block);
  recorder.addTurn({ channel: 'you', text: 'hi', ts: 6 });
  recorder.flush();
  assert.deepEqual(saved[saved.length - 1].presentation, block);
});
