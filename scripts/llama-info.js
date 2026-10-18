'use strict';

/**
 * What a Windows llama.cpp folder (vendor/llama: the CUDA release of llama.cpp) is, for the build:
 * scripts/before-pack.js stages it into the app and writes <resources>/llama/cuda.json from this;
 * scripts/cuda-pack.js makes the CUDA pack from it; scripts/app-update-package.js leaves the CUDA files
 * out of an update package (and carries them over from the installed app).
 *
 *   describe(dir) -> {build, commit, cuda: '12.4', pack: 'cuda-b11351-cu12.4', files: [{name, size, sha256}],
 *                     cpuFiles: [names], all: [names]}
 *
 * The CUDA backend is ggml-cuda.dll and the NVIDIA libraries it loads (cuBLAS, cuBLASLt, the CUDA runtime);
 * every other file of llama.cpp's CUDA release is byte for byte its CPU release (checked for b11351:
 * ggml-base, ggml, llama, mtmd, llama-server-impl, llama-common, every ggml-cpu-*.dll). The pack's id names
 * the llama.cpp build and the CUDA runtime, because a ggml backend loads only into the build it came from.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const CUDA_RE = /^(ggml-cuda|cublas64_\d+|cublasLt64_\d+|cudart64_\d+)\.dll$/i;
// What the app needs of llama.cpp's release (package.json's filter before 0.2.5): the server and the
// libraries, none of the other tools' *-impl.dll.
const SHIPS = (name) => name === 'llama-server.exe' || (/\.dll$/i.test(name) && (!/^llama-.*-impl\.dll$/i.test(name) || name === 'llama-server-impl.dll'));

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** "version: 0.5.0-dev (build 11351, commit 631109b34)" from llama-server --version. */
function buildOf(dir) {
  if (process.env.TYPD_LLAMA_BUILD) {
    const [build, commit] = process.env.TYPD_LLAMA_BUILD.split(':');
    return { build: Number(build), commit: commit || null };
  }
  // It prints to stderr.
  const r = spawnSync(path.join(dir, 'llama-server.exe'), ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const m = /build (\d+), commit ([0-9a-f]+)/.exec(out);
  if (!m) throw new Error(`cannot read llama.cpp's build from ${dir}\\llama-server.exe --version (set TYPD_LLAMA_BUILD=<build>:<commit>)`);
  return { build: Number(m[1]), commit: m[2] };
}

/** The CUDA runtime's version from cudart64_*.dll's file version (6,14,11,12040 -> 12.4); TYPD_CUDA_VERSION overrides. */
function cudaOf(dir, names) {
  if (process.env.TYPD_CUDA_VERSION) return process.env.TYPD_CUDA_VERSION;
  const rt = names.find((n) => /^cudart64_\d+\.dll$/i.test(n));
  if (!rt) return null;
  try {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const v = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${path.join(dir, rt).replace(/'/g, "''")}').VersionInfo.FileVersion`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true }).trim();
    const n = Number(v.split(/[,.]/).pop());
    if (Number.isFinite(n) && n > 1000) return Math.floor(n / 1000) + '.' + Math.floor((n % 1000) / 10);
  } catch { /* below */ }
  const m = /^cudart64_(\d+)\.dll$/i.exec(rt);
  return m ? m[1] : null;
}

function describe(dir) {
  if (!fs.existsSync(path.join(dir, 'llama-server.exe'))) throw new Error(`${dir} has no llama-server.exe`);
  const all = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile() && SHIPS(n)).sort();
  const cudaNames = all.filter((n) => CUDA_RE.test(n));
  const { build, commit } = buildOf(dir);
  const files = cudaNames.map((name) => {
    const p = path.join(dir, name);
    return { name, size: fs.statSync(p).size, sha256: sha256File(p) };
  });
  const cuda = cudaNames.length ? cudaOf(dir, cudaNames) : null;
  return {
    build, commit, cuda,
    pack: cudaNames.length ? `cuda-b${build}` + (cuda ? '-cu' + cuda : '') : null,
    files,
    cpuFiles: all.filter((n) => !CUDA_RE.test(n)),
    all
  };
}

/** The cuda.json the app reads (src/main/cudaPack.js), or null when the folder has no CUDA backend. */
function cudaJson(info) {
  if (!info.pack) return null;
  return { schema: 'typd-cuda/1', pack: info.pack, llama: { build: info.build, commit: info.commit }, cuda: info.cuda, files: info.files };
}

module.exports = { describe, cudaJson, CUDA_RE, SHIPS, sha256File };
