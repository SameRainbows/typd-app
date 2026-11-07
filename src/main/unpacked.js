'use strict';

/**
 * Files of this app that another program opens by path.
 *
 * Packaged, the app's own files are inside resources/app.asar. Electron's fs reads through the
 * archive, so require(), fs.readFileSync and loadFile all work there -- and a path into app.asar
 * looks fine in every check made from inside Electron. Nothing else can read it: PowerShell, sh,
 * osascript, a native binary, the system's loader. Electron copies a file out for execFile() and
 * for loading a native module, but not for spawn(), and never for a path passed as an argument,
 * such as `powershell -File <path>`. That is how every packaged Windows install up to 0.2.11
 * copied its dictations and never pasted them: inject.js asked PowerShell for
 * <resources>\app.asar\src\main\inject.ps1, which PowerShell could not find, and every test had
 * run from source.
 *
 * So a file another program opens is one of:
 *   unpacked     package.json build.asarUnpack puts it beside the archive, at the same place under
 *                app.asar.unpacked, and the code asks for it there with unpacked() (inject.ps1;
 *                electron-builder does the same by itself for native modules: uiohook-napi);
 *   copied out   the code reads it through Electron's fs and writes it somewhere real before it
 *                runs (the app-update helpers, the Mac's inject-helper.js);
 *   a resource   outside the archive from the start (build.extraResources: llama-server, typd-mic,
 *                the model), found through process.resourcesPath.
 *
 * scripts/packaged-paths.js lists them. scripts/after-pack.js refuses a build where one is not a
 * real file at the path the code resolves, or where a script or native file is left in the archive;
 * bench/packaged-paths.js checks the source the same way.
 */

/** `file` with its archive's folder swapped for the .unpacked one beside it; unchanged outside an archive (a source run). */
function unpacked(file) {
  return String(file).replace(/\.asar([\\/])/, '.asar.unpacked$1');
}

module.exports = { unpacked };
