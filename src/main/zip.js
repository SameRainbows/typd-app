'use strict';

/**
 * A small ZIP reader and writer for Typd's CUDA pack (cudaPack.js reads it, scripts/cuda-pack.js
 * writes it), with no dependency: Node's own zlib has every codec it needs.
 *
 *   methods   0 stored, 8 deflate, 93 Zstandard (APPNOTE.TXT 6.3.8, "version needed" 6.3). The pack's
 *             DLLs are Zstandard: on llama.cpp's CUDA build it makes 1.14 GB into about a third of what
 *             deflate leaves (the measurements are in scripts/cuda-pack.js). Node has had zstd in zlib
 *             since 22.15 / 23.8; Electron 44 ships Node 24.
 *   limits    no ZIP64 (every entry and the whole archive stay under 4 GiB), no encryption, no
 *             multi-disk archives, file names only (no folders, no "..", nothing absolute). Sizes and
 *             CRCs are read from the central directory, so data descriptors are never needed.
 *
 * Extraction streams: an entry is never held in memory whole, its CRC-32 and size are checked
 * against the central directory, and its sha256 is computed on the way (the caller compares it with
 * what it expects). A Zstandard frame may ask for at most a 2^WINDOW_LOG_MAX-byte window (128 MiB),
 * so a hostile archive cannot make the decoder take more memory than that.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
const STORED = 0, DEFLATE = 8, ZSTD = 93;
const WINDOW_LOG_MAX = 27;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;   // 1980-01-01 00:00: every build of the same files is the same archive

function crc32(buf, value = 0) {
  if (typeof zlib.crc32 !== 'function') throw new Error('this Node has no zlib.crc32 (needs 22.2 or newer)');
  return zlib.crc32(buf, value) >>> 0;
}

/* ------------------------------------------------------------------- reading */

/** The central directory of `file`: [{name, method, crc, compressed, size, offset}]. Throws on anything unexpected. */
async function list(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('not a zip archive (too short)');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let at = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
    if (at < 0) throw new Error('not a zip archive (no end of central directory)');
    const disk = tail.readUInt16LE(at + 4), cdDisk = tail.readUInt16LE(at + 6);
    const count = tail.readUInt16LE(at + 10), cdSize = tail.readUInt32LE(at + 12), cdOffset = tail.readUInt32LE(at + 16);
    if (disk !== 0 || cdDisk !== 0 || tail.readUInt16LE(at + 8) !== count) throw new Error('multi-disk zip archives are not supported');
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    if (cdOffset + cdSize > size - (tailLen - at)) throw new Error('the central directory runs past the end of the archive');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN) throw new Error('a damaged central directory');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16), compressed = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + n).toString('utf8');
      p += 46 + n + x + c;
      if (flags & 1) throw new Error(name + ': encrypted entries are not supported');
      if (![STORED, DEFLATE, ZSTD].includes(method)) throw new Error(name + ': compression method ' + method + ' is not supported');
      if (!NAME_RE.test(name)) throw new Error('an entry name that is not a plain file name: ' + JSON.stringify(name.slice(0, 80)));
      if (out.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new Error(name + ' is in the archive twice');
      if (offset + 30 + compressed > cdOffset) throw new Error(name + ' runs into the central directory');
      out.push({ name, method, crc, compressed, size: usize, offset });
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Counts bytes and feeds CRC-32 and sha256 while they pass. */
function meter() {
  const sha = crypto.createHash('sha256');
  const t = new Transform({
    transform(chunk, _enc, cb) {
      t.bytes += chunk.length;
      if (t.bytes > t.limit) return cb(new Error('more bytes than the archive says'));
      t.crc = crc32(chunk, t.crc);
      sha.update(chunk);
      cb(null, chunk);
    }
  });
  t.bytes = 0;
  t.crc = 0;
  t.limit = Infinity;
  t.digest = () => sha.digest('hex');
  return t;
}

function decoder(method) {
  if (method === DEFLATE) return zlib.createInflateRaw();
  if (method === ZSTD) {
    if (typeof zlib.createZstdDecompress !== 'function') throw new Error('this Node has no Zstandard (needs 22.15 / 23.8 or newer)');
    return zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: WINDOW_LOG_MAX } });
  }
  return null;
}

/**
 * Extract `entry` (one of list()'s) of `file` to `dest`. Resolves {name, size, sha256}; rejects on a
 * wrong size or CRC (and removes what it wrote).
 */
