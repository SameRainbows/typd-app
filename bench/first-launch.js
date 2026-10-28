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
 *
 * Sharing (0.2.12, settings.js shareRule): a fresh install is asked on the walkthrough ('ask'); an
 * 'on' is kept only when a person's choice set it (shareChosen, recorded by settings.set with
 * 'share'). An earlier Typd's 'on', '' or no value -- 0.2.4-0.2.6's default, or the 'on' 0.2.7-0.2.11
 * kept for installs first started before 2026-10-18 15:00 UTC -- is asked once in the small screen
 * ('ask', shareAsk 'due'), however old the install; 'off' stays off; once decided it is kept (a
 * second launch, an answer).
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
  const atLaunch = { share: settings.get('share'), shareAsk: settings.get('shareAsk'), shareChosen: settings.get('shareChosen') };
  // A person's answer this launch, as sharing.js sets it (the walkthrough, the small screen, Settings).
  const answered = c.answer ? settings.set('share', c.answer) : null;
  const refused = settings.set('shareChosen', true);   // never set on its own
  const saved = JSON.parse(fs.readFileSync(path.join(c.appData, 'typd', 'settings.json'), 'utf8'));
  process.stdout.write(JSON.stringify({ fresh, now, saved: saved.walkthrough, ...atLaunch, answered, refused,
    savedShare: saved.share, savedShareAsk: saved.shareAsk, savedShareChosen: saved.shareChosen }));
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

