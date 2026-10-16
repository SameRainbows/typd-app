#!/usr/bin/env node
'use strict';

/**
 * Fetch llama.cpp's official macOS builds of llama-server into vendor/llama-mac/<arch>/.
 *
 *   node scripts/fetch-llama-mac.js              both arm64 and x64
 *   node scripts/fetch-llama-mac.js arm64        one architecture
 *   node scripts/fetch-llama-mac.js --force      re-download even if already in place
 *
 * The build is pinned to the one Windows runs (vendor/llama: b11351, commit 631109b34),
 * so dictation behaves identically on both: same server, same mtmd audio path for
 * Qwen3-ASR, same flags. The archives' SHA-256 are pinned below too, so a re-run gives
 * byte-identical files or fails. TYPD_LLAMA_BUILD=bNNNN tries another release; its
 * digest is then taken from the GitHub release API.
 *
 * Only what llama-server actually loads is kept. The script reads the Mach-O load
 * commands of llama-server and follows every @rpath/@loader_path dependency through the
 * archive, so the folder is exactly the closure: llama-server, libllama-server-impl,
 * libllama-common, libllama, libmtmd, libggml*, and llama.cpp's LICENSE. Any dependency
 * outside the archive other than /usr/lib or /System (a Homebrew path, say) fails the
 * fetch instead of failing on the user's Mac.
 *
 * How the files survive packaging -- written down because each step can silently break it:
 *
 *  - Symlinks: the archive ships libllama.0.dylib -> libllama.0.5.0.dylib and so on. They
 *    are NOT reproduced. Each library is written as a regular file under the name the
 *    binaries load it by (the install name in their load commands, e.g. libllama.0.dylib),
 *    and names nothing loads are dropped. So there is no symlink for git, zip,
 *    electron-builder's extraResources copy or codesign to mangle, and it works the same
 *    when this script runs on Windows, which cannot create symlinks without admin rights.
 *  - Executable bits: every Mach-O file is written 0755 (LICENSE 0644). On macOS that is
 *    the real mode and electron-builder's copy keeps it. On Windows there is no mode to
 *    keep, so scripts/after-pack.js re-applies 0755 to every Mach-O file in
 *    Typd.app/Contents/Resources/llama before signing; a .app built from files fetched on
 *    Windows still runs.
 *  - Signatures: upstream binaries are ad-hoc signed (arm64 code must be). The bytes are
 *    copied untouched, and after-pack.js re-signs them ad hoc together with the app.
 *
 * Node standard library only: https, zlib, crypto, and a small tar and Mach-O reader.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'llama-mac');
const CACHE = path.join(OUT, '.cache');

// Same release as vendor/llama/llama-server.exe (Windows, CUDA 12.4 build).
const PINNED_BUILD = 'b11351';
const PINNED = {
  commit: '631109b34da437a3c4a5ebd75091d677671392e3',
  arm64: { asset: 'llama-b11351-bin-macos-arm64.tar.gz', sha256: '6b5f2443b76b2bf55bce78fca3c72b26cca2044704554d072d00da0f41ad6377' },
  x64: { asset: 'llama-b11351-bin-macos-x64.tar.gz', sha256: 'cd4ee3a3e559e6b49fa5c918eee3f838ba0bb60d5d01c95339776182d3015eb5' }
};

const CPU = { arm64: 0x0100000c, x64: 0x01000007 };
const ENTRY = 'llama-server';
// The Qwen3-ASR audio encoder graph in mtmd ("qwen3a" projector). Its absence means the
// build cannot hear: the model would load and every dictation would be refused.
const QWEN3_ASR_MARKER = 'clip_graph_qwen3a';

// ---------------------------------------------------------------------------------------

function log(...a) { console.log('[fetch-llama-mac]', ...a); }

function fail(msg) {
  console.error('[fetch-llama-mac] ERROR:', msg);
  process.exit(1);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function get(url, { json = false, redirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'typd-fetch-llama-mac', Accept: json ? 'application/vnd.github+json' : '*/*' };
    if (json && process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects: ' + url));
        return resolve(get(new URL(res.headers.location, url).toString(), { json, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try { resolve(json ? JSON.parse(buf.toString('utf8')) : buf); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function retry(fn, what, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      log(`${what} failed (${e.message}); retry ${i}/${tries - 1}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

/** Which archive to fetch for `arch`, and the digest it must have. */
async function plan(build, arch) {
  if (build === PINNED_BUILD) {
    const p = PINNED[arch];
    return {
      build, arch, commit: PINNED.commit, asset: p.asset, sha256: p.sha256,
      url: `https://github.com/ggml-org/llama.cpp/releases/download/${build}/${p.asset}`
    };
  }
  const rel = await retry(() => get(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${build}`, { json: true }), 'release lookup');
  const re = new RegExp(`^llama-${build}-bin-macos-${arch}\\.(tar\\.gz|zip)$`);
  const a = (rel.assets || []).find((x) => re.test(x.name));
  if (!a) fail(`release ${build} has no macOS ${arch} build`);
  if (!/\.tar\.gz$/.test(a.name)) fail(`release ${build} ships ${a.name}; only .tar.gz archives are handled`);
  const digest = (a.digest || '').replace(/^sha256:/, '');
  if (!digest) fail(`release ${build} publishes no digest for ${a.name}; pin one in this script`);
  return { build, arch, commit: rel.target_commitish, asset: a.name, sha256: digest, url: a.browser_download_url };
}

async function download(p) {
  fs.mkdirSync(CACHE, { recursive: true });
  const cached = path.join(CACHE, p.asset);
  if (fs.existsSync(cached)) {
    const buf = fs.readFileSync(cached);
    if (sha256(buf) === p.sha256) { log('cached', p.asset); return buf; }
    fs.rmSync(cached);
  }
  log('downloading', p.url);
  const buf = await retry(() => get(p.url), 'download');
  const got = sha256(buf);
  if (got !== p.sha256) fail(`${p.asset}: sha256 ${got}, expected ${p.sha256}`);
  fs.writeFileSync(cached, buf);
  log(`ok ${p.asset} ${(buf.length / 1048576).toFixed(1)} MB sha256 ${got.slice(0, 16)}...`);
  return buf;
}

// --- tar (ustar + pax + GNU long names) -------------------------------------------------

function untar(buf) {
  const entries = [];
  let off = 0;
  let pax = {};
  let longName = null;
  let longLink = null;
  const cstr = (b) => { const z = b.indexOf(0); return b.subarray(0, z < 0 ? b.length : z).toString('utf8'); };
  const octal = (b) => {
    if (b[0] & 0x80) { // base-256
      let n = 0;
      for (let i = 1; i < b.length; i++) n = n * 256 + b[i];
      return n;
    }
    const s = cstr(b).trim();
    return s ? parseInt(s, 8) : 0;
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    if (sum !== octal(h.subarray(148, 156))) throw new Error('tar header checksum mismatch at offset ' + off);
    let name = cstr(h.subarray(0, 100));
    const mode = octal(h.subarray(100, 108));
    let size = octal(h.subarray(124, 136));
    const flag = String.fromCharCode(h[156] || 0x30);
    let link = cstr(h.subarray(157, 257));
    if (cstr(h.subarray(257, 263)).startsWith('ustar')) {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = prefix + '/' + name;
    }
    if (pax.size !== undefined) size = Number(pax.size);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    if (flag === 'x') { pax = parsePax(data); continue; }
    if (flag === 'g') continue;
    if (flag === 'L') { longName = cstr(data); continue; }
    if (flag === 'K') { longLink = cstr(data); continue; }
    if (pax.path) name = pax.path;
    if (pax.linkpath) link = pax.linkpath;
    if (longName) name = longName;
    if (longLink) link = longLink;
    pax = {}; longName = null; longLink = null;

    const type = flag === '0' || flag === '7' ? 'file' : flag === '2' ? 'symlink' : flag === '1' ? 'hardlink' : flag === '5' ? 'dir' : 'other';
    entries.push({ name: name.replace(/^\.\//, ''), mode, type, link, data });
  }
  return entries;
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString('utf8'), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// --- Mach-O ----------------------------------------------------------------------------

const LC = {
  LOAD_DYLIB: 0x0c, ID_DYLIB: 0x0d, LOAD_WEAK_DYLIB: 0x80000018, RPATH: 0x8000001c,
  REEXPORT_DYLIB: 0x8000001f, LAZY_LOAD_DYLIB: 0x20, LOAD_UPWARD_DYLIB: 0x80000023, BUILD_VERSION: 0x32
};

function isMachO(buf) {
  if (buf.length < 4) return false;
  const le = buf.readUInt32LE(0), be = buf.readUInt32BE(0);
  return le === 0xfeedfacf || le === 0xfeedface || be === 0xcafebabe || be === 0xcafebabf;
}

/** Load commands of the slice for `cpu` (thin or fat file). */
function machO(buf, cpu) {
  let b = buf;
  const be = buf.readUInt32BE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = buf.readUInt32BE(4), wide = be === 0xcafebabf;
    let found = null;
    for (let i = 0; i < n; i++) {
      const o = 8 + i * (wide ? 32 : 20);
      const type = buf.readInt32BE(o) >>> 0;
      const offset = wide ? Number(buf.readBigUInt64BE(o + 8)) : buf.readUInt32BE(o + 8);
      const size = wide ? Number(buf.readBigUInt64BE(o + 16)) : buf.readUInt32BE(o + 12);
      if (type === cpu) found = buf.subarray(offset, offset + size);
    }
    if (!found) return null;
    b = found;
  }
  if (b.readUInt32LE(0) !== 0xfeedfacf) return null; // 64-bit little-endian only
  const cputype = b.readUInt32LE(4);
  const ncmds = b.readUInt32LE(16);
  const str = (o) => { const z = b.indexOf(0, o); return b.subarray(o, z).toString('utf8'); };
  const out = { cputype, deps: [], rpaths: [], id: null, minos: null };
  let p = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = b.readUInt32LE(p), size = b.readUInt32LE(p + 4);
    if ([LC.LOAD_DYLIB, LC.LOAD_WEAK_DYLIB, LC.REEXPORT_DYLIB, LC.LAZY_LOAD_DYLIB, LC.LOAD_UPWARD_DYLIB].includes(cmd)) {
      out.deps.push({ name: str(p + b.readUInt32LE(p + 8)), weak: cmd === LC.LOAD_WEAK_DYLIB });
    } else if (cmd === LC.ID_DYLIB) {
      out.id = str(p + b.readUInt32LE(p + 8));
    } else if (cmd === LC.RPATH) {
      out.rpaths.push(str(p + b.readUInt32LE(p + 8)));
    } else if (cmd === LC.BUILD_VERSION) {
      const v = b.readUInt32LE(p + 12);
      out.minos = `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`;
    }
    p += size;
  }
  return out;
}

// --- assemble ---------------------------------------------------------------------------

function closure(entries, arch) {
  const byName = new Map();
  for (const e of entries) {
    const base = path.posix.basename(e.name);
    if (base.startsWith('._')) continue; // AppleDouble litter
    if (e.type === 'file' || e.type === 'symlink' || e.type === 'hardlink') byName.set(base, e);
  }
  const resolve = (base) => {
    let e = byName.get(base);
    for (let hops = 0; e && e.type !== 'file' && hops < 16; hops++) e = byName.get(path.posix.basename(e.link));
    return e && e.type === 'file' ? e : null;
  };

  const out = new Map();   // name in vendor/llama-mac/<arch> -> tar entry
  const queue = [ENTRY];
  let minos = null;
  const rpathOk = [];
  while (queue.length) {
    const name = queue.shift();
    if (out.has(name)) continue;
    const e = resolve(name);
    if (!e) fail(`${name} is not in the archive`);
    const info = machO(e.data, CPU[arch]);
    if (!info) fail(`${name} is not a 64-bit Mach-O for ${arch}`);
    out.set(name, e);
    if (name === ENTRY) {
      minos = info.minos;
      rpathOk.push(...info.rpaths);
      if (!info.rpaths.some((r) => /^@(loader|executable)_path(\/\.?)?$/.test(r))) {
        fail(`${ENTRY} has no @loader_path rpath (${info.rpaths.join(', ') || 'none'}); its libraries would not be found beside it`);
      }
    }
    for (const dep of info.deps) {
      if (/^\/(usr\/lib|System)\//.test(dep.name)) continue;
      const m = dep.name.match(/^@(rpath|loader_path|executable_path)\/(.+)$/);
      if (!m) fail(`${name} links ${dep.name}, which is outside the archive and will not exist on a user's Mac`);
      const base = path.posix.basename(m[2]);
      if (!resolve(base)) {
        if (dep.weak) continue;
        fail(`${name} needs ${dep.name}, which is not in the archive`);
      }
      queue.push(base);
    }
  }
  const license = entries.find((e) => path.posix.basename(e.name) === 'LICENSE' && e.type === 'file');
  return { files: out, license, minos, rpaths: rpathOk };
}

function isDone(p) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(OUT, p.arch, 'BUILD.json'), 'utf8'));
    if (m.archive.sha256 !== p.sha256) return false;
    return Object.entries(m.files).every(([n, f]) => {
      const file = path.join(OUT, p.arch, n);
      return fs.existsSync(file) && fs.statSync(file).size === f.size;
    });
  } catch { return false; }
}

