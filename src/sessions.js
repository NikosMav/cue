// Saved sessions: the transcript and cue's answers from one interview (or
// practice run), stored as one JSON file per session under the user-data
// directory, with an optional Markdown copy in a folder the user picks (an
// Obsidian vault, a synced folder, anything that reads Markdown).
// Pure Node: no Electron dependency, so it is unit-testable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_VERSION = 1;
const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const SPEAKER = { them: 'Interviewer', you: 'You' };
const MODE_LABELS = {
  assist: 'Assist', say: 'What should I say?', ask: 'Ask', answerThis: 'Answer this',
  followup: 'Follow-up questions', recap: 'Recap', leetcode: 'Coding solution',
  codeFollowup: 'Coding follow-up', practiceFeedback: 'Feedback on your answer'
};

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function newSession({ kind = 'interview', now = Date.now() } = {}) {
  return {
    version: SESSION_VERSION,
    id: stamp(now) + '-' + crypto.randomBytes(3).toString('hex'),
    kind,                 // 'interview' | 'practice'
    title: '',
    startedAt: now,
    endedAt: null,
    updatedAt: now,
    transcript: [],       // { channel: 'them' | 'you', text, ts, source? }
    answers: [],          // { mode, prompt, text, ts }
    debrief: '',
    debriefAt: null
  };
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function firstQuestion(session) {
  const turn = (session.transcript || []).find((t) => t.channel === 'them' && t.text && t.text.trim());
  return turn ? turn.text.trim() : '';
}

function sessionTitle(session) {
  if (session.title) return session.title;
  const kind = session.kind === 'practice' ? 'Practice' : 'Interview';
  const question = firstQuestion(session);
  if (!question) return kind;
  return kind + ' · ' + (question.length > 60 ? question.slice(0, 57).trimEnd() + '…' : question);
}

function summarize(session) {
  const transcript = session.transcript || [];
  return {
    id: session.id,
    kind: session.kind,
    title: sessionTitle(session),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    updatedAt: session.updatedAt,
    turnCount: transcript.length,
    questionCount: transcript.filter((t) => t.channel === 'them').length,
    answerCount: (session.answers || []).length,
    hasDebrief: !!(session.debrief && session.debrief.trim())
  };
}

function hasContent(session) {
  return !!session && ((session.transcript || []).length > 0 || (session.answers || []).length > 0);
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function quote(text) {
  return String(text || '').trim().split('\n').map((line) => '> ' + line).join('\n');
}

/**
 * Readable Markdown for review or sharing: header, debrief, then the
 * conversation with cue's suggestions interleaved in time order.
 */
function sessionToMarkdown(session) {
  const out = [];
  out.push('# ' + sessionTitle(session), '');
  const end = session.endedAt || session.updatedAt || session.startedAt;
  out.push(`- **Date:** ${formatDate(session.startedAt)}`);
  out.push(`- **Duration:** ${formatDuration(end - session.startedAt)}`);
  out.push(`- **Type:** ${session.kind === 'practice' ? 'Practice interview with cue' : 'Live interview'}`);
  out.push('');
  if (session.debrief && session.debrief.trim()) {
    out.push('## Debrief', '', session.debrief.trim(), '');
  }
  out.push('## Conversation', '');
  const events = [
    ...(session.transcript || []).map((t) => ({ ts: t.ts, kind: 'turn', t })),
    ...(session.answers || []).map((a) => ({ ts: a.ts, kind: 'answer', a }))
  ].sort((x, y) => (x.ts || 0) - (y.ts || 0));
  if (!events.length) out.push('_Nothing was captured._', '');
  for (const event of events) {
    if (event.kind === 'turn') {
      out.push(`**${SPEAKER[event.t.channel] || event.t.channel}** (${formatClock(event.t.ts)}): ${event.t.text.trim()}`, '');
    } else {
      const label = MODE_LABELS[event.a.mode] || event.a.mode;
      const prompt = event.a.prompt ? ` — "${event.a.prompt.trim().slice(0, 120)}"` : '';
      out.push(`**cue · ${label}**${prompt} (${formatClock(event.a.ts)}):`, '', quote(event.a.text), '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// Stable per session (the title can change as questions arrive), and safe on
// every platform's file system.
function exportFileName(session) {
  const d = new Date(session.startedAt);
  const kind = session.kind === 'practice' ? 'Practice' : 'Interview';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${kind} (cue ${session.id.slice(-6)}).md`;
}

function writeFileAtomic(file, text) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class SessionStore {
  constructor({ dir }) {
    this.dir = dir;
  }

  _file(id) {
    if (!isValidId(id)) throw new Error('Invalid session id.');
    return path.join(this.dir, id + '.json');
  }

  save(session) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this._file(session.id), JSON.stringify(session, null, 2));
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  remove(id) {
    try { fs.unlinkSync(this._file(id)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  /** Summaries, newest first. A query matches title, transcript, answers or debrief. */
  list(query = '') {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const needle = String(query || '').trim().toLowerCase();
    const out = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !isValidId(id)) continue;
      let session;
      try { session = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { continue; }
      if (needle && !matches(session, needle)) continue;
      out.push(summarize(session));
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }
}

function matches(session, needle) {
  const fields = [sessionTitle(session), session.debrief,
    ...(session.transcript || []).map((t) => t.text), ...(session.answers || []).map((a) => a.text)];
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle));
}

/**
 * Records the live session: every transcript turn and completed answer, saved
 * shortly after each change and when the session ends. Does nothing while
 * saving is off, so nothing is written without the user's choice.
 */
class SessionRecorder {
  constructor({ store, isEnabled, exportDir = () => '', onSaved = () => {}, onError = () => {}, debounceMs = 1500, now = () => Date.now(), timers = { setTimeout, clearTimeout } }) {
    this.store = store;
    this.isEnabled = isEnabled;
    this.exportDir = exportDir;
    this.onSaved = onSaved;
    this.onError = onError;
    this.debounceMs = debounceMs;
    this.now = now;
    this.timers = timers;
    this.session = null;
    this.kind = 'interview';
    this.timer = null;
  }

  current() { return this.session; }

  _ensure() {
    if (!this.session) this.session = newSession({ kind: this.kind, now: this.now() });
    return this.session;
  }

  addTurn(turn) {
    if (!this.isEnabled() || !turn || !turn.text) return;
    const entry = { channel: turn.channel, text: turn.text, ts: turn.ts || this.now() };
    if (turn.source) entry.source = turn.source;
    this._ensure().transcript.push(entry);
    this._schedule();
  }

  addAnswer({ mode, prompt, text, ts }) {
    if (!this.isEnabled() || !text || !text.trim()) return;
    this._ensure().answers.push({ mode, prompt: prompt || '', text: text.trim(), ts: ts || this.now() });
    this._schedule();
  }

  /** The kind of the next session ('interview' or 'practice'). */
  setKind(kind) {
    this.kind = kind;
    if (this.session && !hasContent(this.session)) this.session.kind = kind;
  }

  /** Close the current session; returns its id when something was saved. */
  end() {
    const session = this.session;
    this.session = null;
    this._cancel();
    if (!hasContent(session)) return null;
    session.endedAt = this.now();
    return this._write(session) ? session.id : null;
  }

  /** Forget the current session without saving (it is being deleted). */
  discard() {
    this._cancel();
    this.session = null;
  }

  flush() {
    this._cancel();
    if (hasContent(this.session)) this._write(this.session);
  }

  _write(session) {
    try {
      session.updatedAt = this.now();
      this.store.save(session);
      const dir = this.exportDir();
      if (dir) writeFileAtomic(path.join(dir, exportFileName(session)), sessionToMarkdown(session));
      this.onSaved(summarize(session));
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  _schedule() {
    this._cancel();
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
  }

  _cancel() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = {
  SessionStore, SessionRecorder, newSession, sessionTitle, summarize, sessionToMarkdown,
  exportFileName, isValidId, hasContent, writeFileAtomic
};
