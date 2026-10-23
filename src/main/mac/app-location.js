'use strict';

/**
 * macOS: where Typd runs from, and what macOS remembers about it.
 *
 * macOS keeps Typd's privacy answers (Microphone, Accessibility, Input Monitoring) under its bundle
 * id, and finds the app behind that id through LaunchServices. A Typd first run from ~/Downloads (or
 * a disk image, the Desktop, a translocated copy) and then moved or deleted can leave LaunchServices
 * pointing at a bundle that no longer exists. A Mac user on macOS 27 had exactly that: tccd logged
 * "_CFBundleCreateUnique failed for file:///Users/…/Downloads/Typd.app/", macOS reported the
 * microphone as off for Typd, and System Settings listed no Typd to switch on. So:
 *
 *   offerMove()   before any permission is asked, a Typd running from one of those places offers to
 *                 move itself to /Applications (Electron's app.moveToApplicationsFolder: it moves and
 *                 relaunches), or to open the Typd already there.
 *   tidy()        Typd remembers where it ran (settings macAppPaths). A copy of Typd's that is gone
 *                 is unregistered from LaunchServices (lsregister -u: only those exact paths, only
 *                 Typd's), and the running copy registered (lsregister -f). On a move, and when the
 *                 person asks Typd to ask macOS again (permissions-mac.js resetMic).
 *
 * Nothing here runs from source (the switches are then Terminal's) or off macOS; TYPD_NO_MOVE_OFFER=1
 * keeps the offer away (the Mac CI's launches from its build folder never meet it anyway).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, dialog } = require('electron');

let offering = false;   // the move offer is on screen (the walkthrough waits: index.js)
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const life = (what, detail) => { try { require('../lifelog').log(what, detail); } catch { /* no log */ } };

/** /…/Typd.app, from the running executable (Contents/MacOS/Typd). */
function bundlePath() {
  return path.resolve(process.execPath, '..', '..', '..');
}

/** The risky places, in words; null for anywhere else (Applications, ~/Applications, a build folder). */
function place(p = bundlePath()) {
  const home = os.homedir();
  if (/\/AppTranslocation\//.test(p)) return 'a temporary copy macOS made (App Translocation)';
  if (p.startsWith('/Volumes/')) return 'the disk image';
  if (p.startsWith(path.join(home, 'Downloads') + path.sep)) return 'your Downloads folder';
  if (p.startsWith(path.join(home, 'Desktop') + path.sep)) return 'your Desktop';
  return null;
}

function run(file, args, ms = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: ms }, (err, out, errOut) =>
      resolve({ ok: !err, said: String(out || errOut || (err && err.message) || '').trim().split('\n')[0].slice(0, 160) }));
  });
}

/**
 * Offer the move, before any permission is asked. Resolves true when Typd is on its way out (moving
 * and relaunching, or handing over to the Typd in /Applications): the caller then starts nothing more.
 */
