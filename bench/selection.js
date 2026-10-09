'use strict';

/**
 * Can we read what the user highlighted, in the applications they actually use?
 *
 * This is the load-bearing assumption behind revision-by-voice. The plan is that
 * you select a span with the mouse and speak an instruction about it, which
 * makes the selection the pointer -- no numbered overlay, no addressing grammar
 * to learn. Every other part of that turn is already proven on this machine:
 * inject.ps1 reads focused-control text in ~8 ms, and the clipboard paste
 * overwrites a selection for free, so replacing the span costs no new code.
 *
 * What is not proven is that UI Automation returns real selected text outside
 * Notepad. Chrome renders its own text, Electron apps ship their own
 * accessibility trees, and Win32 controls vary. If the answer is "only in half
 * of them", pointing-by-selection is the wrong design, and it is much cheaper to
 * learn that here than after a session architecture is sitting on top of it.
 *
 * Drives src/main/inject.ps1 directly rather than through inject.js, which
 * requires electron for the clipboard and so cannot be loaded from plain node.
 *
 *   node bench/selection.js [seconds] [--copy]
 *
 * Then leave the console alone: alt-tab through your apps, highlight text in
 * each, and pause a moment. The probe samples the foreground window on a timer,
 * so the console must NOT be focused while you are testing -- a reading of
 * "WindowsTerminal" means it caught you between apps and is not a result.
 *
 * --copy additionally measures the fallback: send Ctrl+C and read the clipboard.
 * That path works wherever copying works, which is everywhere, so it decides
 * whether the accessibility gaps are design constraints or merely a slower
 * second choice. One copy is sent per application, the clipboard is restored,
 * and a sentinel distinguishes "nothing was selected" from a stale clipboard.
 */

const path = require('path');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, '..', 'src', 'main', 'inject.ps1');

const args = process.argv.slice(2);

const SECONDS = Number(args.find((a) => /^\d+$/.test(a))) || 60;
const INTERVAL_MS = 700;

// Ctrl+C is measured only when asked for. It is the universal path -- it works
// wherever copying works -- but it puts a real keystroke into whatever the user
// has open and briefly takes their clipboard, so it should not be the default
// behaviour of a probe left running in the background.
const WITH_COPY = args.includes('--copy');

// How long after an application comes forward before the clipboard test fires.
// Long enough to alt-tab and drag over a sentence.
const ARM_AFTER_MS = 3500;

// The probe itself, and the shells it runs inside, are not results.
const IGNORE = new Set([
  'powershell', 'pwsh', 'windowsterminal', 'cmd', 'conhost', 'explorer'
]);

/* ----------------------------------------------------------------- transport */

let proc = null;
let queue = [];
let buffer = '';

function handleLine(line) {
  const text = line.trim();
  if (!text) return;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }

  if (payload.ready) {
    if (queue.length && queue[0].waitingForReady) queue.shift().resolve(payload);
    return;
  }

  const pending = queue.shift();
  if (pending) pending.resolve(payload);
}

function start() {
  return new Promise((resolve, reject) => {
    proc = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });

    // The helper is chatty on stderr only when something is genuinely wrong --
    // a syntax error in the script shows up here and nowhere else.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => process.stderr.write('  helper: ' + d));

    proc.on('error', reject);

    queue.push({ waitingForReady: true, resolve });
    setTimeout(() => reject(new Error('helper never reported ready')), 15000);
  });
}

function command(line, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i !== -1) queue.splice(i, 1);
      reject(new Error('timed out'));
    }, timeoutMs);

    const entry = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    };

    queue.push(entry);
    proc.stdin.write(line + '\n');
  });
}

/* -------------------------------------------------------------------- report */

// One row per application, holding the best outcome seen there. An app that
// ever returned a real selection is a pass, regardless of how many caret-only
// readings it also produced while the cursor sat somewhere empty.
const seen = new Map();

const RANK = { 'text-pattern': 3, 'caret-only': 2 };

function rowFor(app) {
  const row = seen.get(app) ||
    { app, best: null, methods: new Set(), sample: '', len: 0, times: [], copy: null };
  seen.set(app, row);
  return row;
}

function record(r, ms) {
  const app = (r.process || 'unknown').toLowerCase();
  if (IGNORE.has(app)) return;

  const row = rowFor(app);

  row.methods.add(r.method);
  row.times.push(ms);

  const rank = RANK[r.method] || 1;
  const bestRank = RANK[row.best] || 0;
  if (rank > bestRank) row.best = r.method;

  // Keep the longest real selection seen: it is the most convincing evidence
  // that this is a genuine range read and not a one-word coincidence.
  if (r.method === 'text-pattern' && r.length > row.len) {
    row.len = r.length;
    row.sample = r.text;
  }
}

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function trim(text, n) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

const VERDICT = {
  'text-pattern': 'PASS     read the highlighted span',
  'caret-only': 'PARTIAL  pattern works, nothing was highlighted',
  'selection-unsupported': 'FAIL     control refuses GetSelection',
  'no-selection-range': 'FAIL     no range returned',
  'value-pattern-no-selection': 'FAIL     single-line input, no selection model',
  'no-text-pattern': 'FAIL     control exposes no text pattern',
  'no-focused-element': 'FAIL     nothing focused'
};

