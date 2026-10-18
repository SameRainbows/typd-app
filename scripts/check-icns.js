'use strict';

/**
 * Check a macOS .icns: every size Finder, the Dock and Spotlight draw is there, at its size.
 *
 *   node scripts/check-icns.js <file.icns> [...]     exit 1 on any fault, with the reasons
 *
 * Required, as Apple's iconutil writes them from a full .iconset (16, 32, 128, 256 and 512 points,
 * each at 1x and 2x): ic04 16 px and ic05 32 px (ARGB), ic11 32 px (16@2x), ic12 64 px (32@2x),
 * ic07 128 px, ic13 256 px (128@2x), ic08 256 px, ic14 512 px (256@2x), ic09 512 px, ic10 1024 px
 * (512@2x), the larger ones PNG. Any PNG whose pixel size is not its slot's is a fault: 0.2.6's file
 * (made by electron-builder) had a 512 px image in ic13 and a 1024 px one in ic14. Runs anywhere
 * (bench/mac-icon.js uses it on Windows); the Mac CI also reads the icon back with iconutil.
 */

const fs = require('fs');

// slot -> [pixels, what it is]
const SLOTS = {
  ic04: [16, '16x16'], ic05: [32, '32x32'],
  ic11: [32, '16x16@2x'], ic12: [64, '32x32@2x'],
  ic07: [128, '128x128'], ic13: [256, '128x128@2x'],
  ic08: [256, '256x256'], ic14: [512, '256x256@2x'],
  ic09: [512, '512x512'], ic10: [1024, '512x512@2x']
};
// Older slots that may also appear; when one holds a PNG, it must be its size too.
const OTHER = { icp4: 16, icp5: 32, icp6: 64, is32: 16, il32: 32, ih32: 48, it32: 128 };

/** The entries of an .icns buffer: [{type, data}]. */
function entries(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns') throw new Error('not an .icns file');
  const out = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const type = buf.toString('latin1', o, o + 4);
    const len = buf.readUInt32BE(o + 4);
    if (len < 8 || o + len > buf.length) throw new Error(`entry ${type} at ${o} runs past the end`);
    out.push({ type, data: buf.subarray(o + 8, o + len) });
    o += len;
  }
  return out;
}

function pngSize(d) {
  if (d.length < 24 || d.readUInt32BE(0) !== 0x89504e47) return null;
  return [d.readUInt32BE(16), d.readUInt32BE(20)];
}

/** Faults in one .icns buffer ([] when it is right), and what it holds. */
function check(buf) {
  const faults = [];
  const have = {};
  let list;
  try { list = entries(buf); } catch (err) { return { faults: [err.message], have }; }
  for (const { type, data } of list) {
    const png = pngSize(data);
    const kind = png ? `png ${png[0]}x${png[1]}` : data.toString('latin1', 0, 4) === 'ARGB' ? 'argb' : `${data.length} B`;
    have[type] = kind;
    const want = SLOTS[type] ? SLOTS[type][0] : OTHER[type];
    if (png && want && (png[0] !== want || png[1] !== want)) faults.push(`${type} (${SLOTS[type] ? SLOTS[type][1] : want + ' px'}) holds a ${png[0]}x${png[1]} image, not ${want}x${want}`);
  }
  for (const [type, [px, what]] of Object.entries(SLOTS)) {
    if (!have[type]) { faults.push(`no ${type} (${what}, ${px} px)`); continue; }
    if ((type === 'ic04' || type === 'ic05') && have[type] !== 'argb' && !have[type].startsWith('png')) faults.push(`${type} is neither ARGB nor PNG`);
    if (type !== 'ic04' && type !== 'ic05' && !have[type].startsWith('png')) faults.push(`${type} (${what}) is not a PNG`);
  }
  return { faults, have };
}

module.exports = { check, entries, SLOTS };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node scripts/check-icns.js <file.icns> [...]'); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    const { faults, have } = check(fs.readFileSync(f));
    console.log(`${f}: ${Object.entries(have).map(([t, k]) => `${t} ${k}`).join(', ')}`);
    if (faults.length) { bad++; for (const x of faults) console.log(`  FAULT ${x}`); } else console.log('  every size present, each at its size');
  }
  process.exit(bad ? 1 : 0);
}
