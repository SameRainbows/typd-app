#!/usr/bin/env node
'use strict';

/**
 * Low-memory mode (0.2.6): src/main/lowMemory.js decides, src/main/pipeline/local.js applies it.
 *
 *   node bench/low-memory.js            the rules: when it is on, the server's arguments, the piece sizes
 *                                        against the window, the revise limit (no model, no server; seconds)
 *   node bench/low-memory.js --real     the same, then a real llama-server on this machine's CPU:
 *        --model <dir>      the model folder (model.json + GGUFs); default: the light model in dictation-research
 *        --server <exe>     llama-server (default vendor/llama, which scripts/build-mtmd.js patches)
 *        --modes a,b        which configurations, from:
 *                             low      0.2.6 low-memory mode (TYPD_LOW_MEMORY=1), conv group 1
 *                             full     0.2.6 normal mode (TYPD_LOW_MEMORY=0), conv group 1
 *                             before   0.2.5: normal mode, the stock encoder graph (with --server-before)
 *        --server-before <exe>  llama-server for `before` (default ../Typd-0.2.5/vendor/llama)
 *        --parts a,b        mem (8 clips, 10-68 s: memory and text), long (the user's long dictations,
 *                           piece by piece), early (one long dictation fed live, as the app does),
 *                           revise (real revise prompts, one too long), heldout (cv_spont_eval, 284 clips:
 *                           hyps for the repo's scorer)
 *        --out <file>       results JSON (default bench/results/low-memory.json)
 *        --threads <n>      llama-server threads (TYPD_LLAMA_THREADS)
 *        --max-mb <n>       the resident memory the light model must stay under in low mode (default 900)
 *
 * Memory is llama-server's peak working set (the OS's own peak, Get-Process PeakWorkingSet64: what the
 * research measured as "resident"), read after the model has loaded and again after the clips. Windows only
 * for the real part. Nothing here touches Typd's own server (port 8737): it uses TYPD_LLAMA_PORT 18796 (--port).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RESEARCH = path.resolve(ROOT, '..', 'dictation-research');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const REAL = args.includes('--real');

let pass = 0, fail = 0;
function check(what, ok, detail) {
  if (ok) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
}
const section = (t) => console.log('\n' + t);

/* ------------------------------------------------------------------ rules */