function report() {
  const rows = [...seen.values()].sort((a, b) => a.app.localeCompare(b.app));

  console.log('\n' + '='.repeat(72));
  console.log('SELECTION READABILITY');
  console.log('='.repeat(72));

  if (!rows.length) {
    console.log('\nNothing sampled. The console stayed focused the whole time, or');
    console.log('every app touched was on the ignore list.\n');
    return;
  }

  const pad = ' '.repeat(18);

  for (const row of rows) {
    const verdict = VERDICT[row.best] || 'FAIL     ' + row.best;
    console.log('\n  ' + row.app.padEnd(18) + verdict);
    console.log('  ' + pad + median(row.times) + ' ms median, ' +
      row.times.length + ' samples');
    if (row.sample) {
      console.log('  ' + pad + row.len + ' chars: "' + trim(row.sample, 60) + '"');
    }
    const others = [...row.methods].filter((m) => m !== row.best);
    if (others.length) {
      console.log('  ' + pad + 'also saw: ' + others.join(', '));
    }

    if (row.copy) {
      const c = row.copy;
      const ok = c.method === 'clipboard';
      console.log('  ' + pad + '⎯');
      console.log('  ' + pad + 'Ctrl+C   ' + (ok ? 'PASS     ' : 'FAIL     ') +
        (ok ? c.length + ' chars in ' + c.ms + ' ms: "' + trim(c.text, 44) + '"' : c.method));
    }
  }

  const pass = rows.filter((r) => r.best === 'text-pattern');
  const copied = rows.filter((r) => r.copy && r.copy.method === 'clipboard');
  const tried = rows.filter((r) => r.copy);

  console.log('\n' + '-'.repeat(72));
  console.log('  UI Automation:  ' + pass.length + ' of ' + rows.length +
    ' applications returned a real selection.');
  if (tried.length) {
    console.log('  Ctrl+C:         ' + copied.length + ' of ' + tried.length + '.');
    // The whole point of measuring both: if the clipboard covers what the
    // accessibility tree misses, the gaps above stop being design constraints
    // and become a cheap fallback on a path that already stashes the clipboard.
    const rescued = rows.filter((r) => r.best !== 'text-pattern' &&
      r.copy && r.copy.method === 'clipboard');
    if (rescued.length) {
      console.log('  Rescued by the fallback: ' + rescued.map((r) => r.app).join(', '));
    }
  }
  if (pass.length < rows.length && !tried.length) {
    console.log('  Anything below PASS cannot be pointed at by highlighting, and');
    console.log('  would need the whole-control read plus a span match instead.');
  }
  console.log('');
}

/* --------------------------------------------------------------------- main */

async function main() {
  console.log('Starting the injection helper…');
  await start();

  console.log('\nProbing the foreground window for ' + SECONDS + ' s.');
  console.log('Alt-tab away NOW and highlight text in each app you care about —');
  console.log('Word, VS Code, Notepad, Obsidian, a browser. Pause a second on each.');
  console.log('Leave this console unfocused until it prints.');
  if (WITH_COPY) {
    console.log('\nWith --copy: one Ctrl+C is sent per application, ' +
      (ARM_AFTER_MS / 1000) + ' s after you');
    console.log('switch to it. Your clipboard is saved and put back.');
  }
  console.log('');

  const deadline = Date.now() + SECONDS * 1000;
  let last = '';

  // One clipboard test per application, fired a beat after that app comes
  // forward so there has been time to highlight something. Firing on every
  // poll would machine-gun Ctrl+C into whatever the user is working in.
  let armedApp = null;
  let armedAt = 0;

  while (Date.now() < deadline) {
    const started = Date.now();
    let r;
    try {
      r = await command('selection');
    } catch {
      break;   // helper died; the report still holds what was collected
    }
    const ms = Date.now() - started;

    if (r && r.process !== undefined) {
      record(r, ms);

      const app = (r.process || '').toLowerCase();
      if (WITH_COPY && app && !IGNORE.has(app)) {
        if (app !== armedApp) {
          armedApp = app;
          armedAt = Date.now();
        } else if (!seen.get(app).copy && Date.now() - armedAt > ARM_AFTER_MS) {
          try {
            const c = await command('copysel', 6000);
            rowFor(app).copy = c;
            console.log('  ' + app.padEnd(16) + 'Ctrl+C'.padEnd(28) +
              (c.method === 'clipboard'
                ? c.length + ' chars  "' + trim(c.text, 40) + '"'
                : c.method));
          } catch {
            rowFor(app).copy = { method: 'timed out', text: '', length: 0, ms: 0 };
          }
        }
      }

      // Echo only transitions. Polling at 700 ms would otherwise bury the
      // interesting moments under a hundred identical lines.
      const key = r.process + '|' + r.method + '|' + r.length;
      if (key !== last) {
        last = key;
        const app = (r.process || '?').toLowerCase();
        if (!IGNORE.has(app)) {
          console.log('  ' + app.padEnd(16) + r.method.padEnd(28) +
            (r.length ? r.length + ' chars  "' + trim(r.text, 40) + '"' : ''));
        }
      }
    }

    const rest = INTERVAL_MS - (Date.now() - started);
    if (rest > 0) await new Promise((res) => setTimeout(res, rest));
  }

  report();

  try {
    proc.stdin.end();
    proc.kill();
  } catch { /* already gone */ }
}

main().catch((err) => {
  console.error('\n' + String(err && err.message ? err.message : err));
  if (proc) {
    try { proc.kill(); } catch { /* already gone */ }
  }
  process.exit(1);
});
