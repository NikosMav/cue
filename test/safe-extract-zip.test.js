// scripts/prepare-whisper-runtime.js unpacks release zips with its own checked
// extractor (extract-zip <= 2.0.1 followed symlinks and escaping paths).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { extractZip } = require('../scripts/prepare-whisper-runtime');

async function zipFile(entries) {
  const zip = new JSZip();
  for (const [name, content, options] of entries) zip.file(name, content, options);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-zip-')), 'a.zip');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  return file;
}

test('a normal archive unpacks with its folders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-out-'));
  await extractZip(await zipFile([['bin/whisper-server', 'exe'], ['LICENSE', 'mit']]), { dir });
  assert.equal(fs.readFileSync(path.join(dir, 'bin', 'whisper-server'), 'utf8'), 'exe');
  assert.equal(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), 'mit');
});

test('an entry that climbs out of the target folder is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-out-'));
  const archive = await zipFile([['../escaped.txt', 'x']]);
  await assert.rejects(extractZip(archive, { dir }), /Unsafe archive path/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'escaped.txt')), false, 'not written under another name either');
});

test('a symbolic link entry is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-out-'));
  const archive = await zipFile([['link', '/etc/passwd', { unixPermissions: 0o120777 }]]);
  await assert.rejects(extractZip(archive, { dir }), /symbolic link/);
});
