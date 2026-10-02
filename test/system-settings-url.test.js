const test = require('node:test');
const assert = require('node:assert/strict');
const { isSystemSettingsUrl } = require('../src/system-settings-url');

test('the settings panes the app opens are allowed', () => {
  assert.equal(isSystemSettingsUrl('ms-settings:privacy-microphone'), true);
  assert.equal(isSystemSettingsUrl('ms-settings:privacy-screenrecorder'), true);
  assert.equal(isSystemSettingsUrl('ms-settings:privacy'), true);
  assert.equal(isSystemSettingsUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'), true);
  assert.equal(isSystemSettingsUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'), true);
});

test('anything else is dropped', () => {
  for (const url of [
    'https://example.com',
    'http://127.0.0.1:8080',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'search-ms:query=x',
    'ms-settings-evil:privacy',
    'MS-SETTINGS', // no colon: not a URL
    '',
    null,
    undefined,
    { toString: () => 'ms-settings:privacy' }
  ]) {
    assert.equal(isSystemSettingsUrl(url), false, String(url));
  }
});
