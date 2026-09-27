const assert = require('node:assert/strict');
const test = require('node:test');
const { pcmToWav } = require('../src/wav');

test('wraps PCM samples in a valid mono 16-bit WAV container', () => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-1000, 2);

  const wav = pcmToWav(pcm, 16000, 1);

  assert.equal(wav.length, 48);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('rms16 measures the level of Int16LE PCM', () => {
  const { rms16 } = require('../src/wav');
  const pcm = Buffer.alloc(8);
  [300, -300, 300, -300].forEach((s, i) => pcm.writeInt16LE(s, i * 2));
  assert.equal(rms16(pcm), 300);
  assert.equal(rms16(Buffer.alloc(0)), 0);
});

// main.js logs audio levels on every chunk; a helper it imports but src/wav.js
// no longer exports throws on each chunk and blocks the main process behind an
// error dialog (the 2026-09-25 merge did exactly that).
test('main.js imports only helpers src/wav.js exports, and imports rms16 where it uses it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const wav = require('../src/wav');
  const imports = [...source.matchAll(/const \{([^}]*)\} = require\('\.\/src\/wav'\)/g)]
    .flatMap((m) => m[1].split(',').map((name) => name.trim()).filter(Boolean));
  for (const name of imports) assert.equal(typeof wav[name], 'function', `src/wav.js must export ${name}`);
  if (/\brms16\(/.test(source)) assert.ok(imports.includes('rms16'), 'main.js calls rms16 without importing it');
});