/** One launch of 0.2.4 (or `version`) on that folder; `answer`: 'on' or 'off' chosen during it. */
function launch(dirs, afterUpdate, version, answer) {
  const out = execFileSync(process.execPath, [__filename, '--case', JSON.stringify({ ...dirs, afterUpdate, version, answer })], { encoding: 'utf8' });
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

// 0.2.6: an update from 0.2.5 -- a model-less install whose model (and maybe the CUDA pack, in userData)
// arrived after its first start, sharing on by default -- never shows it; a fresh 0.2.6 install does.
const S025 = { ...S024 };
const PACK = { 'typd/cuda/': '' };
r = launch(folder({ 'typd/settings.json': S025, ...HISTORY, ...MODEL, ...PACK, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.5', to: '0.2.6' } }), true, '0.2.6');
check('0.2.6: update from 0.2.5 (walkthrough done, a downloaded model and pack, the app update pending): never', r.fresh === false && r.now === 'done' && r.saved === 'done', r);
r = launch(folder({ 'typd/settings.json': { ...S025, walkthrough: 'due' }, ...MODEL, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.5', to: '0.2.6' } }), true, '0.2.6');
check('0.2.6: update from a 0.2.5 install that never got to show it: never', r.now === 'done', r);
r = launch(folder({ 'typd/settings.json': S025, ...MODEL }), false, '0.2.6');
check('0.2.6 installed over 0.2.5 by the installer (settings and a model kept): never', r.fresh === false && r.now === 'done', r);
r = launch(folder({}), false, '0.2.6');
check('0.2.6, a fresh install: due', r.fresh === true && r.now === 'due', r);

// 0.2.9: an update from 0.2.8 (Windows; sharing answered or on, a model and maybe the pack), and on a Mac
// from 0.2.6 or 0.2.7 straight to 0.2.9 -- never the walkthrough; a fresh 0.2.9 install: due.
const S028 = { ...S025, share: 'on', shareAsk: 'done', lowMemory: 'auto' };
for (const from of ['0.2.8', '0.2.7', '0.2.6']) {
  r = launch(folder({ 'typd/settings.json': S028, ...HISTORY, ...MODEL, ...PACK, 'typd/app-update/': '', 'typd/app-update/pending.json': { from, to: '0.2.9' } }), true, '0.2.9');
  check(`0.2.9: update from ${from} (walkthrough done, a downloaded model, the app update pending): never`, r.fresh === false && r.now === 'done' && r.saved === 'done', r);
}
r = launch(folder({ 'typd/settings.json': { ...S028, walkthrough: 'due' }, ...MODEL, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.8', to: '0.2.9' } }), true, '0.2.9');
check('0.2.9: update from a 0.2.8 install that never got to show it: never', r.now === 'done', r);
r = launch(folder({ 'typd/settings.json': S028, ...MODEL }), false, '0.2.9');
check('0.2.9 installed over 0.2.8 by the installer (settings and a model kept): never', r.fresh === false && r.now === 'done', r);
r = launch(folder({}), false, '0.2.9');
check('0.2.9, a fresh install: due', r.fresh === true && r.now === 'due', r);

// 0.2.10 (the copy pop-up): an update from 0.2.9 -- and on a Mac or Windows from 0.2.8 or earlier if 0.2.9
// was skipped -- never the walkthrough; installed over 0.2.9 by the installer: never; a fresh install: due.
for (const from of ['0.2.9', '0.2.8', '0.2.6']) {
  r = launch(folder({ 'typd/settings.json': S028, ...HISTORY, ...MODEL, ...PACK, 'typd/app-update/': '', 'typd/app-update/pending.json': { from, to: '0.2.10' } }), true, '0.2.10');
  check(`0.2.10: update from ${from} (walkthrough done, a downloaded model, the app update pending): never`, r.fresh === false && r.now === 'done' && r.saved === 'done', r);
}
r = launch(folder({ 'typd/settings.json': { ...S028, walkthrough: 'due' }, ...MODEL, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.9', to: '0.2.10' } }), true, '0.2.10');
check('0.2.10: update from a 0.2.9 install that never got to show it: never', r.now === 'done', r);
r = launch(folder({ 'typd/settings.json': S028, ...MODEL }), false, '0.2.10');
check('0.2.10 installed over 0.2.9 by the installer (settings and a model kept): never', r.fresh === false && r.now === 'done', r);
r = launch(folder({}), false, '0.2.10');
check('0.2.10, a fresh install: due', r.fresh === true && r.now === 'due', r);

// 0.2.11 (the first-run hotfix): an update from 0.2.10 -- or from 0.2.9 / 0.2.8 if 0.2.10 was skipped --
// never the walkthrough; installed over 0.2.10 by the installer: never; a fresh install: due.
for (const from of ['0.2.10', '0.2.9', '0.2.8']) {
  r = launch(folder({ 'typd/settings.json': S028, ...HISTORY, ...MODEL, ...PACK, 'typd/app-update/': '', 'typd/app-update/pending.json': { from, to: '0.2.11' } }), true, '0.2.11');
  check(`0.2.11: update from ${from} (walkthrough done, a downloaded model, the app update pending): never`, r.fresh === false && r.now === 'done' && r.saved === 'done', r);
}
r = launch(folder({ 'typd/settings.json': { ...S028, walkthrough: 'due' }, ...MODEL, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.10', to: '0.2.11' } }), true, '0.2.11');
check('0.2.11: update from a 0.2.10 install that never got to show it: never', r.now === 'done', r);
r = launch(folder({ 'typd/settings.json': S028, ...MODEL }), false, '0.2.11');
check('0.2.11 installed over 0.2.10 by the installer (settings and a model kept): never', r.fresh === false && r.now === 'done', r);
r = launch(folder({}), false, '0.2.11');
check('0.2.11, a fresh install: due', r.fresh === true && r.now === 'due', r);

// 0.2.12 (the native microphone helper): an update from 0.2.11 -- or from 0.2.10 / 0.2.9 if 0.2.11 was
// skipped -- never the walkthrough; installed over 0.2.11 by the installer: never; a fresh install: due.
for (const from of ['0.2.11', '0.2.10', '0.2.9']) {
  r = launch(folder({ 'typd/settings.json': S028, ...HISTORY, ...MODEL, ...PACK, 'typd/app-update/': '', 'typd/app-update/pending.json': { from, to: '0.2.12' } }), true, '0.2.12');
  check(`0.2.12: update from ${from} (walkthrough done, a downloaded model, the app update pending): never`, r.fresh === false && r.now === 'done' && r.saved === 'done', r);
}
r = launch(folder({ 'typd/settings.json': { ...S028, walkthrough: 'due' }, ...MODEL, 'typd/app-update/': '', 'typd/app-update/pending.json': { from: '0.2.11', to: '0.2.12' } }), true, '0.2.12');
check('0.2.12: update from a 0.2.11 install that never got to show it: never', r.now === 'done', r);
r = launch(folder({ 'typd/settings.json': S028, ...MODEL }), false, '0.2.12');
check('0.2.12 installed over 0.2.11 by the installer (settings and a model kept): never', r.fresh === false && r.now === 'done', r);
r = launch(folder({}), false, '0.2.12');
check('0.2.12, a fresh install: due', r.fresh === true && r.now === 'due', r);

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

console.log('\nsharing at the first launch of 0.2.12: every install that never chose is asked; a choice stays');
{
  const S026 = { ...S024, lowMemory: 'auto' };   // 0.2.6 wrote share 'on' -- its default, not an answer
  const BEFORE = { 'Typd/recordings/2026-10-17T09-12-03-120Z.wav': 'RIFF' };   // kept a day before 0.2.7's cutoff (2026-10-18 15:00 UTC)
  const settled = (x, share, ask) => x.share === share && x.shareAsk === ask && x.savedShare === share && x.savedShareAsk === ask;
  const asked = (x) => settled(x, 'ask', 'due') && x.shareChosen === false;   // the small screen, once; nothing shared until answered
  r = launch(folder({}), false, '0.2.12');
  check('a fresh install: not answered ("ask"), no small screen (the walkthrough asks), kept', r.fresh && settled(r, 'ask', 'done') && r.now === 'due' && r.shareChosen === false, r);
  r = launch(folder({ 'typd/settings.json': S026, ...HISTORY, ...MODEL, ...BEFORE, ...UPDATED }), true, '0.2.12');
  check("update from 0.2.6, 'on', first started before the old cutoff (a recording from 17 Oct), never chose: asked once, off until then", asked(r) && r.now === 'done', r);
  r = launch(folder({ 'typd/settings.json': S026, ...HISTORY, ...MODEL, ...UPDATED }), true, '0.2.12');
  check("update from 0.2.6, 'on', first started after it: asked once, off until then", asked(r), r);
  const noKey = { ...S026 };
  delete noKey.share;
  r = launch(folder({ 'typd/settings.json': noKey, ...MODEL, ...BEFORE }), false, '0.2.12');
  check('no share key, first started before the old cutoff: asked', asked(r), r);
  r = launch(folder({ 'typd/settings.json': { ...S026, share: '' }, ...MODEL, ...BEFORE }), false, '0.2.12');
  check("share '' (0.2.0-0.2.3, never answered), before the old cutoff: asked", asked(r), r);
  r = launch(folder({ 'typd/settings.json': S026, ...MODEL, 'typd/share.json': { enrolledAt: '2026-10-18T13:13:00.000Z' } }), false, '0.2.12');
  check('enrolled before the old cutoff (share.json 13:13 UTC): asked all the same', asked(r), r);
  r = launch(folder({ 'typd/settings.json': { ...S026, share: 'off' }, ...MODEL, ...BEFORE }), false, '0.2.12');
  check("'off' (0.2.6's file), before the old cutoff: off, no screen", settled(r, 'off', 'done'), r);
  r = launch(folder({ 'typd/settings.json': { ...S026, share: 'off' }, ...MODEL }), false, '0.2.12');
  check("'off' (0.2.6's file), after it: off, no screen", settled(r, 'off', 'done'), r);
  r = launch(folder({ 'typd/settings.json': { ...S026, share: 'maybe' }, ...MODEL }), false, '0.2.12');
  check('a value Typd never wrote: off, no screen', settled(r, 'off', 'done'), r);

  // Files 0.2.7-0.2.11 wrote (shareAsk set, no shareChosen).
  r = launch(folder({ 'typd/settings.json': S028, ...HISTORY, ...MODEL, ...BEFORE, ...UPDATED }), true, '0.2.12');
  check("0.2.7-0.2.11's 'on' (the old exemption, or an answer they did not record): asked once", asked(r) && r.now === 'done', r);
  r = launch(folder({ 'typd/settings.json': { ...S028, share: 'off' }, ...MODEL, ...BEFORE }), false, '0.2.12');
  check("0.2.7-0.2.11's 'off': off, no screen", settled(r, 'off', 'done'), r);
  r = launch(folder({ 'typd/settings.json': { ...S028, share: 'ask', shareAsk: 'done' }, ...MODEL }), false, '0.2.12');
  check("0.2.7-0.2.11's 'ask', asked once already (shown, closed unanswered): stays, not asked again", settled(r, 'ask', 'done'), r);
  r = launch(folder({ 'typd/settings.json': { ...S028, share: 'ask', shareAsk: 'due' }, ...MODEL }), false, '0.2.12');
  check("0.2.7-0.2.11's 'ask', not shown yet: still due", settled(r, 'ask', 'due'), r);

  // Files 0.2.12 wrote: a choice is recorded with it, and stays.
  r = launch(folder({ 'typd/settings.json': { ...S028, share: 'on', shareAsk: 'done', shareChosen: true }, ...MODEL, ...BEFORE }), false, '0.2.12');
  check("an explicit 'on' (shareChosen), first started before the old cutoff: on, not asked", settled(r, 'on', 'done') && r.shareChosen === true, r);
  r = launch(folder({ 'typd/settings.json': { ...S028, share: 'on', shareAsk: 'due', shareChosen: true }, ...MODEL }), false, '0.2.12');
  check("an explicit 'on' chosen in Settings before the small screen showed: on (no screen: it shows only for 'ask')", r.share === 'on' && r.shareChosen === true, r);
  r = launch(folder({ 'typd/settings.json': { ...S028, share: 'off', shareAsk: 'done', shareChosen: true }, ...MODEL }), false, '0.2.12');
  check("an explicit 'off' (shareChosen): off", settled(r, 'off', 'done'), r);

  // One install through it: asked at the update, not answered, then Share, then Don't share in Settings.
  const d = folder({ 'typd/settings.json': S026, ...MODEL, ...BEFORE });
  r = launch(d, true, '0.2.12');
  check('the update to 0.2.12: asked', asked(r), r);
  r = launch(d, false, '0.2.12');
  check('second launch, not answered yet: still "ask", still due', asked(r), r);
  const f = path.join(d.appData, 'typd', 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), shareAsk: 'done' }));   // the small screen opened
  r = launch(d, false, '0.2.12', 'on');
  check('Share: set, and recorded as a choice in the same file', r.answered === true && r.savedShare === 'on' && r.savedShareChosen === true, r);
  r = launch(d, false, '0.2.12');
  check('the next launch: on, not asked again', settled(r, 'on', 'done') && r.shareChosen === true, r);
  r = launch(d, false, '0.2.12', 'off');
  r = launch(d, false, '0.2.12');
  check("Don't share later (Settings): off, and it stays off", settled(r, 'off', 'done'), r);
  check('shareChosen cannot be set on its own (only with share)', r.refused === false);
  // Back to 0.2.11 and up again: 0.2.11 does not know shareChosen and drops it when it writes the file.
  fs.writeFileSync(f, JSON.stringify({ ...S028, share: 'on', shareAsk: 'done' }));
  r = launch(d, false, '0.2.12');
  check("an 'on' that lost its record (a downgrade wrote the file): asked again, the safe side", asked(r), r);
  // A fresh 0.2.12 install's second launch keeps its 'ask'.
  const fr = folder({});
  launch(fr, false, '0.2.12');
  r = launch(fr, false, '0.2.12');
  check("a fresh install's second launch, walkthrough not answered: still 'ask', no small screen", settled(r, 'ask', 'done'), r);

  const settingsJs = require(path.join(root, 'src', 'main', 'settings'));
  const { shareRule } = settingsJs;
  const never = () => { throw new Error('asked'); };
  const no = () => false;
  check('no cutoff any more: settings.js exports none and reads no first-launch time', !('SHARE_CUTOFF' in settingsJs) && !('firstLaunchAt' in settingsJs) &&
    !/SHARE_CUTOFF|firstLaunch/.test(fs.readFileSync(path.join(root, 'src', 'main', 'settings.js'), 'utf8')));
  const x1 = shareRule({ share: 'on', shareAsk: 'done' }, { fresh: never });
  check("shareRule: 0.2.7-0.2.11's 'on' -> ask, due, kept (fresh() not asked)", x1.share === 'ask' && x1.shareAsk === 'due' && x1.decided && x1.shareChosen === false, x1);
  const x2 = shareRule({ share: 'on', shareAsk: 'done', shareChosen: true }, { fresh: never });
  check("shareRule: a recorded 'on' is read as saved and not decided again", x2.share === 'on' && x2.shareAsk === 'done' && !x2.decided, x2);
  const x3 = shareRule({ share: 'off', shareAsk: 'done' }, { fresh: never });
  check("shareRule: an 'off' is read as saved and not decided again", x3.share === 'off' && !x3.decided, x3);
  const x4 = shareRule({ share: 'on' }, { fresh: no });
  check("shareRule: an earlier Typd's 'on' with nothing else known -> ask, due", x4.share === 'ask' && x4.shareAsk === 'due', x4);
  const x5 = shareRule({ share: 'on', shareChosen: 'yes' }, { fresh: no });
  check('shareRule: only shareChosen === true counts as a choice', x5.share === 'ask', x5);
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
