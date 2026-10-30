'use strict';

/**
 * A real asar archive, written by hand for the benches: the layout electron-builder writes (a size
 * pickle, the header pickle, then the packed files), with every `unpacked` entry put at the same
 * place under <archive>.unpacked/, as build.asarUnpack does. scripts/public-build.js readAsar reads it.
 *
 *   writeAsar(file, [{ path: 'src/main/inject.js', data: Buffer | string, unpacked: false }, ...])
 */

const fs = require('fs');
const path = require('path');

function writeAsar(file, entries) {
  const root = { files: {} };
  const blobs = [];
  let offset = 0;
  fs.rmSync(file + '.unpacked', { recursive: true, force: true });
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    const parts = e.path.split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) node = node.files[p] = node.files[p] || { files: {} };
    const name = parts[parts.length - 1];
    if (e.unpacked) {
      node.files[name] = { size: data.length, unpacked: true };
      const out = path.join(file + '.unpacked', ...parts);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
    } else {
      node.files[name] = { size: data.length, offset: String(offset) };
      blobs.push(data);
      offset += data.length;
    }
  }
  const header = Buffer.from(JSON.stringify(root));
  const padded = Math.ceil(header.length / 4) * 4;
  const hp = Buffer.alloc(8 + padded);
  hp.writeUInt32LE(4 + padded, 0);
  hp.writeInt32LE(header.length, 4);
  header.copy(hp, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(hp.length, 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([size, hp, ...blobs]));
}

/**
 * The part of a packaged Windows Typd that the paste helper's checks look at, in `resources`: app.asar with
 * this checkout's inject.js (and the modules it requires) packed and inject.ps1 unpacked, as a real build has them.
 * `extra` adds entries (a stray .node, say); `ps1Unpacked: false` packs inject.ps1 instead (asarUnpack dropped).
 */
function fakeAppAsar(resources, root, { extra = [], ps1Unpacked = true } = {}) {
  const read = (rel) => fs.readFileSync(path.join(root, rel));
  writeAsar(path.join(resources, 'app.asar'), [
    { path: 'package.json', data: read('package.json') },
    ...['inject.js', 'inject-mac.js', 'unpacked.js', 'lifelog.js'].map((f) => ({ path: 'src/main/' + f, data: read('src/main/' + f) })),
    { path: 'src/main/inject.ps1', data: read('src/main/inject.ps1'), unpacked: ps1Unpacked },
    ...extra
  ]);
}

module.exports = { writeAsar, fakeAppAsar };