function rules() {
  section('1. when low-memory mode is on (lowMemory.js)');
  const { decide, LIGHT_MAX_BYTES } = require('../src/main/lowMemory');
  const GB = 1024 ** 3, MB = 1024 ** 2;
  const env = {};
  check('auto + the light model (397 MB decoder) on 32 GB: on', decide({ setting: 'auto', modelBytes: 396.7 * MB, totalMem: 32 * GB, env }).on === true);
  check('auto + the full model (1.1 GB decoder) on 16 GB: off', decide({ setting: 'auto', modelBytes: 1107 * MB, totalMem: 16 * GB, env }).on === false);
  check('auto + the full model on a 6 GB computer: on (memory)', decide({ setting: 'auto', modelBytes: 1107 * MB, totalMem: 6 * GB, env }).on === true);
  check('auto + the full model on an "8 GB" computer that reports 7.8 GiB: on', decide({ setting: 'auto', modelBytes: 1107 * MB, totalMem: 7.8 * GB, env }).on === true);
  check('auto + an unknown model (no file) on 16 GB: off', decide({ setting: 'auto', modelBytes: 0, totalMem: 16 * GB, env }).on === false);
  check('auto + a stand-in file of 1 byte (benches) on 16 GB: off', decide({ setting: 'auto', modelBytes: 1, totalMem: 16 * GB, env }).on === false);
  check('on: on, whatever the model', decide({ setting: 'on', modelBytes: 1107 * MB, totalMem: 64 * GB, env }).on === true);
  check('off: off, even for the light model on 4 GB', decide({ setting: 'off', modelBytes: 396.7 * MB, totalMem: 4 * GB, env }).on === false);
  check('a setting Typd never wrote reads as auto', decide({ setting: 'sometimes', modelBytes: 396.7 * MB, totalMem: 32 * GB, env }).on === true);
  check('TYPD_LOW_MEMORY=0 beats the setting', decide({ setting: 'on', modelBytes: 396.7 * MB, env: { TYPD_LOW_MEMORY: '0' } }).on === false);
  check('TYPD_LOW_MEMORY=1 beats the setting', decide({ setting: 'off', modelBytes: 1107 * MB, env: { TYPD_LOW_MEMORY: '1' } }).on === true);
  check('the light/full line sits between the two shipped decoders', LIGHT_MAX_BYTES > 400 * MB && LIGHT_MAX_BYTES < 1100 * MB);

  section('2. what the server is started with (local.js)');
  const local = freshLocal({});
  const low = local.serverArgs('0', true), full = local.serverArgs('99', false);
  const val = (a, k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  check('low: -c 1280', val(low, '-c') === '1280');
  check('low: K at q8_0 (never q4: decoding breaks)', val(low, '-ctk') === 'q8_0');
  check('low: V at q4_0', val(low, '-ctv') === 'q4_0');
  check('low: flash attention on (a quantized V needs it)', val(low, '-fa') === 'on');
  check('low: --no-repack', low.includes('--no-repack'));
  check('full: -c 4096, q8_0/q8_0, the weights repacked as before', val(full, '-c') === '4096' && val(full, '-ctk') === 'q8_0' && val(full, '-ctv') === 'q8_0' && !full.includes('--no-repack'));
  for (const a of [low, full]) {
    check(`${a === low ? 'low' : 'full'}: -ub 256 -np 1 --cache-ram 0 --no-warmup as before`, val(a, '-ub') === '256' && val(a, '-np') === '1' && val(a, '--cache-ram') === '0' && a.includes('--no-warmup'));
  }
  check('low-memory mode: the encoder runs one conv chunk at a time (MTMD_QWEN3A_CONV_GROUP=1)', local.serverEnv({}, '99', true).MTMD_QWEN3A_CONV_GROUP === '1');
  check('on the processor (-ngl 0), any mode: one conv chunk at a time (identical output there)', local.serverEnv({}, '0', false).MTMD_QWEN3A_CONV_GROUP === '1');
  check('the full model on the GPU in normal mode: the stock graph, as before (not identical on CUDA)', !('MTMD_QWEN3A_CONV_GROUP' in local.serverEnv({ MTMD_QWEN3A_CONV_GROUP: '1' }, '99', false)));
  process.env.TYPD_CONV_GROUP = '0';
  check('TYPD_CONV_GROUP=0: the stock graph (variable unset)', !('MTMD_QWEN3A_CONV_GROUP' in local.serverEnv({ MTMD_QWEN3A_CONV_GROUP: '4' }, '0', true)));
  delete process.env.TYPD_CONV_GROUP;

  section('3. no request outgrows the window (long dictations, revise)');
  const long = require('../src/main/pipeline/long');
  check('full mode: the trained piece sizes (75 / 45-70 s)', JSON.stringify(local.longLimits()) === JSON.stringify(long.LIMITS));
  const lim = long.limitsFor((1280 - 40 - 96 - 16 - Math.ceil((600 + 200) / 3)) / 21);
  check(`low mode: pieces of ${lim.pieceMinS}-${lim.pieceMaxS} s, nothing over ${lim.longS} s in one request`, lim.longS === 41 && lim.pieceMaxS === 36 && lim.pieceMinS === 23, lim);
  // The worst request: the longest piece, the longest screen context, its whole output budget.
  const worst = 40 + Math.ceil((600 + 200) / 3) + 13 * lim.longS + (96 + 8 * lim.longS) + 16;
  check(`low mode: the worst request (${worst} tokens) fits 1,280`, worst <= 1280, worst);
  // Every piece of a long synthetic recording (speech with pauses) is within the limits.
  const sr = 16000, secs = 400, x = new Float32Array(sr * secs);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, word = (Math.floor(t * 3) % 7) !== 6 && (Math.floor(t / 8.3) % 5) !== 4;
    x[i] = (word ? 0.3 : 0.002) * (rnd() - 0.5);
  }
  const { pieces } = long.splitLong(x, sr, lim);
  const lens = pieces.map((p) => p.length / sr);
  check(`a ${secs} s recording: ${pieces.length} pieces, each <= ${lim.longS} s`, lens.every((s) => s <= lim.longS + 1e-6), lens.map((s) => s.toFixed(1)));
  check('... and all but the last >= the minimum', lens.slice(0, -1).every((s) => s >= lim.pieceMinS - 0.5), lens.map((s) => s.toFixed(1)));
  const fullPieces = long.splitLong(x, sr).pieces.map((p) => p.length / sr);
  check('the same recording in full mode: the 0.2.5 cuts, unchanged', fullPieces.every((s) => s <= 75 + 1e-6) && fullPieces.length < pieces.length, fullPieces.map((s) => s.toFixed(1)));
  // Early decoding cuts exactly as the end does, with the low limits too.
  const sp = new long.Splitter(sr, lim);
  const early = [];
  for (let n = sr; n <= x.length; n += sr / 4) early.push(...sp.feed(x, n));
  early.push(...sp.feed(x, x.length, true));
  const atEnd = long.splitLong(x, sr, lim).cuts;
  check('low mode: the cuts made while talking are the cuts made at the end', early.length === atEnd.length && early.every((c, i) => c.end === atEnd[i].end), [early.length, atEnd.length]);

  const rl = local.reviseLimit();
  check('full mode: revise takes up to 6,000 characters / ~1,000 words, as before', rl.chars === 6000 && rl.words === 1000, rl);
}

