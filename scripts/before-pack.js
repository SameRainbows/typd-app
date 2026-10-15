'use strict';

/**
 * electron-builder beforePack hook: stage exactly the model the app runs.
 *
 * models/typd-dictate/ holds every model ever tried (seven 400 MB GGUFs at the time of
 * writing); model.json names the one in use. Shipping the folder would put 2.8 GB in the
 * installer, and a fixed file list in package.json would ship a stale model the day
 * model.json changes. So this reads model.json and stages model.json, its model, its mmproj
 * and its revise adapter, if it names one, into dist/.stage/models/typd-dictate/, which
 * build.extraResources copies to <resources>/models/typd-dictate/. Hard links where the
 * filesystem allows (no 600 MB copy), a plain copy otherwise.
 *
 * beforePack runs before electron-builder resolves extraResources (app-builder-lib
 * platformPackager.doPack), so the staged folder is always the current one.
 */

const fs = require('fs');
const path = require('path');

const STAGE = path.join('dist', '.stage', 'models', 'typd-dictate');   // = build.extraResources[0].from

module.exports = async function beforePack(context) {
  const projectDir = (context.packager && context.packager.projectDir) || process.cwd();
  const src = path.join(projectDir, 'models', 'typd-dictate');
  const dst = path.join(projectDir, STAGE);

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(src, 'model.json'), 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${path.join(src, 'model.json')}: the dictation model is not in place (${e.message})`);
  }
  // A revise adapter (model.json "revise_lora", src/main/pipeline/local.js) ships with its model.
  const files = ['model.json', spec.model, spec.mmproj, ...(spec.revise && spec.revise_lora ? [spec.revise_lora] : [])];
  for (const f of files) {
    if (!f || !fs.existsSync(path.join(src, f))) throw new Error(`Dictation model file missing: ${path.join(src, String(f))}`);
  }

  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of files) {
    const from = path.join(src, f), to = path.join(dst, f);
    try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
  }
  const mb = files.reduce((s, f) => s + fs.statSync(path.join(dst, f)).size, 0) / 1048576;
  console.log(`  • typd: staged dictation model ${files.slice(1).join(' + ')} (${mb.toFixed(0)} MB)`);
};
