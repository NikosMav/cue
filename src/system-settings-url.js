// The renderer's "open settings" buttons hand main a URL to pass to
// shell.openExternal. Only the OS settings schemes may go through: a renderer
// that could open any URL could launch any registered protocol handler, so
// everything else is dropped here rather than trusted. No Electron dependency.

const SETTINGS_PROTOCOLS = new Set(['ms-settings:', 'x-apple.systempreferences:']);

function isSystemSettingsUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return SETTINGS_PROTOCOLS.has(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

module.exports = { isSystemSettingsUrl };
