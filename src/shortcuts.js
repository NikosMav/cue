// Configurable global shortcuts. Kept dependency-free so it is unit-testable.
// Accelerator strings follow Electron's format, e.g. 'CommandOrControl+Return'.
// An empty string means the action has no shortcut.

// Every action that can have a global shortcut, in the order Settings lists
// them. Global shortcuts work while another app (the meeting, the editor) has
// focus, but they also take the key combination away from that app, so every
// default can be changed or cleared.
const ACTIONS = [
  { id: 'assist', label: 'Assist', defaultAccelerator: 'CommandOrControl+Return' },
  { id: 'say', label: 'What should I say?', defaultAccelerator: 'CommandOrControl+Shift+Return' },
  { id: 'leetcode', label: 'Solve what\'s on screen', defaultAccelerator: 'CommandOrControl+H' },
  { id: 'screenshot', label: 'Add a screenshot for the solver', defaultAccelerator: 'CommandOrControl+Shift+H' },
  { id: 'listen', label: 'Start / stop listening', defaultAccelerator: 'CommandOrControl+Shift+L' },
  { id: 'autoAnswer', label: 'Auto-answer on / off', defaultAccelerator: '' },
  { id: 'stop', label: 'Stop the current answer', defaultAccelerator: 'CommandOrControl+Shift+Backspace' },
  { id: 'scrollUp', label: 'Scroll answers up', defaultAccelerator: 'CommandOrControl+Alt+Up' },
  { id: 'scrollDown', label: 'Scroll answers down', defaultAccelerator: 'CommandOrControl+Alt+Down' },
  { id: 'moveLeft', label: 'Move panel left', defaultAccelerator: 'CommandOrControl+Alt+Shift+Left' },
  { id: 'moveRight', label: 'Move panel right', defaultAccelerator: 'CommandOrControl+Alt+Shift+Right' },
  { id: 'moveUp', label: 'Move panel up', defaultAccelerator: 'CommandOrControl+Alt+Shift+Up' },
  { id: 'moveDown', label: 'Move panel down', defaultAccelerator: 'CommandOrControl+Alt+Shift+Down' },
  { id: 'hide', label: 'Collapse / expand panel', defaultAccelerator: 'CommandOrControl+Shift+/' },
  { id: 'quit', label: 'Quit cue', defaultAccelerator: 'CommandOrControl+Shift+X' }
];

const DEFAULTS = Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a.id, a.defaultAccelerator])));

// Configured accelerator per action: an override (including '' to clear) wins
// over the default. Unknown actions in the overrides are ignored.
function resolveShortcuts(overrides = {}) {
  const out = {};
  const own = overrides && typeof overrides === 'object' ? overrides : {};
  for (const [action, def] of Object.entries(DEFAULTS)) {
    const v = Object.prototype.hasOwnProperty.call(own, action) && typeof own[action] === 'string' ? own[action].trim() : def;
    out[action] = v;
  }
  return out;
}

// Detect collisions between configured accelerators (a global shortcut can only be
// registered once). Returns an array of [actionA, actionB, accelerator] pairs.
function findConflicts(map) {
  const seen = new Map();
  const conflicts = [];
  for (const [action, accel] of Object.entries(map)) {
    if (!accel) continue;
    const key = normalize(accel);
    if (seen.has(key)) conflicts.push([seen.get(key), action, accel]);
    else seen.set(key, action);
  }
  return conflicts;
}

// Same combination regardless of alias spelling or modifier order.
function normalize(accel) {
  const alias = { cmdorctrl: 'commandorcontrol', cmd: 'command', ctrl: 'control', option: 'alt', enter: 'return', esc: 'escape' };
  const parts = accel.split('+').map((p) => p.trim().toLowerCase()).map((p) => alias[p] || p);
  const key = parts.pop();
  return [...parts.sort(), key].join('+');
}

const MODIFIERS = new Set(['CommandOrControl', 'CmdOrCtrl', 'Command', 'Cmd', 'Control', 'Ctrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']);

// Basic validity check: must contain at least a non-modifier key and plausible modifiers.
function isValid(accel) {
  if (!accel || typeof accel !== 'string') return false;
  const parts = accel.split('+').map((s) => s.trim());
  if (parts.some((p) => !p)) return false;
  const keys = parts.filter((p) => !MODIFIERS.has(p));
  return keys.length >= 1;
}

module.exports = { ACTIONS, DEFAULTS, resolveShortcuts, findConflicts, isValid };