async function extractEntry(file, entry, dest) {
  const fh = await fsp.open(file, 'r');
  let start;
  try {
    const loc = Buffer.alloc(30);
    await fh.read(loc, 0, 30, entry.offset);
    if (loc.readUInt32LE(0) !== LOC) throw new Error(entry.name + ': no local header where the directory says');
    start = entry.offset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  const m = meter();
  m.limit = entry.size;
  const stages = [fs.createReadStream(file, { start, end: start + entry.compressed - 1, highWaterMark: 1 << 20 })];
  const dec = decoder(entry.method);
  if (dec) stages.push(dec);
  stages.push(m, fs.createWriteStream(dest));
  try {
    if (entry.compressed === 0) {
      // An empty entry: nothing to read (a stream with end < start would read the whole file).
      await fsp.writeFile(dest, '');
    } else {
      await pipeline(...stages);
    }
    if (m.bytes !== entry.size) throw new Error(`${entry.name}: ${m.bytes} bytes, the archive says ${entry.size}`);
    if ((m.crc >>> 0) !== (entry.crc >>> 0)) throw new Error(entry.name + ': CRC-32 does not match');
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
  return { name: entry.name, size: m.bytes, sha256: entry.size === 0 ? crypto.createHash('sha256').digest('hex') : m.digest() };
}

/**
 * Extract every entry of `file` whose name `want(name)` accepts into the folder `dir` (made if
 * needed). Resolves [{name, size, sha256}]. An entry `want` refuses is skipped.
 */
async function extract(file, dir, want = () => true) {
  const entries = await list(file);
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const e of entries) {
    if (!want(e.name)) continue;
    out.push(await extractEntry(file, e, path.join(dir, e.name)));
  }
  return out;
}

/* ------------------------------------------------------------------- writing */

/**
 * Write a zip of `entries` [{name, file | data, method: 0 | 8 | 93, level, params}] to `out`. Each entry
 * is compressed in memory (the CUDA pack's largest file is 568 MB: fine for a build machine). Resolves
 * [{name, size, compressed, crc, method}].
 */
async function write(out, entries) {
  const fh = await fsp.open(out, 'w');
  const cen = [];
  const report = [];
  let offset = 0;
  try {
    for (const e of entries) {
      if (!NAME_RE.test(e.name)) throw new Error('not a plain file name: ' + e.name);
      const data = e.data !== undefined ? Buffer.from(e.data) : await fsp.readFile(e.file);
      const method = e.method === undefined ? ZSTD : e.method;
      let body;
      if (method === STORED) body = data;
      else if (method === DEFLATE) body = zlib.deflateRawSync(data, { level: e.level || 9, memLevel: 9 });
      else if (method === ZSTD) {
        const C = zlib.constants;
        body = zlib.zstdCompressSync(data, { params: { [C.ZSTD_c_compressionLevel]: e.level || 19, [C.ZSTD_c_checksumFlag]: 1, [C.ZSTD_c_contentSizeFlag]: 1, ...(e.params || {}) } });
      } else throw new Error('method ' + method + ' is not supported');
      if (data.length >= 0xffffffff || body.length >= 0xffffffff || offset + body.length >= 0xffffffff) throw new Error('too large for a zip without ZIP64');
      const crc = crc32(data);
      const name = Buffer.from(e.name, 'utf8');
      const needed = method === ZSTD ? 63 : 20;
      const loc = Buffer.alloc(30);
      loc.writeUInt32LE(LOC, 0); loc.writeUInt16LE(needed, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(method, 8);
      loc.writeUInt16LE(DOS_TIME, 10); loc.writeUInt16LE(DOS_DATE, 12); loc.writeUInt32LE(crc, 14);
      loc.writeUInt32LE(body.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(name.length, 26); loc.writeUInt16LE(0, 28);
      await fh.write(loc); await fh.write(name); await fh.write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(CEN, 0); c.writeUInt16LE(needed, 4); c.writeUInt16LE(needed, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10);
      c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20);
      c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
      cen.push(c, name);
      report.push({ name: e.name, size: data.length, compressed: body.length, crc, method });
      offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(cen);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    await fh.write(cd); await fh.write(end);
  } finally {
    await fh.close();
  }
  return report;
}

module.exports = { list, extract, extractEntry, write, crc32, STORED, DEFLATE, ZSTD, WINDOW_LOG_MAX, NAME_RE };
