const assert = require('node:assert/strict');
const test = require('node:test');

const { detectConsoleSession, parseTasklistSessionName } = require('../src/windows-session');

const row = (name, pid, session) => `"${name}","${pid}","${session}","1","84,808 K"\r\n`;
const tasklist = (output) => async () => output;

test('reads the session name for the requested PID from tasklist CSV', () => {
  const out = row('cue.exe', 41, 'Console') + row('cue.exe', 4100, 'RDP-Tcp#3');
  assert.equal(parseTasklistSessionName(out, 41), 'Console');
  assert.equal(parseTasklistSessionName(out, 4100), 'RDP-Tcp#3');
  assert.equal(parseTasklistSessionName('INFO: No tasks are running which match the specified criteria.\r\n', 41), '');
});

test('a local console session is detected when the launcher dropped SESSIONNAME', async () => {
  const result = await detectConsoleSession({ platform: 'win32', env: {}, pid: 7, run: tasklist(row('cue.exe', 7, 'Console')) });
  assert.deepEqual(result, { local: true, sessionName: 'Console', source: 'tasklist' });
});

test('Windows wins over a stale SESSIONNAME after the session moved to Remote Desktop', async () => {
  const result = await detectConsoleSession({ platform: 'win32', env: { SESSIONNAME: 'Console' }, pid: 7, run: tasklist(row('cue.exe', 7, 'RDP-Tcp#2')) });
  assert.equal(result.local, false);
  assert.equal(result.sessionName, 'RDP-Tcp#2');
});

test('falls back to SESSIONNAME when tasklist is unavailable', async () => {
  const fail = async () => { throw new Error('ENOENT'); };
  assert.equal((await detectConsoleSession({ platform: 'win32', env: { SESSIONNAME: 'Console' }, pid: 7, run: fail })).local, true);
  assert.equal((await detectConsoleSession({ platform: 'win32', env: { SESSIONNAME: 'RDP-Tcp#1' }, pid: 7, run: fail })).local, false);
});

test('an unconfirmed session keeps the window visible rather than risking a blank one', async () => {
  const result = await detectConsoleSession({ platform: 'win32', env: {}, pid: 7, run: tasklist('') });
  assert.deepEqual(result, { local: false, sessionName: '', source: 'unknown' });
});

test('other platforms do not consult Windows sessions', async () => {
  let called = false;
  const result = await detectConsoleSession({ platform: 'darwin', env: {}, pid: 7, run: async () => { called = true; return ''; } });
  assert.equal(result.local, true);
  assert.equal(called, false);
});

test('queries the real tasklist for this process on Windows', { skip: process.platform !== 'win32' }, async () => {
  const result = await detectConsoleSession();
  assert.equal(result.source, 'tasklist');
  assert.ok(result.sessionName.length > 0);
});
