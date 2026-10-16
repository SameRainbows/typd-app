'use strict';

/**
 * Render the chosen identity's SVGs to the PNGs the installers and the site need.
 *
 *   node_modules\.bin\electron scripts\build-icons.js [mark]      (default: ligature)
 *
 * Writes assets/icon-build/<mark>/: win-16/24/32 from the hand-hinted px/ frames,
 * win-48/64/128/256 from the 256 master, mac-1024 from the Big Sur grid, and
 * touch-180 for the site. scripts/build-icons.py then packs typd.ico. Each SVG is drawn
 * at exactly its pixel size in the corner of a larger offscreen window and only that
 * square is captured -- Windows will not make a window as small as 16 px.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// electron <script> [mark]: argv is [electron, script, mark?]
const MARK = /^[a-z0-9-]+$/i.test(process.argv[2] || '') ? process.argv[2] : 'ligature';
const SRC = path.join(__dirname, '..', 'assets', 'brand', MARK);
const OUT = path.join(__dirname, '..', 'assets', 'icon-build', MARK);

const JOBS = [
  ['win-16.png', 'px/app-icon-win-16.svg', 16],
  ['win-24.png', 'px/app-icon-win-24.svg', 24],
  ['win-32.png', 'px/app-icon-win-32.svg', 32],
  ['win-48.png', 'app-icon-win.svg', 48],
  ['win-64.png', 'app-icon-win.svg', 64],
  ['win-128.png', 'app-icon-win.svg', 128],
  ['win-256.png', 'app-icon-win.svg', 256],
  ['mac-1024.png', 'app-icon.svg', 1024],
  ['touch-180.png', 'app-icon.svg', 180]
];

// Drawn onto a canvas inside a hidden page and exported from there: a window capture is
// clipped to the screen (a 1024 icon came out 1024x864) and depends on display scaling.
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 64, height: 64, show: false });
  await win.loadURL('data:text/html,<body></body>');
  for (const [name, file, N] of JOBS) {
    const svg = fs.readFileSync(path.join(SRC, file)).toString('base64');
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = ${N}; c.height = ${N};
        c.getContext('2d').drawImage(img, 0, 0, ${N}, ${N});
        done(c.toDataURL('image/png'));
      };
      img.onerror = () => fail(new Error('svg did not load'));
      img.src = 'data:image/svg+xml;base64,${svg}';
    })`);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(name, N + 'x' + N);
  }
  win.destroy();
  app.quit();
});
