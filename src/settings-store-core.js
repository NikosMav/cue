// Durable, atomic JSON file persistence for cue's settings store.
//
// Why this exists as its own module: the previous store wrote the settings
// file with a bare fs.writeFileSync (which truncates the destination before
// writing) and swallowed every error. A crash or power loss mid-write left
// corrupt JSON, and the next load() then silently reset every saved API key
// and setting to blank — unrecoverable, because the very next save overwrote
// whatever remained. It also could not be unit tested at all on its own,
// because src/store.js calls app.getPath('userData') at require time, which
// throws outside Electron.
//
// This module owns only the file mechanics — not cue's settings schema or
// defaults, which stay in src/store.js as the single source of truth for
// what a "settings object" is. Writes are atomic:
//   1. serialize to FILE.tmp                (a crash here leaves the real file intact)
//   2. copy the previous FILE to FILE.bak   (best-effort, one generation)
//   3. rename TMP over FILE                 (atomic replace, Windows-safe in Node;
//                                            falls back to an in-place write when
//                                            another process briefly holds FILE —
//                                            e.g. antivirus on Windows)
// On load, a corrupt or truncated FILE is recovered from FILE.bak before
// falling back to "nothing on disk yet", and every failure is logged instead
// of swallowed. The file (and its .tmp/.bak siblings) are always written
// 0600: this holds every BYO API key plus the publik key. 0600 is a no-op on
// Windows, where ACLs already default to the owning user.
const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600;

function createFileStore(resolveUserDataDir, label) {
  // Resolved lazily so merely requiring this module never touches Electron.
  let filePath = null;
  function mainPath() {
    if (!filePath) filePath = path.join(resolveUserDataDir(), label);
    return filePath;
  }
  const tmpPath = () => mainPath() + '.tmp';
  const bakPath = () => mainPath() + '.bak';

  function readJson(candidate) {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  }

  function chmodQuiet(target) {
    try { fs.chmodSync(target, FILE_MODE); } catch (_) { /* e.g. unsupported on this fs */ }
  }

  /**
   * @returns {{ data: object, recoveredFromBackup: boolean } | null}
   *   null means neither the file nor its backup are usable — the caller
   *   should start from defaults. A missing main file on first run is
   *   expected and stays quiet; anything else unreadable is logged.
   */
  function load() {
    let mainMissing = false;
    try {
      return { data: readJson(mainPath()), recoveredFromBackup: false };
    } catch (e) {
      mainMissing = e && e.code === 'ENOENT';
      if (!mainMissing) console.error('[cue] cannot read ' + mainPath() + ':', e && e.message);
    }

    // The main file is gone or unusable. A stale .bak from the previous good
    // save is strictly better than blanking every key the user has stored.
    try {
      const data = readJson(bakPath());
      console.error('[cue] ' + label + ' was lost or corrupt — recovered settings from backup');
      return { data, recoveredFromBackup: true };
    } catch (bakErr) {
      if (!(bakErr && bakErr.code === 'ENOENT')) {
        console.error('[cue] cannot read backup ' + bakPath() + ':', bakErr && bakErr.message);
      }
    }

    if (!mainMissing) console.error('[cue] no usable backup for ' + label + '; starting from defaults');
    return null;
  }

  // Serialize → snapshot the previous good state → atomic replace. Throws on
  // failure rather than swallowing it, so the caller can surface a save error
  // instead of silently pretending the write succeeded.
  function persist(data) {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath(), json, { mode: FILE_MODE });
    try {
      if (fs.existsSync(mainPath())) fs.copyFileSync(mainPath(), bakPath());
      chmodQuiet(bakPath());
    } catch (_) { /* backup is best-effort; never block the save */ }
    try {
      fs.renameSync(tmpPath(), mainPath());
    } catch (_) {
      // Windows: antivirus/indexers can hold the target open for a moment,
      // making rename fail with EPERM. An in-place write still beats losing
      // the user's keys over a transient lock.
      fs.writeFileSync(mainPath(), json, { mode: FILE_MODE });
      try { fs.unlinkSync(tmpPath()); } catch (_) {}
    }
    // writeFileSync's mode option only applies when the file is created; a
    // pre-existing tmp/main file (from a previous run, or on the in-place
    // fallback above) keeps its old permissions unless forced here.
    chmodQuiet(mainPath());
  }

  return { load, persist, mainPath, tmpPath, bakPath };
}

module.exports = { createFileStore };
