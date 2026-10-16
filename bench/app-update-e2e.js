'use strict';

/**
 * App updates end to end on real builds: the Mac CI's test (.github/workflows/mac.yml, job
 * "app-update"), and a local update server for trying one by hand (README "App updates").
 *
 *   node bench/app-update-e2e.js key
 *       A throwaway Ed25519 key: the private half to $RUNNER_TEMP (or the temp folder)/app-update-ci.pem,
 *       the public half into src/main/appUpdateKey.js, so builds made after it trust it and nothing
 *       else. Never the real key (put appUpdateKey.js back with git checkout); nothing is published.
 *
 *   node bench/app-update-e2e.js serve <packages dir> [port]
 *       Serve the newest update package in <packages dir> (scripts/app-update-package.js), with a
 *       manifest signed by that throwaway key, on 127.0.0.1 (port 8749 by default), until Ctrl+C.
 *       A build made after `key`, started with TYPD_APP_UPDATE_URL=http://127.0.0.1:<port>, updates
 *       itself from it.
 *
 *   node bench/app-update-e2e.js run <A.app> <packages dir>          (macOS)
 *       <packages dir> holds B's and C's update packages.
 *       1. Install A in a temp folder, serve B's signed manifest on 127.0.0.1, start A with fast
 *          timers and no input threshold, as nobody is at a CI runner's keyboard. The consent
 *          screen counts as answered (share "off" in settings.json, unless already answered).
 *       2. Wait until A has updated itself to B: B relaunched by the helper through `open`, passed
 *          its start-up self-test (the model's included), reports its version, shows no window and
 *          no Dock icon, has its menu-bar item, is validly signed, has no quarantine mark, runs its
 *          own llama-server, and nothing is left next to it. From 0.2.2 (docs/MAC.md "Code
 *          signing"): B is installed exactly as CI signed it -- no model inside, nothing carried,
 *          not signed again -- and A's model was kept for it in <userData>/carried/ (carried.js);
 *          A, B, C and the installed app after the swap have ONE designated requirement, naming
 *          Typd's certificate (scripts/mac-signing.json) when the builds were signed with it.
 *          With TYPD_E2E_TCC=1 (the runner's TCC.db is writable): A is granted Accessibility by
 *          its designated requirement before it starts, and B, relaunched as its own app, must be
 *          trusted by that grant -- the privacy switches survive the update.
 *       3. Publish C, which fails its self-test (TYPD_APP_UPDATE_SELFTEST_FAIL, passed on to every
 *          relaunch), and wait until B is back, running, and remembers C as failed. With
 *          TYPD_E2E_TCC=1 the grant is first changed to name another certificate: the B that comes
 *          back must NOT be trusted (the check above tells the two apart).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'app-update-ci.pem');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail !== undefined && !ok ? '   ' + JSON.stringify(detail).slice(0, 800) : ''));
}

function key() {
  const kp = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY_FILE, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const kid = 'ci-' + crypto.randomBytes(4).toString('hex');
  const pem = kp.publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(ROOT, 'src', 'main', 'appUpdateKey.js'),
    "'use strict';\n\n// A throwaway key for an app-update test (bench/app-update-e2e.js key). Never committed.\n" +
    `module.exports = { keys: { ${JSON.stringify(kid)}: ${JSON.stringify(pem)} } };\n`);
  console.log(`throwaway app-update key ${kid}: private half in ${KEY_FILE}, public half in src/main/appUpdateKey.js`);
}

/** `codesign -d -r-`: the designated requirement, or null. */
function designated(app) {
  const r = sh('codesign', ['-d', '-r-', app]);
  const m = /designated => (.+)/.exec((r.stdout || '') + (r.stderr || ''));
  return m ? m[1].trim() : null;
}

const SYS_TCC = '/Library/Application Support/com.apple.TCC/TCC.db';
/** Grant ai.typd.app Accessibility in the runner's TCC.db for code that satisfies `requirement`. */
function grantAx(requirement, dir) {
  const bin = path.join(dir, 'ax.csreq');
  const c = sh('csreq', ['-r=' + requirement, '-b', bin]);
  if (c.status !== 0) return 'csreq: ' + c.stderr;
  const hex = fs.readFileSync(bin).toString('hex');
  const sql = "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags, last_modified) " +
    `VALUES ('kTCCServiceAccessibility', 'ai.typd.app', 0, 2, 4, 1, X'${hex}', 0, ${Math.floor(Date.now() / 1000)});`;
  const r = sh('sudo', ['sqlite3', SYS_TCC, sql]);
  return r.status === 0 ? null : 'sqlite3: ' + r.stderr;
}

