'use strict';

/**
 * A stand-in for Typd in bench/app-update.js's install tests. On Windows it is node.exe renamed
 * Typd.exe and started with NODE_OPTIONS=--require <this file>; on macOS a tiny launcher in a fake
 * Typd.app execs node on it. It does with src/main/appUpdate.js what src/main/index.js does --
 * startup, the self-test verdict, the checks, the apply and the quit -- through the real updater
 * and the real helper script, with no Electron, model or window.
 *
 * Like Typd, it starts a "llama-server" from inside the app that outlives it by a few seconds, so
 * the helper has to wait for it before it can move the folder.
 *
 *   TYPD_FAKE_USERDATA      its userData folder
 *   TYPD_FAKE_KEYS_B64      base64 of the JSON {id: PEM} of keys it trusts
 *   TYPD_FAKE_CRASH         a version that quits right after saying it started
 *   TYPD_FAKE_MODEL_FAIL    a version whose model fails its self-test
 *   TYPD_APP_UPDATE_*       as in the app (URL, REPORT, SELFTEST_FAIL, FIRST_MS, EVERY_MS)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function main() {
  const mac = process.platform === 'darwin';
  // macOS: the launcher passes its own path (…/Typd.app/Contents/MacOS/Typd).
  const appDir = mac ? path.resolve(process.argv[2], '..', '..', '..') : path.dirname(process.execPath);
  const res = mac ? path.join(appDir, 'Contents', 'Resources') : path.join(appDir, 'resources');
  const { version } = JSON.parse(fs.readFileSync(path.join(res, 'fake.json'), 'utf8'));
  const userData = process.env.TYPD_FAKE_USERDATA;
  fs.mkdirSync(userData, { recursive: true });
  const log = (...a) => fs.appendFileSync(path.join(userData, 'fake.log'), `${new Date().toISOString()} ${version} [${process.pid}] ${a.join(' ')}\n`);
  log('started at', appDir);

  const llama = mac ? path.join(res, 'llama', 'llama-server') : path.join(res, 'llama', 'llama-server.exe');
  if (fs.existsSync(llama)) {
    const child = spawn(llama, mac ? ['4'] : ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log('fake llama-server:', e.message));
  }

  const { createAppUpdater } = require('../src/main/appUpdate');
  const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
  const u = createAppUpdater({
    keys: JSON.parse(Buffer.from(process.env.TYPD_FAKE_KEYS_B64, 'base64').toString('utf8')),
    appVersion: version,
    platform: `${process.platform}-${process.arch}`,
    dir: path.join(userData, 'app-update'),
    endpoint: process.env.TYPD_APP_UPDATE_URL,
    app: appDir,
    rate: 0, idleMs: 300, systemIdleS: 0,
    firstCheckMs: env('TYPD_APP_UPDATE_FIRST_MS', 300), everyMs: env('TYPD_APP_UPDATE_EVERY_MS', 2000),
    startedTimeoutS: 30, verdictTimeoutS: 40, resultWaitMs: 40e3,
    quit: () => { log('quitting for the update'); setTimeout(() => process.exit(0), 200); },
    log: (...a) => log(...a.map(String)),
    failVersion: process.env.TYPD_APP_UPDATE_SELFTEST_FAIL || null,
    reportFile: process.env.TYPD_APP_UPDATE_REPORT || null,
    reportExtra: () => ({ fake: true, app: appDir })
  });
  const s = u.startup();
  if (s.postUpdate) {
    if (process.env.TYPD_FAKE_CRASH === version) { log('crashing on purpose'); setTimeout(() => process.exit(3), 300); return; }
    setTimeout(() => {
      u.settle({ windowOk: true, modelOk: process.env.TYPD_FAKE_MODEL_FAIL !== version, why: 'fake model failure' })
        .then((v) => { log('self-test verdict', v); if (v === 'failed') setTimeout(() => process.exit(1), 300); });
    }, 300);
  }
  u.start();
  setInterval(() => {}, 1 << 30);
}

// Windows: the fake llama-server is node.exe too, and gets NODE_OPTIONS; it only lingers.
if (!/llama-server/i.test(path.basename(process.execPath))) {
  try { main(); } catch (err) {
    try { fs.appendFileSync(path.join(process.env.TYPD_FAKE_USERDATA || '.', 'fake.log'), 'fake crashed: ' + (err && err.stack) + '\n'); } catch { /* nowhere to say it */ }
    process.exit(5);
  }
}