async function fetchArch(build, arch, force) {
  const p = await plan(build, arch);
  if (!force && isDone(p)) {
    log(`${arch}: ${build} already in vendor/llama-mac/${arch} (use --force to redo)`);
    return verify(p);
  }
  const tgz = await download(p);
  const entries = untar(zlib.gunzipSync(tgz));
  const { files, license, minos } = closure(entries, arch);

  const mtmd = [...files.entries()].find(([n]) => /^libmtmd\b/.test(n));
  if (!mtmd) fail('llama-server does not link libmtmd: no audio input at all');
  const qwen3Asr = mtmd[1].data.includes(Buffer.from(QWEN3_ASR_MARKER));
  if (!qwen3Asr) fail(`${mtmd[0]} in ${build} has no Qwen3-ASR audio encoder (${QWEN3_ASR_MARKER}); pick a newer build`);

  const dest = path.join(OUT, arch);
  const tmp = dest + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const manifest = {
    build: p.build, commit: p.commit,
    archive: { name: p.asset, url: p.url, sha256: p.sha256 },
    arch, minimumMacOS: minos, qwen3Asr,
    note: 'Written by scripts/fetch-llama-mac.js. Regular files only (symlinks resolved to the names the binaries load); Mach-O files 0755.',
    files: {}
  };
  for (const [name, e] of files) {
    fs.writeFileSync(path.join(tmp, name), e.data, { mode: 0o755 });
    fs.chmodSync(path.join(tmp, name), 0o755);
    manifest.files[name] = { from: path.posix.basename(e.name), size: e.data.length, sha256: sha256(e.data) };
  }
  if (license) {
    fs.writeFileSync(path.join(tmp, 'LICENSE'), license.data, { mode: 0o644 });
    manifest.files.LICENSE = { from: 'LICENSE', size: license.data.length, sha256: sha256(license.data) };
  }
  fs.writeFileSync(path.join(tmp, 'BUILD.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);

  const total = [...files.values()].reduce((s, e) => s + e.data.length, 0);
  log(`${arch}: ${files.size} binaries, ${(total / 1048576).toFixed(1)} MB -> vendor/llama-mac/${arch}  (macOS >= ${minos}, Qwen3-ASR audio: yes)`);
  for (const [name, e] of files) log(`   ${name.padEnd(30)} ${String(e.data.length).padStart(9)}  <- ${path.posix.basename(e.name)}`);
  return verify(p);
}

/** On a Mac, prove the binary actually loads: every dylib resolved, signature accepted. */
function verify(p) {
  const server = path.join(OUT, p.arch, ENTRY);
  if (process.platform !== 'darwin') {
    log(`${p.arch}: not on macOS, so the binary was not run (modes are applied at packaging: scripts/after-pack.js)`);
    return;
  }
  const native = (process.arch === 'arm64' ? 'arm64' : 'x64') === p.arch;
  try {
    const out = execFileSync(server, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    log(`${p.arch}: llama-server --version ->`, (out || '').trim().split('\n').pop());
  } catch (e) {
    const text = ((e.stdout || '') + (e.stderr || '')).trim();
    // --version prints to stderr and exits 0 on most builds; a load failure is a dyld message.
    if (/version: \d+/.test(text) && !/dyld|Library not loaded|killed/i.test(text)) {
      log(`${p.arch}: llama-server --version ->`, text.split('\n').pop());
    } else if (native) {
      fail(`${p.arch}: llama-server does not run: ${text || e.message}`);
    } else {
      log(`${p.arch}: could not run the non-native build here (${(text || e.message).split('\n')[0]}); not an error`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const archs = args.filter((a) => a === 'arm64' || a === 'x64');
  const unknown = args.filter((a) => !['arm64', 'x64', '--force'].includes(a));
  if (unknown.length) fail('unknown argument(s): ' + unknown.join(' ') + '\nusage: node scripts/fetch-llama-mac.js [arm64] [x64] [--force]');
  const build = process.env.TYPD_LLAMA_BUILD || PINNED_BUILD;
  if (build !== PINNED_BUILD) log(`TYPD_LLAMA_BUILD=${build}: not the pinned ${PINNED_BUILD}; Windows still runs ${PINNED_BUILD}`);
  for (const arch of archs.length ? archs : ['arm64', 'x64']) await fetchArch(build, arch, force);
}

main().catch((e) => fail(e && e.stack || String(e)));
