'use strict';

/**
 * Logo candidates in the real tray, beside Typd's own icon, without touching the app.
 *
 *   node_modules\.bin\electron scripts\tray-preview.js
 *
 * Adds four icons: the Ligature mark plain (design/identity-study-02.html, drawn per
 * display scale so edges land on whole pixels), the mark white on a black tile, black on a
 * white tile, and Typd's previous tray dot for comparison. Hover for the name;
 * right-click either one → Close preview. Runs as plain Electron, so it does not
 * collide with Typd's single-instance lock.
 */

const path = require('path');
const { app, Tray, Menu, nativeImage, nativeTheme, BrowserWindow } = require('electron');

function ligature(N) {
  const w = Math.max(1, Math.round(N / 8));
  const a = Math.round(N / 4);
  const ideal = N * 12 / 16;
  let W = null;
  for (let c = Math.floor(ideal) - 1; c <= Math.ceil(ideal) + 1; c++)
    if ((N - c) % 2 === 0 && (W === null || Math.abs(c - ideal) < Math.abs(W - ideal))) W = c;
  const x0 = (N - W) / 2;
  return { w, top: a, bot: N - a, x0, x1: x0 + W };
}

function ligatureBitmap(N, [R, G, B]) {
  const ss = 4, big = N * ss, buf = Buffer.alloc(big * big * 4);
  const { w, top, bot, x0, x1 } = ligature(N);
  const c = { x0: x0 + w, x1: x1 - w, y0: top + w, y1: bot - w };
  const r = Math.min(c.x1 - c.x0, c.y1 - c.y0) / 2;
  const inCounter = (x, y) => {
    if (x < c.x0 || x >= c.x1 || y < c.y0 || y >= c.y1) return false;
    const qx = Math.min(Math.max(x, c.x0 + r), c.x1 - r);
    const qy = Math.min(Math.max(y, c.y0 + r), c.y1 - r);
    return (x - qx) ** 2 + (y - qy) ** 2 <= r * r;
  };
  const inMark = (x, y) =>
    (x >= x1 - w && x < x1 && y < bot) ||
    (x >= x0 && x < x0 + w && y >= top) ||
    (x >= x0 && x < x1 && y >= top && y < bot && !inCounter(x, y));
  for (let py = 0; py < big; py++) {
    for (let px = 0; px < big; px++) {
      if (!inMark((px + 0.5) / ss, (py + 0.5) / ss)) continue;
      const i = (py * big + px) * 4;
      buf[i] = B; buf[i + 1] = G; buf[i + 2] = R; buf[i + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: big, height: big }).resize({ width: N, height: N, quality: 'best' });
}

const ink = () => (nativeTheme.shouldUseDarkColors ? [0xF4, 0xF5, 0xF7] : [0x14, 0x16, 0x1B]);

function ligatureIcon() {
  const img = nativeImage.createEmpty();
  for (const s of [1, 1.25, 1.5, 2]) {
    const N = Math.round(16 * s);
    img.addRepresentation({ scaleFactor: s, width: N, height: N, buffer: ligatureBitmap(N, ink()).toBitmap() });
  }
  return img;
}

/** The wordmark SVG, recoloured to the taskbar's ink and rendered offscreen into a square. */
async function wordmarkIcon() {
  const fs = require('fs');
  const [R, G, B] = ink();
  let svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'brand', 'ligature', 'wordmark.svg'), 'utf8');
  svg = svg.replace(/fill="[^"]*"/g, `fill="rgb(${R},${G},${B})"`).replace(/currentColor/g, `rgb(${R},${G},${B})`);
  const size = 128;
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">
    <img style="width:${size}px;height:auto" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 300));
  const shot = await win.webContents.capturePage();
  win.destroy();
  const img = nativeImage.createEmpty();
  for (const s of [1, 1.25, 1.5, 2]) {
    const N = Math.round(16 * s);
    img.addRepresentation({ scaleFactor: s, width: N, height: N, buffer: shot.resize({ width: N, height: N, quality: 'best' }).toBitmap() });
  }
  return img;
}

