'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The mark: the one place that knows what it looks like.
 *
 * The identity is 03 Ligature (design/identity-study-02.html; every candidate stays in
 * assets/brand/<name>/). The old pill with its dot is the fallback. To try another
 * candidate without editing anything: TYPD_MARK=selection npm start. Nothing else in the app draws the mark:
 * the tray asks trayImage(), the window asks windowMark().
 *
 * A candidate folder holds mark.svg (the master, currentColor on a 16-unit grid) and
 * px/mark-<size>.svg, hinted for each pixel size. The tray uses the hinted file for
 * its size when there is one. Pixel art cannot be read from an SVG in the main
 * process, so prepare() draws each one once in a hidden page (Path2D on a canvas)
 * and keeps the alpha; until that finishes, or if it fails, the pill is drawn.
 */
// Chosen 2026-10-09: 03 Ligature, the p and d of "typd" sharing one bowl (identity study
// 02). TYPD_MARK=<folder> still tries another candidate; TYPD_MARK=pill draws the old pill.
const CHOSEN = process.env.TYPD_MARK === 'pill' ? null : (process.env.TYPD_MARK || 'ligature');

const BRAND_DIR = path.join(__dirname, '..', '..', 'assets', 'brand');
const RED = [0x3B, 0x48, 0xE5];      // #E5483B, the dot in the app icon (BGR)
const INK_DARK = [0xF7, 0xF5, 0xF4]; // #F4F5F7 on a dark taskbar (BGR)
const INK_LIGHT = [0x1B, 0x16, 0x14];// #14161B on a light one (BGR)
const DIM = 0.45;

/* ------------------------------------------------------------------ the pill */

// Windows: on a 16-unit grid, so every straight edge lands on a whole pixel at 16 px -- a
// capsule 14 wide and 8 tall, and the dot inside its right end. macOS: the 18-point menu-bar
// box mac/tray-icon.js was tuned in.
const GRIDS = {
  win: { size: 16, pill: { x0: 1, x1: 15, cy: 8, r: 4 }, dot: { cx: 11, cy: 8, r: 2 } },
  mac: { size: 18, pill: { x0: 1, x1: 17, cy: 9, r: 4 }, dot: { cx: 13, cy: 9, r: 2.2 } }
};

function pillCover(g, x, y) {
  const cx = Math.max(g.pill.x0 + g.pill.r, Math.min(g.pill.x1 - g.pill.r, x));
  const inPill = (x - cx) ** 2 + (y - g.pill.cy) ** 2 <= g.pill.r ** 2;
  const inDot = (x - g.dot.cx) ** 2 + (y - g.dot.cy) ** 2 <= g.dot.r ** 2;
  return { ink: inPill && !inDot, dot: inDot };
}

/** Alpha masks for ink and dot at `px`, from 4x4 supersampling of the pill. */
function pillMasks(px, g = process.platform === 'darwin' ? GRIDS.mac : GRIDS.win) {
  const S = 4;
  const ink = new Uint8Array(px * px);
  const dot = new Uint8Array(px * px);
  const unit = g.size / px;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let a = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = pillCover(g, (x + (sx + 0.5) / S) * unit, (y + (sy + 0.5) / S) * unit);
          if (c.ink) a++;
          if (c.dot) b++;
        }
      }
      ink[y * px + x] = Math.round((255 * a) / (S * S));
      dot[y * px + x] = Math.round((255 * b) / (S * S));
    }
  }
  return { ink, dot };
}

/* --------------------------------------------------------- a chosen mark */

function readPath(file) {
  try {
    const svg = fs.readFileSync(file, 'utf8');
    const d = (svg.match(/\sd="([^"]+)"/) || [])[1];
    if (!d || !/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(d)) return null;   // path data, nothing else
    const rule = /fill-rule="evenodd"/.test(svg) ? 'evenodd' : 'nonzero';
    const box = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 16 16';
    return { d, rule, viewBox: box };
  } catch {
    return null;
  }
}

function chosenPath(px) {
  if (!CHOSEN || !/^[a-z0-9-]+$/i.test(CHOSEN)) return null;
  const dir = path.join(BRAND_DIR, CHOSEN);
  return (px && readPath(path.join(dir, 'px', 'mark-' + px + '.svg'))) || readPath(path.join(dir, 'mark.svg'));
}

const masks = new Map();   // px -> Uint8Array of alpha, for a chosen mark
let preparing = null;

/**
 * Draw the chosen mark's sizes once, in a hidden page, and keep their alpha. Resolves
 * true when the tray can use them; false (and the pill stays) otherwise.
 */
function prepare(sizes) {
  if (!CHOSEN) return Promise.resolve(false);
  if (preparing) return preparing;
  preparing = (async () => {
    const { BrowserWindow } = require('electron');
    const jobs = sizes.map((px) => ({ px, p: chosenPath(px) })).filter((j) => j.p);
    if (!jobs.length) return false;
    const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await win.loadURL('data:text/html,<canvas></canvas>');
      const code = `(${function draw(list) {
        return list.map(({ px, d, rule, viewBox }) => {
          const [, , w, h] = viewBox.split(/[\s,]+/).map(Number);
          const c = document.createElement('canvas');
          c.width = px; c.height = px;
          const g = c.getContext('2d');
          g.scale(px / (w || 16), px / (h || 16));
          g.fill(new Path2D(d), rule);
          const rgba = g.getImageData(0, 0, px, px).data;
          const a = [];
          for (let i = 3; i < rgba.length; i += 4) a.push(rgba[i]);
          return a;
        });
      }})(${JSON.stringify(jobs.map((j) => ({ px: j.px, ...j.p })))})`;
      const out = await win.webContents.executeJavaScript(code);
      jobs.forEach((j, i) => { if (Array.isArray(out[i]) && out[i].length === j.px * j.px) masks.set(j.px, Uint8Array.from(out[i])); });
      return masks.size > 0;
    } catch (err) {
      console.log('[typd:brand] could not draw the mark:', err && err.message);
      return false;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  })();
  return preparing;
}

