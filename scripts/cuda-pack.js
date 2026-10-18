#!/usr/bin/env node
'use strict';

/**
 * Make the CUDA pack: llama.cpp's CUDA backend for Windows, which public installers leave out since
 * 0.2.5 and download after the model on a PC whose NVIDIA GPU takes the GPU path (src/main/cudaPack.js,
 * src/main/modelUpdate.js). dictation-research/scripts/publish_model.py --pack publishes it.
 *
 *   node scripts/cuda-pack.js [--llama vendor/llama] [--out dist/cuda-pack] [--level 22] [--window 27]
 *
 * Writes <out>/cuda-pack-b<build>-cu<cuda>.zip and, beside it, <zip>.json (the record publish_model.py
 * reads: pack id, version, file, size, sha256, the files inside with their size and sha256).
 *
 * The zip holds pack.json -- exactly the cuda.json scripts/before-pack.js puts in the app (the pack id,
 * llama.cpp's build and commit, the CUDA runtime, every file's name, size and sha256) plus how it was
 * compressed -- and the four files: ggml-cuda.dll, cublas64_12.dll, cublasLt64_12.dll, cudart64_12.dll
 * (1.14 GB). The app trusts none of it by itself: the zip's size and sha256 come from the signed
 * manifest, and every file it unpacks must match the app's own cuda.json.
 *
 * Compression: Zstandard (zip method 93), level 22 with long-distance matching and a 2^27-byte window,
 * per file. Measured on llama.cpp b11351's CUDA 12.4 files (1,141,895,680 B):
 *   deflate -9 (an ordinary zip)        652,383,336 B  57.1 %
 *   zstd 19                             362,954,288 B  31.8 %
 *   zstd 19, long, window 2^27          340,407,192 B  29.8 %
 *   zstd 22, long, window 2^27          337,133,318 B  29.5 %   <- this
 *   xz -9e (reference; no decoder in Node)  322,548,224 B  28.2 %
 * Node has zstd in zlib (Electron 44's Node 24.21), so the app needs nothing else, and a window of 2^27
 * keeps the decoder at 128 MiB. Decoding takes ~3 s for all four files. Compressing takes ~10 minutes.
 * The archive is reproducible: the same files and settings give the same bytes (fixed times, fixed order).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const info = require('./llama-info');
const zip = require('../src/main/zip');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };

function die(msg) { console.error('cuda-pack: ' + msg); process.exit(1); }

function git(...a) {
  try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

async function main() {
  const llama = path.resolve(opt('--llama', path.join(ROOT, 'vendor', 'llama')));
  const out = path.resolve(opt('--out', path.join(ROOT, 'dist', 'cuda-pack')));
  const level = Number(opt('--level', 22));
  const windowLog = Number(opt('--window', 27));
  if (!(level >= 1 && level <= 22)) die('--level is 1-22');
  if (!(windowLog >= 20 && windowLog <= zip.WINDOW_LOG_MAX)) die(`--window is 20-${zip.WINDOW_LOG_MAX} (the app's decoder takes at most 2^${zip.WINDOW_LOG_MAX})`);

  console.log(`cuda-pack: reading ${llama}`);
  const d = info.describe(llama);
  const desc = info.cudaJson(d);
  if (!desc) die(`${llama} has no CUDA backend (ggml-cuda.dll and its libraries)`);
  const version = desc.pack;   // the manifest's packs.<id>.version; a re-roll of the same files would add a suffix
  const file = `cuda-pack-${desc.pack.replace(/^cuda-/, '')}.zip`;
  fs.mkdirSync(out, { recursive: true });
  const zipPath = path.join(out, file);
  const compression = { method: 'zstd', level, windowLog, longDistanceMatching: true };
  const packJson = JSON.stringify({ ...desc, version, compression }, null, 1) + '\n';

  const C = zlib.constants;
  const params = { [C.ZSTD_c_windowLog]: windowLog, [C.ZSTD_c_enableLongDistanceMatching]: 1 };
  const entries = [
    { name: 'pack.json', data: packJson, method: zip.DEFLATE },
    ...desc.files.map((f) => ({ name: f.name, file: path.join(llama, f.name), method: zip.ZSTD, level, params }))
  ];
  console.log(`cuda-pack: ${desc.pack}: ${desc.files.length} files, ${(desc.files.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(0)} MB, zstd ${level}, window 2^${windowLog}, long matching (several minutes)`);
  const t0 = Date.now();
  const tmp = zipPath + '.tmp';
  const report = await zip.write(tmp, entries);
  fs.renameSync(tmp, zipPath);
  for (const r of report) console.log(`  ${r.name.padEnd(20)} ${String(r.size).padStart(11)} -> ${String(r.compressed).padStart(11)}  ${(100 * r.compressed / Math.max(1, r.size)).toFixed(1)} %`);

  // Read it back the way the app does: every file's size and sha256 must be cuda.json's.
  const check = path.join(out, '.check-' + process.pid);
  fs.rmSync(check, { recursive: true, force: true });
  const back = await zip.extract(zipPath, check);
  for (const f of desc.files) {
    const g = back.find((x) => x.name === f.name);
    if (!g || g.size !== f.size || g.sha256 !== f.sha256) die(`${f.name} does not read back as it went in`);
  }
  fs.rmSync(check, { recursive: true, force: true });

  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(zipPath, { highWaterMark: 1 << 20 })) h.update(chunk);
  const size = fs.statSync(zipPath).size;
  const record = {
    schema: 'typd-cuda-pack/1', pack: desc.pack, version, file, size, sha256: h.digest('hex'),
    llama: desc.llama, cuda: desc.cuda, files: desc.files, unpacked: desc.files.reduce((s, f) => s + f.size, 0), compression,
    commit: git('rev-parse', 'HEAD'), built_at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000)
  };
  fs.writeFileSync(zipPath + '.json', JSON.stringify(record, null, 2) + '\n');
  console.log(`cuda-pack: ${file}: ${size.toLocaleString('en-US')} B (${(size / 1e6).toFixed(1)} MB, ${(100 * size / record.unpacked).toFixed(1)} % of ${(record.unpacked / 1e6).toFixed(0)} MB), sha256 ${record.sha256}`);
  console.log(`cuda-pack: read back OK; record ${zipPath}.json`);
}

main().catch((err) => die((err && err.stack) || err));