/** local.js loaded afresh with `env` (each instance reads its environment at load). */
function freshLocal(env) {
  for (const k of ['TYPD_MODEL_DIR', 'TYPD_LLAMA_PORT', 'TYPD_LLAMA_SERVER', 'TYPD_SELFTEST', 'TYPD_LOW_MEMORY', 'TYPD_CONV_GROUP', 'TYPD_GPU_LAYERS', 'TYPD_LLAMA_THREADS']) delete process.env[k];
  Object.assign(process.env, env);
  for (const m of ['../src/main/pipeline/local', '../src/main/pipeline/index']) delete require.cache[require.resolve(m)];
  return require('../src/main/pipeline/local');
}

/* ------------------------------------------------------------------- real */

function decode(file) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(out.buffer, out.byteOffset, out.length / 4).slice();
}

function memOf(pid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64) $($p.PrivateMemorySize64)"`], { encoding: 'utf8' });
  const [ws, peak, priv] = String(r.stdout || '').trim().split(/\s+/).map(Number);
  return { wsMB: Math.round(ws / 1e6), peakMB: Math.round(peak / 1e6), privateMB: Math.round(priv / 1e6) };
}

const norm = (s) => String(s || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = norm(ref), h = norm(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const row = [i];
    for (let j = 1; j <= h.length; j++) row[j] = r[i - 1] === h[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    prev = row;
  }
  return prev[h.length] / r.length;
}

async function textOf(gen) { let t = ''; for await (const x of gen) t = x; return t; }

/**
 * The public installer's llama.cpp: the folder without the CUDA backend (it comes as the CUDA pack, on the
 * GPU path only). Run from vendor/llama as it is, llama.cpp would load CUDA on an NVIDIA machine and put the
 * encoder on the GPU, which is not what a CPU-only computer runs. A copy in the temp folder, once.
 */
function cpuOnly(exe) {
  const dir = path.dirname(exe);
  if (!fs.existsSync(path.join(dir, 'ggml-cuda.dll')) || args.includes('--cuda')) return exe;
  const sum = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, 'mtmd.dll'))).digest('hex').slice(0, 12);
  const out = path.join(os.tmpdir(), 'typd-cpu-llama-' + sum);
  if (!fs.existsSync(path.join(out, 'llama-server.exe'))) {
    fs.mkdirSync(out, { recursive: true });
    for (const n of fs.readdirSync(dir)) {
      if (/^(ggml-cuda|cublas.*|cudart.*)\.dll$/i.test(n) || (/-impl\.dll$/i.test(n) && n !== 'llama-server-impl.dll')) continue;
      if (/\.(dll|exe)$/i.test(n)) fs.copyFileSync(path.join(dir, n), path.join(out, n));
    }
  }
  return path.join(out, 'llama-server.exe');
}

