// Converts a key press into an Electron accelerator and accelerators into
// readable labels. Shared by the Settings shortcut recorder (via preload) and
// tests; no Electron dependency.

const CODE_KEYS = {
  Enter: 'Return', NumpadEnter: 'Return', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Semicolon: ';', Quote: '\'', Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '='
};

// The key part of a keyboard event, or null for a lone modifier or an
// unsupported key. KeyboardEvent.code is layout-independent, which is what a
// global shortcut matches on.
function keyFromCode(code) {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] || null;
}

/**
 * @param {{code: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean}} event
 * @param {string} platform process.platform
 * @returns {{accelerator: string|null, error?: string}}
 */
function acceleratorFromEvent(event, platform) {
  const key = keyFromCode(event.code);
  if (!key) return { accelerator: null };
  const mods = [];
  // ⌘ on macOS and Ctrl elsewhere is the primary modifier; store it portably.
  const primary = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  if (primary) mods.push('CommandOrControl');
  if (platform === 'darwin' && event.ctrlKey) mods.push('Control');
  if (platform !== 'darwin' && event.metaKey) mods.push('Super');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  const isFunctionKey = /^F\d+$/.test(key);
  if (!mods.length && !isFunctionKey) {
    return { accelerator: null, error: 'Add a modifier (Ctrl, Alt, Shift or ⌘) so the shortcut does not take a plain key from other apps.' };
  }
  if (mods.length === 1 && mods[0] === 'Shift' && !isFunctionKey) {
    return { accelerator: null, error: 'Shift alone would take a typed character from other apps. Add Ctrl, Alt or ⌘.' };
  }
  return { accelerator: [...mods, key].join('+') };
}

const MAC_LABELS = { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Super: '⌘', Meta: '⌘' };
const PC_LABELS = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Command: 'Win', Cmd: 'Win', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift', Super: 'Win', Meta: 'Win' };
const MAC_KEYS = { Return: '↵', Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Space: 'Space' };
const PC_KEYS = { Return: 'Enter', Up: '↑', Down: '↓', Left: '←', Right: '→', Backspace: 'Backspace', Delete: 'Del', Escape: 'Esc', Space: 'Space' };

/** Readable parts of an accelerator, e.g. ['⌘', '⇧', 'H'] or ['Ctrl', 'Shift', 'H']. */
function acceleratorParts(accel, platform) {
  if (!accel) return [];
  const mac = platform === 'darwin';
  const labels = mac ? MAC_LABELS : PC_LABELS;
  const keys = mac ? MAC_KEYS : PC_KEYS;
  return accel.split('+').map((p) => p.trim()).filter(Boolean).map((p) => labels[p] || keys[p] || p);
}

function formatAccelerator(accel, platform) {
  return acceleratorParts(accel, platform).join(platform === 'darwin' ? '' : '+');
}

module.exports = { acceleratorFromEvent, acceleratorParts, formatAccelerator, keyFromCode };
