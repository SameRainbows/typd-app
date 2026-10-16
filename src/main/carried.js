'use strict';

/**
 * What an app update leaves out of the new app, kept beside it in userData, so that on macOS the new
 * app is installed exactly as Typd's CI signed it.
 *
 * An update package is thin (scripts/app-update-package.js): no dictation model, and never a tester's
 * tester.json. Up to 0.2.1 the macOS helper moved both from the installed app into the new one and
 * then signed the result ad hoc on the user's Mac: a new code identity at every update, so macOS
 * forgot Typd's Accessibility, Microphone and Input Monitoring switches each time. From 0.2.2 a macOS
 * package is signed in CI with Typd's own certificate (docs/MAC.md "Code signing") and its manifest
 * carries nothing, so the helper -- the old version's, 0.2.0's included -- changes nothing inside it
 * and does not sign it again. Instead the new version, at its first start after the update and
 * before anything reads those files, copies what it lacks from the version it replaced into
 * <userData>/carried/. The helper keeps that version (pending.json "sides.old") until this one has
 * passed its self-test, and the copy leaves it whole, so a failed update still puts it back as it
 * was. On APFS the copy is a clone: instant, and no extra disk.
 *
 *   resource(rel)   the path to use for <resources>/<rel>: the app's own if it has it, else the
 *                   kept copy <userData>/carried/<rel> if there is one, else the app's (missing) one.
 *                   The first call does the copying (rescue), once per launch.
 *   pick(...)       the same choice without copying (modelUpdate.findConfig, the bench)
 *
 * A kept copy is deleted once the app has its own again (Typd reinstalled from the dmg). Windows is
 * unchanged: its helper still carries into the new folder (no signature to keep there), so the app
 * has its own and nothing is copied. Run from source, nothing here applies (resource() is null).
 */

const fs = require('fs');
const path = require('path');

const RESCUE = ['models/typd-dictate', 'tester.json'];
const MODEL = 'models/typd-dictate';

const has = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const join = (root, rel) => path.join(root, ...rel.split('/'));

/**
 * Is `rel` whole under `root`? The model: its model.json, its model and its mmproj (a missing revise
 * adapter only means revise runs on the base model, as local.js says); anything else: there.
 */
function whole(root, rel) {
  const p = join(root, rel);
  if (rel !== MODEL) return has(p);
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(p, 'model.json'), 'utf8'));
    return [spec.model, spec.mmproj].every((f) => typeof f === 'string' && f && path.basename(f) === f && fs.statSync(path.join(p, f)).size > 0);
  } catch {
    return false;
  }
}

/** The app's own <resources>/<rel> if it is whole, else <userData>/carried/<rel> if that is, else the app's. */
function pick(resourcesPath, userData, rel) {
  const own = join(resourcesPath, rel);
  if (whole(resourcesPath, rel)) return own;
  const carried = path.join(userData, 'carried');
  return whole(carried, rel) ? join(carried, rel) : own;
}

/**
 * Electron-free, for the bench.
 *   resourcesPath   this app's resources folder (Contents/Resources, or resources\)
 *   userData        app.getPath('userData')
 *   appVersion      this app's version: a copy is made only at the first start of this version
 *                   after an update (<userData>/app-update/pending.json names it)
 *   platform        where the old app keeps its resources: darwin Contents/Resources, else resources
 */
function create({ resourcesPath, userData, appVersion, platform = process.platform, log = () => {} }) {
  const carried = path.join(userData, 'carried');
  let rescued = false;

  function oldResources() {
    let pending = null;
    try { pending = JSON.parse(fs.readFileSync(path.join(userData, 'app-update', 'pending.json'), 'utf8')); } catch { return null; }
    if (!pending || pending.version !== appVersion) return null;
    const old = pending.sides && pending.sides.old;
    if (typeof old !== 'string' || !path.isAbsolute(old) || !has(old)) return null;
    return platform === 'darwin' ? path.join(old, 'Contents', 'Resources') : path.join(old, 'resources');
  }

  function copy(src, dst) {
    const tmp = dst + '.partial-' + process.pid;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // COPYFILE_FICLONE: a clone where the file system can (APFS), a plain copy elsewhere.
    fs.cpSync(src, tmp, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, preserveTimestamps: true, verbatimSymlinks: true });
    try {
      fs.renameSync(tmp, dst);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!has(dst)) throw err;   // another copy of Typd made it first
    }
  }

  function rescue() {
    if (rescued) return;
    rescued = true;
    const from = oldResources();
    for (const rel of RESCUE) {
      const kept = join(carried, rel);
      try {
        if (whole(resourcesPath, rel)) {
          if (has(kept)) { fs.rmSync(kept, { recursive: true, force: true }); log('the app has its own', rel, '- removed the kept copy'); }
          continue;
        }
        if (whole(carried, rel) || !from || !whole(from, rel)) continue;
        if (has(kept)) fs.rmSync(kept, { recursive: true, force: true });   // a broken copy
        copy(join(from, rel), kept);
        log('kept', rel, 'from the version this one replaced, in', kept);
      } catch (err) {
        // The new version then lacks it: without the model its self-test fails and the helper puts
        // the old version back, whole.
        log('could not keep', rel, ':', err && err.message);
      }
    }
  }

  return {
    rescue,
    resource(rel) { rescue(); return pick(resourcesPath, userData, rel); },
    dir: carried
  };
}

/* ------------------------------------------------------------- the app's instance */

let main;
function instance() {
  if (main !== undefined) return main;
  main = null;
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e.app && e.app.isPackaged) {
      main = create({
        resourcesPath: process.resourcesPath,
        userData: e.app.getPath('userData'),
        appVersion: e.app.getVersion(),
        log: (...a) => { if (process.env.TYPD_DEBUG) console.log('[typd:carried]', ...a); }
      });
    }
  } catch { /* not running in Electron */ }
  return main;
}

/** <resources>/<rel> for a packaged Typd (see above), or null when run from source. */
function resource(rel) {
  const m = instance();
  return m ? m.resource(rel) : null;
}

module.exports = { resource, pick, create, whole, RESCUE };
