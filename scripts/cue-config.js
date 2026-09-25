// Native, secret-free status and narrow profile imports. Never print settings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { resolveDataDirectory } = require('../src/config-path');
const { mergeProfile } = require('../src/profile-import');
const { effectiveSettings, ABOUT_ME_FIELDS } = require('../src/setups');
const FLAT_PREP_FIELDS = ['resumeText', 'jobDescription', 'knowledgeBase', 'starStories', 'whyCompany', 'whyLeaving', 'workStyle', 'salaryTarget', 'questionsToAsk', 'aiRules'];

try {
  const fallback = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'cue')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'cue')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cue');
  const directory = resolveDataDirectory({ appDirectory: path.join(__dirname, '..'), defaultDirectory: fallback });
  const file = path.join(directory, 'cue-data.json');
  const raw = fs.readFileSync(file, 'utf8');
  let settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings file.');
  const command = process.argv[2] || 'status';
  if (command === 'import-profile') {
    if (!process.argv[3] || process.argv[3].startsWith('--')) throw new Error('Usage: node scripts/cue-config.js import-profile <profile.json> [--setup <name>]');
    const profile = JSON.parse(fs.readFileSync(path.resolve(process.argv[3]), 'utf8').replace(/^\uFEFF/, ''));
    const setupFlag = process.argv.indexOf('--setup');
    let setupName = '';
    if (setupFlag > 0) {
      const nextArg = process.argv[setupFlag + 1];
      if (!nextArg || nextArg.startsWith('--')) throw new Error('--setup needs a setup name. Usage: node scripts/cue-config.js import-profile <profile.json> [--setup <name>]');
      setupName = nextArg;
    }
    settings = mergeProfile(settings, profile, { setupName });
    const backups = path.join(directory, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, `before-profile-${crypto.randomUUID()}.json`), raw, { mode: 0o600, flag: 'wx' });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600, flag: 'wx' });
      // Do not overwrite an intervening save from a still-running app or agent.
      if (fs.readFileSync(file, 'utf8') !== raw) throw new Error('Settings changed during import. Quit Cue and retry.');
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  } else if (command !== 'status') throw new Error('Commands: status, import-profile <profile.json>');
  const view = effectiveSettings(settings);
  console.log(JSON.stringify({
    host: os.hostname(), platform: process.platform, settingsFile: file,
    modifiedUtc: fs.statSync(file).mtime.toISOString(), provider: settings.provider,
    credentialProviders: Object.entries(settings.apiKeys || {}).filter(([, value]) => typeof value === 'string' && value.trim()).map(([name]) => name),
    profileFields: FLAT_PREP_FIELDS.filter((name) => typeof view[name] === 'string' && view[name].trim()),
    aboutMeFields: ABOUT_ME_FIELDS.filter((name) => view.aboutMe[name] && view.aboutMe[name].trim()),
    setups: view.setups.map((s) => ({ name: s.name, kind: s.kind, saveSessions: s.saveSessions, active: s.id === view.activeSetupId })),
    answerLength: settings.answerLength, includeScreen: settings.includeScreen
  }, null, 2));
} catch (error) {
  // JSON parse errors can echo parts of credentials; report only a safe summary.
  console.error(error instanceof SyntaxError ? 'Invalid JSON; no configuration was changed.' : error.message);
  process.exitCode = 1;
}
