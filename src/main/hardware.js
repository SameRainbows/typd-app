'use strict';

/**
 * Which dictation model fits this computer: 'full' (the 1.7B) or 'light' (the 0.6B). The model
 * updater follows the published manifest's variant of that name (modelUpdate.js); Settings can pin
 * either one instead of Automatic (settings.modelVariant).
 *
 *   full    an NVIDIA GPU with at least FULL_VRAM_MIB of memory in all (Windows and Linux, where
 *           Typd's llama.cpp is the CUDA build), or Apple Silicon with at least 16 GB of memory
 *           (the arm64 build, where llama.cpp runs on Metal and shares that memory)
 *   light   anything else: no NVIDIA GPU (an AMD or Intel GPU means the CPU, since the Windows
 *           build is CUDA only), a smaller NVIDIA card, an Intel Mac or the x64 build under
 *           Rosetta (llama.cpp on the CPU there), an 8 GB Mac
 *
 * Total VRAM, not free. The 1.7B model with its mmproj and the revise adapter holds ~1.8 GB on the
 * GPU. Free memory is a snapshot that moves with whatever else runs, and it already excludes the
 * ~1.8 GB Typd's own server holds while it runs the full model: the developer's RTX 3050 Ti
 * (4,096 MiB) reports ~2,100 MiB free with Typd running, so a rule on free memory would send the
 * machine that runs the full model well today to the light one, and back again once Typd's server
 * is stopped -- a 600 MB or 1.1 GB download every time it flipped. Total memory is a property of
 * the card and never flips. 3.5 GiB of it leaves ~1.7 GB for the desktop and other apps beside the
 * model: every 4 GB card (4,096 MiB; laptop parts report the same) qualifies, the 2-3 GB ones
 * (GTX 1050, GTX 1060 3 GB, MX series) do not. A machine where the full model does not fit after
 * all still works: llama.cpp falls back to the CPU and the self-test guards the result.
 *
 * Detection needs no native module: nvidia-smi (installed with every NVIDIA driver; System32 on
 * Windows), `sysctl -n hw.memsize` on macOS (os.totalmem() if that fails), and Electron's
 * app.getGPUInfo('basic') to name a GPU nvidia-smi does not cover. Electron-free: the runner and
 * the GPU list are passed in, so bench/model-choice.js drives it with fakes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const FULL_VRAM_MIB = 3584;                  // 3.5 GiB of VRAM in all
const FULL_MAC_BYTES = 15.5 * 1024 ** 3;     // a 16 GB Mac reports 17,179,869,184 bytes
const NVIDIA = 0x10de, AMD = 0x1002, INTEL = 0x8086, APPLE = 0x106b;
const TIMEOUT_MS = 8000;

/** Run a program, never through a shell, with no window: resolves {code, stdout} (code -1: it did not run). */
function runFile(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 }, (err, stdout) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || '') });
      });
    } catch {
      resolve({ code: -1, stdout: '' });
    }
  });
}

/** Where nvidia-smi is: the driver puts it in System32 on Windows; elsewhere it is on the PATH. */
function nvidiaSmiPaths(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return ['nvidia-smi'];
  const sys = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'nvidia-smi.exe');
  const old = path.join(env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe');
  return [sys, old, 'nvidia-smi.exe'];
}

/**
 * nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits
 *   "NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096, 2096"   (one line per GPU; MiB)
 * -> [{name, totalMiB, freeMiB}], unreadable lines left out.
 */
function parseNvidiaSmi(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*,\s*(\d+)\s*,\s*(\d+|\[N\/A\]|N\/A)\s*$/.exec(line);
    if (!m) continue;
    const total = Number(m[2]);
    if (!Number.isFinite(total) || total <= 0) continue;
    out.push({ name: m[1].slice(0, 80), totalMiB: total, freeMiB: /^\d+$/.test(m[3]) ? Number(m[3]) : null });
  }
  return out;
}

/** The biggest NVIDIA GPU nvidia-smi reports, or null (no driver, no card, or it failed). */
async function probeNvidia({ run = runFile, platform = process.platform, env = process.env } = {}) {
  for (const exe of nvidiaSmiPaths(platform, env)) {
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) continue;
    const r = await run(exe, ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits']);
    if (r.code !== 0) continue;
    const gpus = parseNvidiaSmi(r.stdout);
    if (gpus.length) return gpus.sort((a, b) => b.totalMiB - a.totalMiB)[0];
  }
  return null;
}

