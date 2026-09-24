// Editor terminals may set this flag, which makes Electron act as Node.
// Clear it in the child only; leave the caller's environment intact.
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit',
  windowsHide: true
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code === null ? 1 : code; });
