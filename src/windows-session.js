// Is this process attached to the machine's local console session?
//
// Screen-share hiding (WDA_EXCLUDEFROMCAPTURE) is only safe on the local
// console: on RDP / Cloud PC / most VM consoles it blanks the window for the
// user too (see main.js). The session is read from Windows itself, because the
// SESSIONNAME environment variable is only as good as the launcher: agents,
// schedulers and some shells start cue without it, and a process started on
// the console keeps "Console" after the same session is reconnected over RDP.
const { execFile } = require('node:child_process');
const path = require('node:path');

// tasklist /FO CSV /NH rows: "Image Name","PID","Session Name","Session#","Mem Usage"
function parseTasklistSessionName(output, pid) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (cells.length >= 4 && cells[1] === String(pid)) return cells[2];
  }
  return '';
}

function runTasklist(pid, env) {
  const exe = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
  return new Promise((resolve, reject) => {
    execFile(exe, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 3000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/**
 * @returns {Promise<{local: boolean, sessionName: string, source: 'platform'|'tasklist'|'env'|'unknown'}>}
 * Anything not confirmed as the local console is reported as not local, which
 * keeps the window visible to the user rather than risking a blank one.
 */
async function detectConsoleSession({ platform = process.platform, env = process.env, pid = process.pid, run = runTasklist } = {}) {
  if (platform !== 'win32') return { local: true, sessionName: '', source: 'platform' };
  let sessionName = '';
  try { sessionName = parseTasklistSessionName(await run(pid, env), pid); } catch { /* fall back to the environment */ }
  if (sessionName) return { local: sessionName === 'Console', sessionName, source: 'tasklist' };
  if (env.SESSIONNAME) return { local: env.SESSIONNAME === 'Console', sessionName: env.SESSIONNAME, source: 'env' };
  return { local: false, sessionName: '', source: 'unknown' };
}

module.exports = { detectConsoleSession, parseTasklistSessionName };
