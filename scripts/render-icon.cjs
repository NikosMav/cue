// Renders build-resources/icon.png (1024x1024) from cue's own logo glyph in
// renderer/icons.js. electron-builder derives the Windows .ico, the macOS .icns
// and the Linux icons from it.
// usage: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SIZE = 1024;

app.whenReady().then(async () => {
  const source = fs.readFileSync(path.join(root, 'renderer/icons.js'), 'utf8');
  const glyph = /const LOGO = ('[\s\S]*?'<\/svg>');/.exec(source);
  if (!glyph) throw new Error('logo glyph not found in renderer/icons.js');
  // The glyph is a concatenation of single-quoted string literals.
  const logo = Function('"use strict"; return (' + glyph[1] + ');')().replaceAll('SIZE', '600');
  const html = `<!doctype html><html style="overflow:hidden;background:transparent"><body style="margin:0;overflow:hidden;background:transparent">
    <div style="width:${SIZE}px;height:${SIZE}px;display:grid;place-items:center">
      <div style="width:880px;height:880px;border-radius:200px;display:grid;place-items:center;color:#fff;
        background:linear-gradient(145deg,#4A8DF7 0%,#3C83F5 45%,#2A5FC4 100%);
        box-shadow:inset 0 6px 0 rgba(255,255,255,0.18)">${logo}</div>
    </div></body></html>`;
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE, transparent: true, frame: false, backgroundColor: '#00000000',
    useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const image = (await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })).resize({ width: SIZE, height: SIZE });
  const out = path.join(root, 'build-resources/icon.png');
  fs.writeFileSync(out, image.toPNG());
  console.log('wrote ' + out + ' ' + JSON.stringify(image.getSize()));
  app.exit(0);
}).catch((e) => { console.error(e.stack || e); app.exit(1); });