const plistVersion = (app) => sh('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).stdout.trim();
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pids = (pattern) => sh('pgrep', ['-f', pattern]).stdout.split('\n').filter(Boolean).map(Number);

/** The packages in `pkgDir`, oldest first, and a server that offers one of them, signed. */
async function localServer(pkgDir, port = 0) {
  const priv = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const keys = require(path.join(ROOT, 'src', 'main', 'appUpdateKey.js')).keys;
  const kid = Object.keys(keys)[0];
  const recs = fs.readdirSync(pkgDir).filter((n) => /-update-(mac|win)-(arm64|x64)\.zip\.json$/.test(n)).map((n) => readJson(path.join(pkgDir, n)))
    .sort((a, b) => a.version.localeCompare(b.version, 'en', { numeric: true }));
  let manifest = null, seq = Math.floor(Date.now() / 1000);
  const requests = [];
  const publish = (rec) => {
    const payload = {
      schema: 1, seq: ++seq, version: rec.version, min_version: '0.0.1', downgrade: false, notes: 'test', published_at: new Date().toISOString(),
      platforms: { [rec.platform]: { file: rec.file, size: rec.size, sha256: rec.sha256, app: rec.app, carry: rec.carry, ...(rec.requires ? { requires: rec.requires } : {}) } }
    };
    const text = JSON.stringify(payload);
    manifest = JSON.stringify({ typd_app_update: 1, key: kid, payload: text, sig: crypto.sign(null, Buffer.from(text), priv).toString('base64') });
  };
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/v1/app/manifest') {
      if (!manifest) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(manifest);
    }
    const m = /^\/v1\/app\/file\/([^/]+)\/([^/]+)$/.exec(req.url);
    const rec = m && recs.find((r) => r.version === m[1] && r.file === decodeURIComponent(m[2]));
    if (!rec) { res.writeHead(404); return res.end(); }
    const file = path.join(pkgDir, rec.file);
    const size = fs.statSync(file).size;
    const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = r ? Number(r[1]) : 0;
    res.writeHead(r ? 206 : 200, { 'Content-Length': String(size - start), 'Accept-Ranges': 'bytes', ...(r ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}) });
    fs.createReadStream(file, { start }).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { recs, publish, requests, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function serve(pkgDir, port) {
  const s = await localServer(pkgDir, port);
  if (!s.recs.length) throw new Error('no update packages (Typd-<v>-update-*.zip and .json) in ' + pkgDir);
  const rec = s.recs[s.recs.length - 1];
  s.publish(rec);
  console.log(`serving Typd ${rec.version} (${rec.platform}, ${rec.file}) at ${s.endpoint}, signed with the throwaway key`);
  console.log(`start the installed app with TYPD_APP_UPDATE_URL=${s.endpoint} (README "App updates", by hand); Ctrl+C stops`);
  let seen = 0;
  setInterval(() => { for (; seen < s.requests.length; seen++) console.log(`  ${new Date().toISOString()} GET ${s.requests[seen]}`); }, 1000);
}

async function run(aApp, pkgDir) {
  const srv = await localServer(pkgDir);
  const recs = srv.recs.filter((r) => r.platform.startsWith('darwin'));
  if (recs.length !== 2) throw new Error('expected two macOS update packages (B and C) in ' + pkgDir);
  const [B, C] = recs;
  const A = plistVersion(aApp);
  console.log(`A ${A} (installed), B ${B.version} (published first), C ${C.version} (fails its self-test)`);
  const { publish, requests, endpoint } = srv;
  const server = srv;

  const T = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'typd-update-'));
  const apps = path.join(T, 'Applications');
  const APP = path.join(apps, 'Typd.app');
  fs.mkdirSync(apps);
  sh('ditto', [aApp, APP]);
  const report = path.join(T, 'report.json');
  const userData = path.join(os.homedir(), 'Library', 'Application Support', 'typd');
  const dir = path.join(userData, 'app-update');
  // A person who has used Typd has answered the public beta's consent screen (sharing.js). A fresh
  // runner has not: the screen would open, hold the update back (a Typd window is open, so busy)
  // and be the window B must not show. Answered "off" here, as that person might have.
  {
    const f = path.join(userData, 'settings.json');
    const saved = readJson(f) || {};
    if (saved.share !== 'on' && saved.share !== 'off') {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ ...saved, share: 'off' }, null, 2));
      console.log('the consent screen answered "off" in ' + f);
    }
  }
  // One code identity for every build (docs/MAC.md "Code signing").
  const drA = designated(APP), drB = B.signature && B.signature.designated, drC = C.signature && C.signature.designated;
  const identity = (process.env.TYPD_MAC_SIGN_IDENTITY || '').toLowerCase();
  console.log(`designated requirements:\n  A (installed) ${drA}\n  B (package)   ${drB}\n  C (package)   ${drC}`);
  check('A, B and C (three builds) have the same designated requirement', Boolean(drA) && drA === drB && drA === drC, { drA, drB, drC });
  if (identity) {
    const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'mac-signing.json'), 'utf8')).sha1;
    check(`... naming ai.typd.app and Typd's certificate (${want.slice(0, 8)}, scripts/mac-signing.json)`,
      Boolean(drA) && drA.includes('identifier "ai.typd.app"') && drA.toLowerCase().includes(want) && identity === want, drA);
  }
  check('the macOS packages carry nothing (installed exactly as signed)', Array.isArray(B.carry) && B.carry.length === 0 && Array.isArray(C.carry) && C.carry.length === 0, { b: B.carry, c: C.carry });
  const tcc = process.env.TYPD_E2E_TCC === '1' && drA;
  if (tcc) {
    const bad = grantAx(drA, T);
    check("the runner's TCC.db grants ai.typd.app Accessibility for A's designated requirement", !bad, bad);
  }

  const env = {
    ...process.env, TYPD_DEBUG: '1', TYPD_APP_UPDATE_URL: endpoint, TYPD_APP_UPDATE_REPORT: report,
    TYPD_APP_UPDATE_FIRST_MS: '3000', TYPD_APP_UPDATE_EVERY_MS: '10000', TYPD_APP_UPDATE_IDLE_MS: '2000',
    TYPD_APP_UPDATE_SYSTEM_IDLE_S: '0', TYPD_APP_UPDATE_RATE: '0', TYPD_APP_UPDATE_SELFTEST_FAIL: C.version,
    TYPD_APP_UPDATE_STDOUT: path.join(T, 'relaunched.log'),
    // A build without a key follows the public model routes (modelUpdate.js): not from a test. Every
    // TYPD_* variable is passed on to the relaunched versions.
    TYPD_NO_MODEL_UPDATE: '1'
  };
  const logs = () => {
    for (const [name, f] of [['report', report], ['helper.log', path.join(dir, 'helper.log')], ['A (first launch)', path.join(T, 'a.log')], ['relaunched', path.join(T, 'relaunched.log')]]) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { text = '(none)'; }
      const lines = text.split('\n');
      console.log(`\n--- ${name} (${f}) ---\n` + (name.startsWith('A') || name === 'relaunched' ? lines.filter((l) => /app-update|typd:local\] (self-test|path chosen|model)|error|Error/i.test(l)).slice(-60) : lines.slice(-60)).join('\n'));
    }
  };
  async function waitFor(what, pred, ms) {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < ms) {
      const r = readJson(report);
      if (r && pred(r)) { console.log(`  ${what}: after ${((Date.now() - t0) / 1000).toFixed(0)} s`); return r; }
      const now = r ? `${r.version} ${r.state} ${(r.line && r.line.label) || ''}` : 'no report yet';
      if (now !== last) { console.log(`    [${((Date.now() - t0) / 1000).toFixed(0)} s] ${now}`); last = now; }
      await sleep(1000);
    }
    return readJson(report);
  }
  const leftovers = () => fs.readdirSync(apps).filter((n) => n !== 'Typd.app');

  try {
    publish(B);
    const out = fs.openSync(path.join(T, 'a.log'), 'a');
    const a = spawn(path.join(APP, 'Contents', 'MacOS', 'Typd'), [], { env, stdio: ['ignore', out, out], detached: true });
    a.unref();
    console.log(`\nA started (${a.pid}); serving B's signed manifest at ${endpoint}`);

    let r = await waitFor('B reports after the update', (x) => x.version === B.version && x.state === 'updated', 8 * 60e3);
    console.log('\nA -> B');
    check(`B (${B.version}) is running and reports "Updated to ${B.version}"`, r && r.version === B.version && r.state === 'updated' && r.line && r.line.label === `Updated to ${B.version}`, r);
    check('it was the first start of B, and its start-up self-test passed', r && r.settled === true && r.updated && r.updated.from === A, r);
    check('no window on screen, no Dock icon, the menu-bar item is there', r && Array.isArray(r.windows) && r.windows.length === 0 && r.dock === false && r.tray === true, r);
    check('the installed bundle is B', plistVersion(APP) === B.version, plistVersion(APP));
    const main = pids(`^${rx(APP)}/Contents/MacOS/Typd`);
    check('the process running from it is the one that reported', r && main.includes(r.pid), { main, pid: r && r.pid });
    check('B runs its own llama-server, from inside the new bundle', pids(`^${rx(APP)}/Contents/Resources/llama/llama-server`).length === 1);
    const kept = path.join(userData, 'carried', 'models', 'typd-dictate');
    const spec = readJson(path.join(kept, 'model.json'));
    check('B is installed exactly as signed: no model inside the bundle (nothing carried into it)', !fs.existsSync(path.join(APP, 'Contents', 'Resources', 'models')));
    check("A's model was kept for B in <userData>/carried/ (carried.js), and B's self-test passed on it", spec && fs.existsSync(path.join(kept, spec.model)) && r && r.settled === true, spec);
    const cs = sh('codesign', ['--verify', '--deep', '--strict', APP]);
    check('B is validly signed (codesign --verify --deep --strict)', cs.status === 0, cs.stderr);
    const drSwap = designated(APP);
    console.log(`  installed after the swap: ${drSwap}`);
    check("after the helper's swap the installed app has A's designated requirement (the same code identity)", Boolean(drSwap) && drSwap === drA, { drSwap, drA });
    if (tcc) check("B, started as its own app, is trusted for Accessibility by A's grant (the switch survived the update)", r && r.ax === true, r && r.ax);
    check('no quarantine mark on B', sh('xattr', ['-p', 'com.apple.quarantine', APP]).status !== 0);
    check('nothing left next to it (no backup, no staging copy)', leftovers().length === 0, leftovers());
    const helper = fs.readFileSync(path.join(dir, 'helper.log'), 'utf8');
    check('the helper reported ok, and started B through open', /result: ok/.test(helper) && /started /.test(helper) && !/open failed/.test(helper), helper.slice(-1500));
    check('app-update/ cleaned up (no pending.json, verdict, staged version)', !fs.existsSync(path.join(dir, 'pending.json')) && !fs.existsSync(path.join(dir, B.version)), fs.readdirSync(dir));

    console.log('\nB -> C, which fails its self-test');
    if (tcc) {
      // The control: a grant for another certificate. The B that comes back must not be trusted.
      const bad = grantAx('identifier "ai.typd.app" and certificate leaf = H"' + '0'.repeat(40) + '"', T);
      check('the grant now names another certificate (the control)', !bad, bad);
    }
    const before = requests.length;
    publish(C);
    r = await waitFor('B is back and remembers C', (x) => x.version === B.version && x.state === 'failed' && x.bad && x.bad.version === C.version, 8 * 60e3);
    check(`C (${C.version}) was downloaded`, requests.slice(before).some((u) => u.includes(C.file)), requests.slice(before));
    check(`B is back, running, and remembers C as failed`, r && r.version === B.version && r.state === 'failed' && r.bad && r.bad.version === C.version && /self-test/.test(r.bad.why), r);
    check('the installed bundle is B again, as signed (no model inside), validly signed, with the same designated requirement', plistVersion(APP) === B.version &&
      !fs.existsSync(path.join(APP, 'Contents', 'Resources', 'models')) && sh('codesign', ['--verify', '--deep', '--strict', APP]).status === 0 && designated(APP) === drA, designated(APP));
    check("the kept model is still there for B", fs.existsSync(path.join(userData, 'carried', 'models', 'typd-dictate', 'model.json')));
    if (tcc) check('the B that came back is NOT trusted by a grant for another certificate (the check tells them apart)', r && r.ax === false, r && r.ax);
    check('the process running from it is the one that reported', r && pids(`^${rx(APP)}/Contents/MacOS/Typd`).includes(r.pid));
    check('nothing left next to it', leftovers().length === 0, leftovers());
    check('no window on screen after the rollback either', r && r.windows && r.windows.length === 0, r);
    const n = requests.length;
    await sleep(25e3);
    check('the same manifest is not downloaded again (two more checks)', !requests.slice(n).some((u) => u.includes('/v1/app/file/')), requests.slice(n));
  } finally {
    logs();
    sh('pkill', ['-f', `^${rx(APP)}/`]);
    server.close();
  }
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'key') return key();
  if (cmd === 'serve') { await serve(path.resolve(rest[0]), Number(rest[1] || 8749)); return; }
  if (cmd === 'run') { await run(path.resolve(rest[0]), path.resolve(rest[1])); return; }
  console.error('usage: app-update-e2e.js key | serve <packages dir> [port] | run <A.app> <packages dir>');
  process.exit(2);
})().then(() => {
  if (process.argv[2] === 'run') {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  }
}, (e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