/** macOS: physical memory in bytes (sysctl hw.memsize; os.totalmem(), the same number, if that fails). */
async function probeMacMemory({ run = runFile, totalmem = os.totalmem } = {}) {
  const r = await run('/usr/sbin/sysctl', ['-n', 'hw.memsize']);
  const n = r.code === 0 ? Number(String(r.stdout).trim()) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  try { return totalmem(); } catch { return null; }
}

/** Electron's app.getGPUInfo('basic') -> the vendors of the GPUs it sees ('nvidia', 'amd', 'intel', 'apple', 'other'). */
function vendorsOf(info) {
  const list = info && Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const name = (id) => (id === NVIDIA ? 'nvidia' : id === AMD ? 'amd' : id === INTEL ? 'intel' : id === APPLE ? 'apple' : 'other');
  return [...new Set(list.filter((d) => d && Number.isFinite(d.vendorId) && d.vendorId > 0).map((d) => name(d.vendorId)))];
}

/**
 * What this computer has, for pick():
 *   {platform, arch, nvidia: {name, totalMiB, freeMiB}|null, memBytes, vendors: [..]}
 *   run          (file, args) => Promise<{code, stdout}>   (tests: a fake)
 *   gpuInfo      () => Promise<object>: Electron's app.getGPUInfo('basic'); optional
 */
async function detect({ platform = process.platform, arch = process.arch, run = runFile, env = process.env, gpuInfo = null, totalmem = os.totalmem } = {}) {
  const hw = { platform, arch, nvidia: null, memBytes: null, vendors: [] };
  if (gpuInfo) {
    try { hw.vendors = vendorsOf(await Promise.race([gpuInfo(), new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS))])); } catch { hw.vendors = []; }
  }
  if (platform === 'darwin') hw.memBytes = await probeMacMemory({ run, totalmem });
  else hw.nvidia = await probeNvidia({ run, platform, env });
  return hw;
}

const gib = (bytes) => Math.round(bytes / 1024 ** 3);

/**
 * {variant: 'full'|'light', why}: `why` is one line for Settings ("NVIDIA GeForce RTX 3060, 6 GB").
 */
function pick(hw) {
  if (!hw) return { variant: 'light', why: 'This computer could not be checked' };
  if (hw.platform === 'darwin') {
    if (hw.arch !== 'arm64') return { variant: 'light', why: 'An Intel Mac (the model runs on the processor)' };
    if (!hw.memBytes) return { variant: 'light', why: 'This Mac’s memory could not be read' };
    const gb = gib(hw.memBytes);
    return hw.memBytes >= FULL_MAC_BYTES
      ? { variant: 'full', why: `Apple silicon with ${gb} GB of memory` }
      : { variant: 'light', why: `Apple silicon with ${gb} GB of memory (Full needs 16 GB)` };
  }
  const g = hw.nvidia;
  if (g) {
    const gb = Math.round((g.totalMiB / 1024) * 10) / 10;
    const size = (Number.isInteger(gb) ? gb : gb.toFixed(1)) + ' GB';
    return g.totalMiB >= FULL_VRAM_MIB
      ? { variant: 'full', why: `${g.name}, ${size}` }
      : { variant: 'light', why: `${g.name}, ${size} (Full needs a 4 GB NVIDIA GPU)` };
  }
  // No nvidia-smi answer: either no NVIDIA card (AMD, Intel or none: the CUDA build runs on the
  // processor), or one without its driver, which CUDA needs too.
  if ((hw.vendors || []).includes('nvidia')) return { variant: 'light', why: 'An NVIDIA GPU without its driver tools (the model runs on the processor)' };
  return { variant: 'light', why: 'No NVIDIA GPU (the model runs on the processor)' };
}

module.exports = { detect, pick, parseNvidiaSmi, probeNvidia, probeMacMemory, vendorsOf, nvidiaSmiPaths, runFile, FULL_VRAM_MIB, FULL_MAC_BYTES };