async function offerMove() {
  if (process.platform !== 'darwin' || !app.isPackaged || process.env.TYPD_NO_MOVE_OFFER === '1') return false;
  let inApps = false;
  try { inApps = app.isInApplicationsFolder(); } catch { /* treat as not */ }
  const where = place();
  if (inApps || !where) return false;
  const here = bundlePath();
  const there = '/Applications/' + path.basename(here);
  const exists = fs.existsSync(there);
  life('location', 'running from ' + where + (exists ? '; another Typd is in /Applications' : ''));
  try { app.focus({ steal: true }); } catch { /* it still shows */ }
  offering = true;
  const { response } = await dialog.showMessageBox({
    type: 'none',
    title: 'Typd',
    message: exists ? 'Use the Typd in your Applications folder?' : 'Move Typd to your Applications folder?',
    detail: 'This Typd runs from ' + where + '. macOS ties Typd’s microphone and keyboard permissions to where the app is: ' +
      'if this copy is moved or deleted later, macOS can keep saying no for a copy that is gone, and Typd would not appear ' +
      'in Privacy & Security to switch on.\n\n' +
      (exists ? 'Typd is already in Applications. Open that one, and drag this copy to the Trash.'
        : 'Move it now, before macOS asks for anything. Typd starts again from Applications.'),
    buttons: [exists ? 'Open the One in Applications' : 'Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }).finally(() => { offering = false; });
  if (response !== 0) { life('location', 'the person kept this copy where it is'); return false; }
  if (exists) {
    life('location', 'handing over to ' + there);
    // After this copy has quit (one Typd at a time: a second copy quits at once).
    require('child_process').spawn('/bin/sh', ['-c', 'sleep 1.5; /usr/bin/open "$0"', there], { detached: true, stdio: 'ignore' }).unref();
    if (quitFor) quitFor('handing over to the Typd in Applications');
    return true;
  }
  try {
    const moved = app.moveToApplicationsFolder({ conflictHandler: () => false });
    life('location', moved ? 'moved to /Applications; starting again from there' : 'not moved');
    return moved;
  } catch (err) {
    life('location', 'the move failed: ' + ((err && err.message) || err));
    dialog.showMessageBox({ type: 'none', title: 'Typd', message: 'Typd could not move itself', detail: 'Drag Typd from ' + where + ' into your Applications folder, then open it from there.', buttons: ['OK'], noLink: true }).catch(() => {});
    return false;
  }
}

/**
 * Typd's LaunchServices entries: forget the copies of Typd that are gone, register this one. `force`
 * registers this copy even when nothing changed (permissions-mac.js before it asks macOS again).
 * Never touches a path Typd did not run from itself.
 */
/**
 * The paths LaunchServices holds for ai.typd.app (`lsregister -dump`, streamed: on a Mac with many apps it
 * is tens of MB). In the dump a bundle's "path:" line comes before its "identifier:" line.
 */
function registeredPaths(id = 'ai.typd.app', ms = 8000) {
  return new Promise((resolve) => {
    const found = new Set();
    let child;
    try { child = require('child_process').spawn(LSREGISTER, ['-dump'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve([]); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, ms);
    let last = null, rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        const m = /^path:\s+(.*?)(?: \(0x[0-9a-f]+\))?\s*$/.exec(line);
        if (m) { last = m[1]; continue; }
        const idm = /^identifier:\s+(.*?)\s*$/.exec(line);
        if (last && idm && idm[1] === id) { found.add(last); last = null; }
      }
    });
    const done = () => { clearTimeout(timer); resolve([...found]); };
    child.on('error', done);
    child.on('close', done);
  });
}

async function tidy(settings, { force = false, scan = false } = {}) {
  if (process.platform !== 'darwin' || !app.isPackaged) return { gone: [], registered: false };
  const here = bundlePath();
  let known = [];
  try { known = String(settings.get('macAppPaths') || '').split('\n').filter(Boolean); } catch { known = []; }
  // With `scan`, also every path LaunchServices holds for Typd's id (copies an older Typd ran from,
  // which it did not remember): the gone ones are unregistered too.
  const listed = scan ? await registeredPaths() : [];
  const gone = [...new Set([...known, ...listed])].filter((p) => p !== here && path.isAbsolute(p) && /\.app$/.test(p) &&
    !fs.existsSync(path.join(p, 'Contents', 'Info.plist')));
  const fresh = !known.includes(here);
  for (const p of gone) {
    const r = await run(LSREGISTER, ['-u', p]);
    life('location', 'unregistered a copy of Typd that is gone: ' + p.replace(os.homedir(), '~') + (r.ok ? '' : ' (' + r.said + ')'));
  }
  let registered = false;
  if (fresh || gone.length || force) {
    const r = await run(LSREGISTER, ['-f', here]);
    registered = r.ok;
    life('location', 'registered ' + here.replace(os.homedir(), '~') + (r.ok ? '' : ' (failed: ' + r.said + ')'));
  }
  const keep = [here, ...known.filter((p) => p !== here && !gone.includes(p))].slice(0, 6);
  if (scan) life('location', 'LaunchServices holds Typd at ' + (listed.length ? listed.map((p) => p.replace(os.homedir(), '~')).join(', ') : 'no path') + (gone.length ? '; gone: ' + gone.length : ''));
  try { settings.set('macAppPaths', keep.join('\n')); } catch { /* not saved */ }
  return { gone, registered };
}

let quitFor = null;   // index.js's quit(by): the one place Typd quits from
module.exports = { offerMove, tidy, place, bundlePath, registeredPaths, isOffering: () => offering, quitWith: (fn) => { quitFor = fn; } };
