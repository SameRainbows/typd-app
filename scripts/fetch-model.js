#!/usr/bin/env node
'use strict';

/**
 * Download the current Typd dictation model into models/typd-dictate/, for running and
 * building Typd from source.
 *
 *   node scripts/fetch-model.js --accept-license [--dir models/typd-dictate]
 *   node scripts/fetch-model.js --check      only read and verify the manifest; download nothing
 *
 * The model is not part of this repository and is not under the GPL: it is licensed separately,
 * under MODEL_LICENSE.txt (read it first). This script fetches the same files a packaged Typd
 * downloads for its model updates, from the same public routes (src/main/modelUpdate.js):
 *
 *   GET /v1/model/public/manifest                    the live version, its files and model.json
 *   GET /v1/model/public/file/<version>/<file>       each file (Range resume)
 *
 * The manifest is trusted only if its Ed25519 signature verifies with a key in
 * src/main/modelManifestKey.js, checked by the app's own code (modelUpdate.checkSignature). Every
 * file is then checked against the manifest's size and sha256 before it is kept; a file already
 * there with the right sha256 is not downloaded again. model.json is written from the manifest.
 * No install id or version headers are sent. Needs Node 18 or newer (global fetch).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const modelUpdate = require(path.join(ROOT, 'src', 'main', 'modelUpdate'));
const { keys } = require(path.join(ROOT, 'src', 'main', 'modelManifestKey'));
const ENDPOINT = process.env.TYPD_MODEL_ENDPOINT || modelUpdate.ENDPOINT;
// Tests only (a local mock server has no signing key).
const ALLOW_UNSIGNED = process.env.TYPD_MODEL_ALLOW_UNSIGNED === '1';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function mb(n) { return (n / 1048576).toFixed(0) + ' MB'; }

async function download(url, file, size) {
  const part = file + '.partial';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > size) fs.rmSync(part);
    if (have === size) return part;
    const headers = have > 0 && have < size ? { Range: `bytes=${have}-` } : {};
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after')) || 60;
        throw new Error(`the server is busy (429); try again in ${Math.ceil(wait / 60)} min`);
      }
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const append = res.status === 206;
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      let got = append ? have : 0;
      let shown = -1;
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        const pct = Math.floor((got / size) * 100);
        if (pct !== shown && process.stdout.isTTY) { shown = pct; process.stdout.write(`\r  ${path.basename(file)}  ${pct} %   `); }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      if (process.stdout.isTTY) process.stdout.write('\n');
      if (fs.statSync(part).size === size) return part;
      throw new Error('incomplete download');
    } catch (e) {
      if (/429/.test(e.message) || attempt === 5) throw e;
      console.log(`  ${path.basename(file)}: ${e.message}; retrying (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('download failed');
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  if (!checkOnly && !process.argv.includes('--accept-license')) {
    console.log([
      'The Typd dictation model is not open source and not covered by this repository\'s GPL licence.',
      'It is licensed under MODEL_LICENSE.txt: read it, then run this again with --accept-license.',
      `  ${path.join(ROOT, 'MODEL_LICENSE.txt')}`
    ].join('\n'));
    process.exit(1);
  }
  if (typeof fetch !== 'function') throw new Error('Node 18 or newer is needed (global fetch)');
  const dir = path.resolve(arg('--dir') || path.join(ROOT, 'models', 'typd-dictate'));

  if (typeof modelUpdate.checkSignature !== 'function' || typeof modelUpdate.checkManifest !== 'function') {
    throw new Error('src/main/modelUpdate.js no longer exports checkSignature/checkManifest; update this script');
  }
  const res = await fetch(`${ENDPOINT}/v1/model/public/manifest`);
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const text = await res.text();
  const why = modelUpdate.checkSignature(text, res.headers.get('x-typd-manifest-key'), res.headers.get('x-typd-manifest-sig'), keys);
  if (why && !ALLOW_UNSIGNED) throw new Error(`manifest refused: ${why}`);
  let m;
  try { m = JSON.parse(text); } catch { m = null; }
  const bad = m ? modelUpdate.checkManifest(m) : 'not JSON';
  if (bad || !m.model_json) throw new Error(`manifest refused: ${bad || 'no model_json'}`);
  console.log(why ? `Manifest NOT signed (${why}); allowed by TYPD_MODEL_ALLOW_UNSIGNED=1` : `Manifest signed by ${res.headers.get('x-typd-manifest-key')}: verified`);
  const total = m.files.reduce((s, f) => s + f.size, 0);
  console.log(`Model ${m.version}: ${m.files.length} files, ${mb(total)}${checkOnly ? '' : `, into ${dir}`}`);
  if (checkOnly) {
    for (const f of m.files) console.log(`  ${f.name}  ${mb(f.size)}`);
    return;
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const f of m.files) {
    if (!/^[A-Za-z0-9._-]+$/.test(f.name)) throw new Error(`manifest: bad file name ${JSON.stringify(f.name)}`);
    const file = path.join(dir, f.name);
    if (fs.existsSync(file) && fs.statSync(file).size === f.size && (await sha256File(file)) === f.sha256) {
      console.log(`  ${f.name}: already here`);
      continue;
    }
    const url = `${ENDPOINT}/v1/model/public/file/${encodeURIComponent(m.version)}/${encodeURIComponent(f.name)}`;
    const part = await download(url, file, f.size);
    const sum = await sha256File(part);
    if (sum !== f.sha256) { fs.rmSync(part); throw new Error(`${f.name}: sha256 does not match the manifest; deleted`); }
    fs.renameSync(part, file);
    console.log(`  ${f.name}: ${mb(f.size)}, sha256 checked`);
  }
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(m.model_json, null, 2) + '\n');
  console.log(`model.json written. ${m.version} is ready for npm start (and for packaging).`);
}

main().catch((e) => { console.error('fetch-model: ' + e.message); process.exit(1); });