/* -------------------------------------------------------------------- tray */

/**
 * BGRA for one size and state. ready: the mark in ink; dim: the same, faded (loading or
 * a problem); live: the dot in red -- the pill's own dot, or for a chosen mark a small
 * red badge in its corner. On a Mac (template), black and alpha only: macOS tints it,
 * and live fills the dot instead of colouring it.
 */
function bitmap(px, state, { dark, template }) {
  const buf = Buffer.alloc(px * px * 4);
  const ink = template ? [0, 0, 0] : dark ? INK_DARK : INK_LIGHT;
  const fade = state === 'dim' ? DIM : 1;
  const own = masks.get(px);
  let inkMask, dotMask;
  if (own) {
    inkMask = own;
    dotMask = new Uint8Array(px * px);
    if (state === 'live') {
      // A badge in the bottom-right corner, a quarter of the size, with a clear ring.
      const r = px / 5, cx = px - r - 0.5, cy = px - r - 0.5;
      for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
          const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (dd <= r) dotMask[y * px + x] = 255;
          else if (dd <= r + px / 16) inkMask = clearAt(inkMask, px, x, y);
        }
      }
    }
  } else {
    const m = pillMasks(px);
    inkMask = m.ink;
    dotMask = state === 'live' ? m.dot : new Uint8Array(px * px);
  }
  for (let i = 0; i < px * px; i++) {
    const a = inkMask[i] / 255 * fade;
    const b = dotMask[i] / 255;
    const dotColour = template ? [0, 0, 0] : RED;
    const alpha = Math.max(a, b);
    if (!alpha) continue;
    const mix = b > 0 ? dotColour : ink;
    // nativeImage bitmaps are premultiplied BGRA: colour already scaled by alpha. Writing
    // full-strength colour with partial alpha made the dimmed state (and every soft edge)
    // render at almost full brightness.
    buf[i * 4] = Math.round(mix[0] * alpha); buf[i * 4 + 1] = Math.round(mix[1] * alpha); buf[i * 4 + 2] = Math.round(mix[2] * alpha);
    buf[i * 4 + 3] = Math.round(alpha * 255);
  }
  return buf;
}

function clearAt(mask, px, x, y) {
  const copy = mask === masks.get(px) ? Uint8Array.from(mask) : mask;
  copy[y * px + x] = 0;
  return copy;
}

/**
 * The tray or menu-bar icon for a state: 'ready' | 'dim' | 'live'. Windows gets 16, 20,
 * 24 and 32 px so it is sharp at 100-200% scaling, in the taskbar's own ink; macOS gets
 * an 18-point template at 1x and 2x.
 */
function trayImage(state, { dark = true } = {}) {
  const { nativeImage } = require('electron');
  const mac = process.platform === 'darwin';
  const sizes = mac ? [[18, 1], [36, 2]] : [[16, 1], [20, 1.25], [24, 1.5], [32, 2]];
  const opts = { dark, template: mac };
  const [first, ...rest] = sizes;
  let img;
  try {
    img = nativeImage.createFromBitmap(bitmap(first[0], state, opts), { width: first[0], height: first[0], scaleFactor: first[1] });
    for (const [px, scaleFactor] of rest) {
      img.addRepresentation({ scaleFactor, width: px, height: px, buffer: bitmap(px, state, opts) });
    }
  } catch (err) {
    console.log('[typd:brand] tray icon:', err && err.message);
    if (!img) return nativeImage.createEmpty();
  }
  if (mac) img.setTemplateImage(true);
  return img;
}

/* ------------------------------------------------------------------ window */

/**
 * The mark for the window's sidebar, as path data the page builds an <svg> from (no
 * markup crosses over): { viewBox, paths: [{ d, rule, role: 'ink' | 'dot' }] }.
 */
function windowMark() {
  const p = chosenPath(null);
  if (p) return { viewBox: p.viewBox, paths: [{ d: p.d, rule: p.rule, role: 'ink' }] };
  return {
    viewBox: '0 0 16 16',
    paths: [
      { d: 'M5,4H11A4,4 0 0 1 11,12H5A4,4 0 0 1 5,4ZM11,6A2,2 0 1 0 11,10A2,2 0 1 0 11,6Z', rule: 'evenodd', role: 'ink' },
      { d: 'M11,6A2,2 0 1 0 11,10A2,2 0 1 0 11,6Z', rule: 'nonzero', role: 'dot' }
    ]
  };
}

/** The app icon the window uses in the taskbar. */
function windowIcon() {
  return path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'typd.ico' : 'typd.png');
}

module.exports = { CHOSEN, prepare, trayImage, windowMark, windowIcon, bitmap, pillMasks, GRIDS };