async function real() {
  const modelDir = opt('model', path.join(RESEARCH, 'models', 'md_soup_r20kd_ship'));
  const server = cpuOnly(opt('server', path.join(ROOT, 'vendor', 'llama', 'llama-server.exe')));
  const serverBefore = cpuOnly(opt('server-before', path.resolve(ROOT, '..', 'Typd-0.2.5', 'vendor', 'llama', 'llama-server.exe')));
  console.log('  llama-server:', server, '| before:', serverBefore);
  const modes = opt('modes', 'before,low').split(',');
  const parts = opt('parts', 'mem,long,early,revise').split(',');
  const maxMB = Number(opt('max-mb', 900));
  const outFile = opt('out', path.join(ROOT, 'bench', 'results', 'low-memory.json'));
  const threads = opt('threads', '');
  const results = { at: new Date().toISOString(), model: modelDir, host: { cpus: os.cpus().length, cpu: os.cpus()[0].model, totalMemGB: Math.round(os.totalmem() / 1e9) }, modes: {} };
  const save = () => { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(results, null, 1)); };

  const mem = fs.readFileSync(path.join(RESEARCH, 'results', 'small', 'mem_manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const DOG = path.join(RESEARCH, 'data', 'dogfood_2026-10-16');
  const whisper = new Map(fs.readFileSync(path.join(DOG, 'whisper_long.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r.hyp]));
  const LONG = (opt('long', '2026-10-13T20-12-58-273Z,2026-10-13T19-05-41-378Z,2026-10-13T19-12-46-933Z,2026-10-13T19-47-15-666Z')).split(',');

  for (const mode of modes) {
    section(`real llama-server, ${mode} (${path.basename(modelDir)}, CPU)`);
    const env = {
      TYPD_MODEL_DIR: modelDir, TYPD_LLAMA_PORT: opt('port', '18796'), TYPD_GPU_LAYERS: '0',
      TYPD_LLAMA_SERVER: mode === 'before' ? serverBefore : server,
      TYPD_LOW_MEMORY: mode === 'low' ? '1' : '0',
      ...(mode === 'before' ? { TYPD_CONV_GROUP: '0' } : {}),
      ...(threads ? { TYPD_LLAMA_THREADS: threads } : {})
    };
    const local = freshLocal(env);
    const r = results.modes[mode] = { env: { ...env }, lowMemory: null, mem: {}, clips: [], long: [], revise: [] };
    const t0 = Date.now();
    await local.warm();
    r.startMs = Date.now() - t0;
    r.lowMemory = local.lowMemory;
    r.args = local.serverArgs('0');
    const pid = local.SERVER_PID;
    r.mem.afterLoad = memOf(pid);
    console.log('  started in', r.startMs, 'ms; low-memory', JSON.stringify(r.lowMemory), 'memory after the self-test', JSON.stringify(r.mem.afterLoad));
    check(`${mode}: low-memory mode is ${mode === 'low' ? 'on' : 'off'}`, r.lowMemory.on === (mode === 'low'));

    if (parts.includes('mem')) {
      for (const c of mem) {
        const x = decode(c.audio);
        const s0 = Date.now();
        const text = await textOf(local.dictate(x, 16000, null, '', local.dictationBudget(x, 16000)));
        r.clips.push({ id: c.id, seconds: x.length / 16000, ms: Date.now() - s0, chars: text.length, text });
        console.log(`  ${c.id} ${(x.length / 16000).toFixed(1)} s -> ${text.length} chars in ${Date.now() - s0} ms`);
      }
      r.mem.afterMem = memOf(pid);
      console.log('  memory after the 8 clips', JSON.stringify(r.mem.afterMem));
      check(`${mode}: every clip written (non-empty)`, r.clips.every((c) => c.chars > 0), r.clips.map((c) => c.chars));
      if (mode === 'low') check(`low: peak resident ${r.mem.afterMem.peakMB} MB <= ${maxMB} MB`, r.mem.afterMem.peakMB <= maxMB, r.mem.afterMem);
      save();
    }

    if (parts.includes('long')) {
      for (const id of LONG) {
        const x = decode(path.join(DOG, 'rec', id + '.wav'));
        const pieces = [];
        const s0 = Date.now();
        const text = await textOf(local.dictate(x, 16000, null, '', 1024, { hooks: { piece: (i, t) => pieces.push({ i, chars: t.length }) } }));
        const lim = local.longLimits();
        const split = require('../src/main/pipeline/long').splitLong(x, 16000, lim).pieces.map((p) => +(p.length / 16000).toFixed(1));
        const w = wer(whisper.get(id), text);
        r.long.push({ id, seconds: +(x.length / 16000).toFixed(1), pieces: split, ms: Date.now() - s0, chars: text.length, werVsWhisper: +w.toFixed(4), text });
        console.log(`  long ${id} ${(x.length / 16000).toFixed(0)} s: ${split.length} pieces (${split.join(', ')} s) -> ${text.length} chars, WER vs Whisper ${(100 * w).toFixed(1)} %, ${Date.now() - s0} ms`);
        check(`${mode}: long ${id}: every piece within ${lim.longS} s and written`, split.every((s) => s <= lim.longS + 0.01) && pieces.length === split.length && pieces.every((p) => p.chars > 0), { split, pieces });
      }
      r.mem.afterLong = memOf(pid);
      if (mode === 'low') check(`low: peak resident after the long dictations ${r.mem.afterLong.peakMB} MB <= ${maxMB} MB`, r.mem.afterLong.peakMB <= maxMB, r.mem.afterLong);
      save();
    }

    if (parts.includes('early')) {
      // As the app does: the audio arrives in 256 ms chunks, pieces are written while "talking", finish() joins.
      const id = LONG[Math.min(2, LONG.length - 1)];
      const x = decode(path.join(DOG, 'rec', id + '.wav'));
      const live = local.openLong(null, () => '');
      const step = 4096;
      const s0 = Date.now();
      for (let i = 0; i < x.length; i += step) {
        live.push(x.subarray(i, Math.min(x.length, i + step)));
        if (i % (step * 64) === 0) await new Promise((res) => setImmediate(res));
      }
      const released = Date.now();
      const text = await textOf(live.finish(x, 16000, null, '', 1024));
      const tm = live.timings;
      const earlyN = tm.filter((t) => t.phase === 'early').length, late = tm.filter((t) => t.phase === 'finish').length;
      r.early = { id, earlyRequests: earlyN, writtenAfterRelease: late, releaseToTextMs: Date.now() - released, chars: text.length, werVsWhisper: +wer(whisper.get(id), text).toFixed(4) };
      console.log('  early decode', JSON.stringify(r.early));
      check(`${mode}: early decode used the pieces written while talking (${earlyN} early, ${late} after release)`, earlyN > 0 && text.length > 0);
      save();
    }

    if (parts.includes('revise')) {
      const man = path.join(RESEARCH, 'data', 'revise', 'r27pack', 'manifest.jsonl');
      const rows = fs.readFileSync(man, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const byLen = (lo, hi) => rows.filter((x) => x.span.length >= lo && x.span.length < hi && !/translate/.test(x.id));
      // Two real items, then long selections (the set's spans are <= 400 characters): several of its
      // grammar spans joined, under a real "fix the grammar" instruction -- ~1,300 characters (fits the
      // low-memory window) and ~2,600 (does not: refused with the limit in words; fits the full one).
      const grammar = rows.filter((x) => x.cat === 'fix_grammar');
      const joined = (n) => { let t = '', i = 0; while (t.length < n) t += (t ? '\n\n' : '') + grammar[i++ % grammar.length].span; return t; };
      const longItem = (n) => ({ ...grammar[0], id: grammar[0].id + '+long' + n, span: joined(n), clean: joined(n) });
      const pick = [...byLen(100, 400).slice(0, 2), longItem(1300), longItem(2600)];
      const pipeline = require('../src/main/pipeline/index');
      for (const it of pick) {
        const x = decode(path.join(path.dirname(man), it.audio));
        const info = {};
        let text = '', err = null;
        const s0 = Date.now();
        try {
          for await (const e of pipeline.run({ mode: 'revise', audio: { samples: x, sampleRate: 16000 }, span: it.span, signal: null })) {
            if (e.type === 'partial') text = e.text;
            if (e.type === 'done' || e.type === 'refused') { text = e.text; info.event = e.type; info.reason = e.reason; }
          }
        } catch (e) { err = e.message; }
        const w = wer(it.clean, text);
        r.revise.push({ id: it.id, spanChars: it.span.length, ms: Date.now() - s0, event: info.event || null, reason: info.reason || null, error: err, werVsTarget: err ? null : +w.toFixed(3) });
        console.log(`  revise ${it.id} span ${it.span.length} chars -> ${err ? 'error: ' + err : info.event + (info.reason ? ' (' + info.reason + ')' : '') + ', WER vs target ' + (100 * w).toFixed(1) + ' %'} ${Date.now() - s0} ms`);
        const fits = it.span.length <= local.reviseLimit().chars;
        // A result, or one of the revise guards' verdicts (guards.js: "nothing changed" and the like) -- the
        // model's call, the same in either mode; never an error, and never 'truncated' (the window ran out).
        if (fits) check(`${mode}: revise of ${it.span.length} chars runs to a result (${info.event}${info.reason ? ': ' + info.reason : ''})`, !err && (info.event === 'done' || (info.event === 'refused' && info.reason !== 'truncated')) && text.length > 0, { err, info });
        else check(`${mode}: revise of ${it.span.length} chars refused with the limit in words ("${err}")`, Boolean(err) && /Too much selected — up to ~[\d,]+ words/.test(err), err);
      }
      save();
    }

    if (parts.includes('heldout')) {
      const man = path.join(RESEARCH, 'data', 'rs', 'final', 'cv_spont_eval_manifest.jsonl');
      const rows = fs.readFileSync(man, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const out = path.join(path.dirname(outFile), `cv_spont_${mode}.jsonl`);
      const lines = [];
      const s0 = Date.now();
      for (const it of rows) {
        const x = decode(path.resolve(path.dirname(man), it.audio));
        const hyp = await textOf(local.dictate(x, 16000, null, it.system || '', local.dictationBudget(x, 16000)));
        lines.push(JSON.stringify({ id: it.id, hyp, ref: it.clean }));
      }
      fs.writeFileSync(out, lines.join('\n') + '\n');
      r.heldout = { file: out, clips: rows.length, ms: Date.now() - s0 };
      r.mem.afterHeldout = memOf(pid);
      console.log('  held-out:', rows.length, 'clips ->', out, 'in', Math.round((Date.now() - s0) / 1000), 's; memory', JSON.stringify(r.mem.afterHeldout));
      save();
    }
    local.stop();
    await new Promise((res) => setTimeout(res, 1500));
  }
  save();
  console.log('\nresults:', outFile);
}

(async () => {
  rules();
  if (REAL) await real();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
