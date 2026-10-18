'use strict';

/**
 * The first-run walkthrough is for fresh installs only (the user's rule, 0.2.4): an update -- from
 * 0.2.3, 0.2.2 or 0.2.0, on a Mac or Windows -- and any install that ran Typd before must never see
 * it, nor any other first-run window.
 *
 *   node bench/first-launch.js
 *
 * Each case is a user-data folder as an earlier Typd left it (settings.json as that version wrote
 * it, history, a model downloaded or carried over, app-update state, kept recordings), started
 * the way index.js starts: settings.isFreshInstall() before anything is written, isFirstRun(), then
 * settings.walkthroughFor() into settings. Run in a child process per case with the real
 * settings.js and a stand-in for Electron's app (paths into a temp folder), so nothing is shared
 * between cases. index.js's own use of it is checked in bench/model-choice.js (source checks), and
 * on a real Mac by mac.yml ("An update opens no window", scripts/mac-first-launch-check.sh).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

if (process.argv[2] === '--case') {
  // The child: one launch.
  const c = JSON.parse(process.argv[3]);
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (k) => (k === 'appData' ? c.appData : k === 'userData' ? c.userData : path.join(c.appData, '_' + k)),
          isPackaged: true,
          getVersion: () => c.version || '0.2.4'
        }
      };
    }
    return realLoad.apply(this, arguments);
  };
  const settings = require(path.join(root, 'src', 'main', 'settings'));
  const fresh = settings.isFreshInstall();           // index.js: first, before anything is written
  settings.isFirstRun();
  const now = settings.walkthroughFor({ fresh, afterUpdate: Boolean(c.afterUpdate) });
  if (now !== settings.get('walkthrough')) settings.set('walkthrough', now);
  const saved = JSON.parse(fs.readFileSync(path.join(c.appData, 'typd', 'settings.json'), 'utf8'));
  process.stdout.write(JSON.stringify({ fresh, now, saved: saved.walkthrough }));
  process.exit(0);
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')'));
  if (!ok) failures++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'typd-first-launch-'));
let n = 0;

/** A user-data folder as an earlier Typd left it. */
function folder(files) {
  const appData = path.join(TMP, String(++n));
  const userData = path.join(appData, 'typd');
  fs.mkdirSync(userData, { recursive: true });
  for (const [rel, body] of Object.entries(files || {})) {
    const p = path.join(appData, rel);
    if (rel.endsWith('/')) { fs.mkdirSync(p, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { appData, userData };
}

/** One launch of 0.2.4 (or `version`) on that folder. */
function launch(dirs, afterUpdate, version) {
  const out = execFileSync(process.execPath, [__filename, '--case', JSON.stringify({ ...dirs, afterUpdate, version })], { encoding: 'utf8' });
  return JSON.parse(out);
}

// settings.json as each version wrote it (the keys it knew).
const S020 = { hotkey: 'RightCommand', sounds: true, mic: '', micLabel: '', keepRecordings: true, startAtLogin: true, showInDock: false };
const S022 = { ...S020, share: '', sharePaused: false, flagHotkey: '' };
const S023 = { ...S022, modelVariant: 'auto', askBeforeModelDownload: false, walkthrough: 'done' };
const HISTORY = { 'typd/history.json': { keep: 'forever', items: [] } };
const MODEL = { 'typd/models/': '', 'typd/models/current.json': { version: 'r24_1p7b_rev128' } };
const CARRIED = { 'typd/carried/': '' };
const UPDATED = { 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.3', to: '0.2.4' } };

console.log('\nfirst launch of 0.2.4: the walkthrough only on a fresh install');

let r = launch(folder({}), false);
check('a fresh install: due, once', r.fresh === true && r.now === 'due' && r.saved === 'due', r);

r = launch(folder({ 'typd/settings.json': S023, ...HISTORY, ...MODEL, ...UPDATED }), true);
check('update from 0.2.3 (walkthrough done, a model, history): never', r.fresh === false && r.now === 'done' && r.saved === 'done', r);

r = launch(folder({ 'typd/settings.json': { ...S023, walkthrough: '' }, ...HISTORY, ...MODEL, ...UPDATED }), true);
check('update from 0.2.3 that never showed it (walkthrough \'\'): never', r.now === 'done' && r.saved === 'done', r);

r = launch(folder({ 'typd/settings.json': S022, ...HISTORY, ...CARRIED, ...UPDATED }), true);
check('update from 0.2.2 (no walkthrough setting yet, model carried over): never', r.fresh === false && r.now === 'done', r);

r = launch(folder({ 'typd/settings.json': S020, ...HISTORY }), true);
check('update from 0.2.0 (the oldest settings): never', r.fresh === false && r.now === 'done', r);

r = launch(folder({ 'typd/settings.json': S022 }), false);
check('Windows: 0.2.4 installed over 0.2.2 by the installer (not an app update, settings only): never', r.fresh === false && r.now === 'done', r);

r = launch(folder({ 'Typd/recordings/2026-10-01.wav': 'RIFF' }), false);
check('no settings but kept recordings (Typd ran here before): never', r.fresh === false && r.now === 'done', r);

r = launch(folder({ ...MODEL }), false);
check('no settings but a downloaded model: never', r.fresh === false && r.now === 'done', r);

r = launch(folder({ 'typd/settings.json': { ...S023, walkthrough: 'due' } }), false);
check('a fresh install whose first launch ended before it showed: still due', r.now === 'due', r);

r = launch(folder({ 'typd/settings.json': { ...S023, walkthrough: 'due' }, ...UPDATED }), true);
check('... but an update arriving first ends that: never', r.now === 'done', r);

r = launch(folder({}), true);
check("an update's first start, even with nothing else here: never", r.now === 'done', r);

// 0.2.5 (the CUDA pack): an update from 0.2.4 -- settings as 0.2.4 wrote them, its model, the app
// update's pending.json; on Windows the CUDA backend is carried in the app folder, not in userData, so
// it changes nothing here -- never shows the walkthrough either.
const S024 = { ...S023, share: 'on', walkthrough: 'done' };
r = launch(folder({ 'typd/settings.json': S024, ...HISTORY, ...MODEL, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.4', to: '0.2.5' } }), true, '0.2.5');
check('0.2.5: update from 0.2.4 (walkthrough done, a model, the app update pending): never', r.fresh === false && r.now === 'done' && r.saved === 'done', r);
r = launch(folder({ 'typd/settings.json': { ...S024, walkthrough: 'due' }, ...MODEL, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.4', to: '0.2.5' } }), true, '0.2.5');
check('0.2.5: update from a 0.2.4 install that never got to show it: never', r.now === 'done', r);
r = launch(folder({ 'typd/settings.json': S024, ...MODEL }), false, '0.2.5');
check('0.2.5 installed over 0.2.4 by the installer (settings and a model kept): never', r.fresh === false && r.now === 'done', r);
r = launch(folder({}), false, '0.2.5');
check('0.2.5, a fresh install: due', r.fresh === true && r.now === 'due', r);

{
  // A fresh install's next launches: due until it is shown, then done for good.
  const d = folder({});
  launch(d, false);
  r = launch(d, false);
  check('fresh, second launch before it showed: due', r.fresh === false && r.now === 'due', r);
  const f = path.join(d.appData, 'typd', 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), walkthrough: 'done' }));
  r = launch(d, false);
  check('once shown (done): never again', r.now === 'done', r);
}

{
  // index.js asks before anything of this launch is written.
  const idx = fs.readFileSync(path.join(root, 'src', 'main', 'index.js'), 'utf8');
  const at = (s) => idx.indexOf(s);
  check('index.js: isFreshInstall() first, then isFirstRun(), the overlay and the model updater',
    at('settings.isFreshInstall();') > 0 && at('settings.isFreshInstall();') < at('firstRunNote = settings.isFirstRun();') &&
    at('settings.isFreshInstall();') < at('if (!stub) startAppUpdate();') && at('settings.isFreshInstall();') < at('modelUpdate.start({'));
  const due = (idx.match(/function walkthroughDue\(\) \{[\s\S]*?\n\}/) || [''])[0];
  check("index.js: shows it only when settings say 'due'", /settings\.get\('walkthrough'\) === 'due'/.test(due));
  const opens = idx.split('\n').filter((l) => /walkthrough: true/.test(l));
  check('index.js: one place opens the walkthrough, inside startWalkthrough', opens.length === 1 && /home\.open\('home', \{ walkthrough: true/.test(opens[0]));
  // 0.2.0-0.2.3 read 'due' as 'done' (anything but '' and 'done'), so going back a version never shows it either.
  check("settings: 'due' is a value it keeps; anything unknown reads as 'done'",
    /\['', 'due', 'done'\]\.includes\(cache\.walkthrough\)\) cache\.walkthrough = 'done'/.test(fs.readFileSync(path.join(root, 'src', 'main', 'settings.js'), 'utf8')));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (failures ? failures + ' FAILED' : 'all first-launch checks passed') + '\n');
process.exit(failures ? 1 : 0);