/** Ligature on a rounded tile: the mark at ~70 % of the square, centred. */
function tileBitmap(N, bg, fg, ratio = 0.7, corner = 0.22) {
  const ss = 4, big = N * ss, buf = Buffer.alloc(big * big * 4);
  const M = Math.max(8, Math.round(N * ratio) - (Math.round(N * ratio) - N) % 2);
  const off = (N - M) / 2;
  const { w, top, bot, x0, x1 } = ligature(M);
  const c = { x0: x0 + w, x1: x1 - w, y0: top + w, y1: bot - w };
  const r = Math.min(c.x1 - c.x0, c.y1 - c.y0) / 2;
  const inCounter = (x, y) => {
    if (x < c.x0 || x >= c.x1 || y < c.y0 || y >= c.y1) return false;
    const qx = Math.min(Math.max(x, c.x0 + r), c.x1 - r), qy = Math.min(Math.max(y, c.y0 + r), c.y1 - r);
    return (x - qx) ** 2 + (y - qy) ** 2 <= r * r;
  };
  const inMark = (x, y) => (x >= x1 - w && x < x1 && y < bot) || (x >= x0 && x < x0 + w && y >= top) ||
    (x >= x0 && x < x1 && y >= top && y < bot && !inCounter(x, y));
  const R = N * corner;
  const inTile = (x, y) => {
    const qx = Math.min(Math.max(x, R), N - R), qy = Math.min(Math.max(y, R), N - R);
    return (x - qx) ** 2 + (y - qy) ** 2 <= R * R;
  };
  for (let py = 0; py < big; py++) {
    for (let px = 0; px < big; px++) {
      const x = (px + 0.5) / ss, y = (py + 0.5) / ss;
      if (!inTile(x, y)) continue;
      const col = inMark(x - off, y - off) ? fg : bg;
      const i = (py * big + px) * 4;
      buf[i] = col[2]; buf[i + 1] = col[1]; buf[i + 2] = col[0]; buf[i + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: big, height: big }).resize({ width: N, height: N, quality: 'best' });
}

/** Typd's previous tray icon: a plain near-white dot. */
function dotBitmap(N) {
  const ss = 4, big = N * ss, buf = Buffer.alloc(big * big * 4);
  const r = big / 2 - ss, c = big / 2;
  for (let y = 0; y < big; y++) for (let x = 0; x < big; x++) {
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    if (dx * dx + dy * dy <= r * r) { const i = (y * big + x) * 4; buf[i] = 0xF7; buf[i + 1] = 0xF5; buf[i + 2] = 0xF4; buf[i + 3] = 0xff; }
  }
  return nativeImage.createFromBitmap(buf, { width: big, height: big }).resize({ width: N, height: N, quality: 'best' });
}

function multi(draw) {
  const img = nativeImage.createEmpty();
  for (const s of [1, 1.25, 1.5, 2]) {
    const N = Math.round(16 * s);
    img.addRepresentation({ scaleFactor: s, width: N, height: N, buffer: draw(N).toBitmap() });
  }
  return img;
}

/**
 * The study's Windows app icon, from its hand-hinted SVG frames (assets/brand/ligature/px,
 * 16/24/32; 20 from the 256 master), each rendered offscreen at exactly its pixel size.
 */
async function appIcon() {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'assets', 'brand', 'ligature');
  const frames = { 1: 'px/app-icon-win-16.svg', 1.25: 'app-icon-win.svg', 1.5: 'px/app-icon-win-24.svg', 2: 'px/app-icon-win-32.svg' };
  const img = nativeImage.createEmpty();
  for (const [s, file] of Object.entries(frames)) {
    const N = Math.round(16 * s);
    const svg = fs.readFileSync(path.join(dir, file));
    // Windows will not make a window smaller than its minimum size, so the SVG is drawn in
    // the corner of a larger window and only its own N x N square is captured -- capturing
    // the whole window and shrinking it is what made this icon tiny.
    const win = new BrowserWindow({ width: 200, height: 200, show: false, transparent: true, frame: false,
      useContentSize: true, webPreferences: { offscreen: true, zoomFactor: 1 } });
    const html = `<html><body style="margin:0;background:transparent"><img style="display:block;width:${N}px;height:${N}px"
      src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`;
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise((r) => setTimeout(r, 250));
    const shot = (await win.webContents.capturePage({ x: 0, y: 0, width: N, height: N }))
      .resize({ width: N, height: N, quality: 'best' });
    win.destroy();
    img.addRepresentation({ scaleFactor: Number(s), width: N, height: N, buffer: shot.toBitmap() });
  }
  return img;
}

const WHITE = [0xF4, 0xF5, 0xF7], BLACK = [0x14, 0x16, 0x1B];
const trays = [];
app.whenReady().then(async () => {
  const close = Menu.buildFromTemplate([{ label: 'Close preview', click: () => app.quit() }]);
  const add = (img, tip) => { const t = new Tray(img); t.setToolTip(tip); t.setContextMenu(close); trays.push(t); };
  add(ligatureIcon(), 'Preview 1 — Ligature, plain');
  add(multi((N) => tileBitmap(N, BLACK, WHITE)), 'Preview 2 — Ligature, white on black');
  add(multi((N) => tileBitmap(N, WHITE, BLACK)), 'Preview 3 — Ligature, black on white');
  add(multi(dotBitmap), 'Preview 4 — previous Typd icon (dot)');
  try {
    add(await appIcon(), 'Preview 5 — app icon from the study');
    // the same tile and colours with the mark at ~80 % of the square instead of ~60 %
    add(multi((N) => tileBitmap(N, [0x1B, 0x1D, 0x22], WHITE, 0.82, 3 / 16)), 'Preview 6 — app icon, bigger mark');
  } catch (err) {
    console.error('app icon preview failed:', err.message);
  }
  nativeTheme.on('updated', () => { trays[0].setImage(ligatureIcon()); });
});
app.on('window-all-closed', (e) => e.preventDefault());
