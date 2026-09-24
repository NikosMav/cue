const fs = require('node:fs');
const path = require('node:path');

// A local locator contains only a directory path, never credentials. It is
// ignored by Git and included in local packaged builds when present.
function resolveDataDirectory({ appDirectory, defaultDirectory, env = process.env }) {
  let configured = env.CUE_DATA_DIR;
  if (!configured) {
    const locator = path.join(appDirectory, 'cue-local.json');
    try {
      configured = JSON.parse(fs.readFileSync(locator, 'utf8').replace(/^\uFEFF/, '')).userDataDirectory;
      if (typeof configured !== 'string' || !configured.trim()) throw new Error('Missing userDataDirectory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read Cue data location: ${locator}`);
    }
  }
  const directory = configured || defaultDirectory;
  if (!directory || !path.isAbsolute(directory)) throw new Error('Cue data directory must be an absolute path.');
  if (configured && (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())) {
    throw new Error(`Configured Cue data directory does not exist: ${directory}. Refusing to start with an empty profile.`);
  }
  return fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory);
}

function configureUserData(app, appDirectory) {
  const directory = resolveDataDirectory({ appDirectory, defaultDirectory: app.getPath('userData') });
  app.setPath('userData', directory);
  return directory;
}

module.exports = { resolveDataDirectory, configureUserData };
