'use strict';

const { nativeImage } = require('electron');

/**
 * The menu-bar mark on macOS: the pill from the app icon, with its red dot
 * punched out of it, as a template image -- black and alpha only -- so macOS
 * tints it for light and dark menu bars and for the highlighted state itself.
 * Red would be the one colour in the menu bar, and that is not this icon's job.
 *
 * Drawn rather than shipped, like the Windows tray circle: there is no asset to
 * forget, and it is sharp at 1x and 2x because each is drawn at its own size.
 */

const PT = 18;   // the menu bar's icon box, in points

// In points: a capsule 16 wide and 8 tall, centred; the dot inside its right end.
const PILL = { x0: 1, x1: 17, cy: 9, r: 4 };
const DOT = { cx: 13, cy: 9, r: 2.2 };

function inside(x, y) {
  const cx = Math.max(PILL.x0 + PILL.r, Math.min(PILL.x1 - PILL.r, x));
  const inPill = (x - cx) ** 2 + (y - PILL.cy) ** 2 <= PILL.r ** 2;
  const inDot = (x - DOT.cx) ** 2 + (y - DOT.cy) ** 2 <= DOT.r ** 2;
  return inPill && !inDot;
}

/** BGRA, black, with alpha from 4x4 supersampling -- the antialiasing. */
function render(px) {
  const S = 4;
  const scale = px / PT;
  const buf = Buffer.alloc(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (inside((x + (sx + 0.5) / S) / scale, (y + (sy + 0.5) / S) / scale)) hit++;
        }
      }
      buf[(y * px + x) * 4 + 3] = Math.round((255 * hit) / (S * S));
    }
  }
  return buf;
}

function image() {
  let img;
  try {
    img = nativeImage.createFromBitmap(render(PT), { width: PT, height: PT, scaleFactor: 1 });
  } catch (err) {
    console.log('[typd:mac] tray icon:', err && err.message);
    return nativeImage.createEmpty();
  }
  try {
    img.addRepresentation({ scaleFactor: 2, width: PT * 2, height: PT * 2, buffer: render(PT * 2) });
  } catch (err) {
    // 1x only: blurrier on a Retina screen, still there.
    if (process.env.TYPD_DEBUG) console.log('[typd:mac] tray icon 2x:', err && err.message);
  }
  img.setTemplateImage(true);
  return img;
}

module.exports = { image, render, PT };
