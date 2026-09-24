const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, resolveShortcuts, findConflicts, isValid } = require('../src/shortcuts');

test('defaults cover the core actions', () => {
  assert.strictEqual(DEFAULTS.assist, 'CommandOrControl+Return');
  assert.ok(DEFAULTS.leetcode);
  assert.ok(DEFAULTS.quit);
});

test('resolveShortcuts merges overrides', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+L' });
  assert.strictEqual(map.leetcode, 'CommandOrControl+L');
  assert.strictEqual(map.assist, DEFAULTS.assist);
});

test('findConflicts detects duplicate accelerators', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+Return' });
  const conflicts = findConflicts(map);
  assert.ok(conflicts.some(([a, b]) => (a === 'assist' && b === 'leetcode') || (a === 'leetcode' && b === 'assist')));
});

test('no conflicts in the default set', () => {
  assert.strictEqual(findConflicts(resolveShortcuts()).length, 0);
});

test('isValid accepts good accelerators and rejects junk', () => {
  assert.ok(isValid('CommandOrControl+Return'));
  assert.ok(isValid('Shift+Q'));
  assert.ok(isValid('F1'));
  assert.strictEqual(isValid(''), false);
  assert.strictEqual(isValid('++'), false);
  assert.strictEqual(isValid(null), false);
});
test('an empty override clears an action; unknown actions are ignored', () => {
  const map = resolveShortcuts({ scrollUp: '', bogus: 'Ctrl+B' });
  assert.strictEqual(map.scrollUp, '');
  assert.strictEqual(map.bogus, undefined);
  assert.strictEqual(map.scrollDown, DEFAULTS.scrollDown);
});

test('conflicts are found regardless of alias spelling or modifier order', () => {
  const conflicts = findConflicts(resolveShortcuts({ say: 'Shift+CmdOrCtrl+H' }));
  assert.ok(conflicts.some(([a, b]) => a === 'say' && b === 'screenshot' || a === 'screenshot' && b === 'say'));
});

test('every action has a label and every default is valid', () => {
  const { ACTIONS } = require('../src/shortcuts');
  for (const action of ACTIONS) {
    assert.ok(action.label, action.id);
    if (action.defaultAccelerator) assert.ok(isValid(action.defaultAccelerator), action.id);
  }
  assert.ok(['listen', 'stop', 'scrollUp', 'moveLeft', 'autoAnswer'].every((id) => id in DEFAULTS));
});
