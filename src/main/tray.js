'use strict';

const { app, Menu, Tray, nativeTheme, shell } = require('electron');
const status = require('./status');
const brand = require('./brand');
const settings = require('./settings');
const { store } = require('./store');

const MAC = process.platform === 'darwin';

/** "Thanks for the update, I'll send it…": one line, about 40 characters. */
function preview40(text) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > 40 ? one.slice(0, 39).trimEnd() + '…' : one;
}

/**
 * The tray icon (Windows) or menu-bar icon (macOS), and its menu.
 *
 * Windows hides new tray icons by default, so this is a place for quick actions and for
 * saying whether Typd is working -- never the only way to reach anything; launching Typd
 * again opens the window. The first line is status.js's sentence: ready and which key,
 * or what is wrong and, clicked, what fixes it. The icon says the same in one glance:
 * solid when ready, faded while loading or stuck, a red dot while the microphone is live.
 *
 * @param {object} deps
 * @param {(section: string, opts?: object) => void} deps.open  the Typd window
 * @param {(text: string) => void} deps.copy                  out of clipboard history
 * @param {() => {label: string, action?: string}|null} [deps.updateLine]   app-update line (appUpdate.js)
 * @param {(action: string) => void} [deps.updateAction]       a click on it (the download page)
 * @param {(id: string) => void} deps.statusAction             a click on the status line
 * @param {(term: string) => void} deps.forget                 undo a learned word
 * @param {() => string|null} [deps.modelLine]                 model-update line (modelUpdate.js)
 * @param {() => string|null} [deps.packLine]                  the CUDA pack's line (modelUpdate.js), Windows
 * @param {() => {size: string, later: boolean}|null} [deps.modelPrompt]   a model download waiting for "Update now"
 * @param {() => void} [deps.modelNow]                         "Update now"
 * @param {() => void} [deps.modelLater]                       "Later" (asked again after a day)
 * @param {() => void} [deps.flag]                             "That was wrong" on the last dictation
 * @param {() => 'ready'|'none'|null} [deps.canFlag]           null: sharing is not in this build
 * @param {() => string|null} [deps.flagKey]                   its shortcut, shown beside it
 * @param {() => void} [deps.quit]                             quit, saying it was the tray (index.js)
 * @param {() => void} [deps.diagnostics]                      "Copy diagnostics" (index.js, lifelog.js)
 */
function createTray(deps) {
  let tray = null;
  let iconKey = null;
  // The last finished text, so it is never more than a click away: pasted into the wrong
  // window, lost to a crash of the target app, or simply wanted twice. History keeps it
  // across restarts; this covers history being off.
  let lastText = '';
  // The word most recently learned from a correction, so a wrong lesson is one click from
  // undone (ROADMAP 3.8). The full list is the window's Dictionary.
  let lastLearned = null;
  // Input devices as the overlay sees them ({deviceId, label}), for the Microphone menu.
  let devices = [];

  function lastDictation() {
    try {
      const item = store().latest();
      if (item && item.text) return item.text;
    } catch { /* history unreadable: memory only */ }
    return lastText;
  }

  function chooseMic(id, label) {
    settings.set('mic', id);
    settings.set('micLabel', label);
    refresh();
  }

  function micMenu() {
    const chosen = settings.get('mic');
    const items = [{ label: 'System default', type: 'radio', checked: !chosen, click: () => chooseMic('', '') }];
    for (const d of devices) {
      items.push({ label: d.label || 'Microphone', type: 'radio', checked: d.deviceId === chosen, click: () => chooseMic(d.deviceId, d.label) });
    }
    if (chosen && !devices.some((d) => d.deviceId === chosen)) {
      // Unplugged: shown, checked and greyed, while dictation uses the system default.
      items.push({ label: (settings.get('micLabel') || 'Microphone') + ' (not connected)', type: 'radio', checked: true, enabled: false });
    }
    return items;
  }

  function feedback() {
    const subject = encodeURIComponent('Typd feedback (' + app.getVersion() + ', ' + (MAC ? 'macOS' : 'Windows') + ')');
    shell.openExternal('mailto:contact@mehmetdedeler.com?subject=' + subject).catch(() => {});
  }

  function menu() {
    const s = status.describe();
    const last = lastDictation();
    // Packaged builds: a new Typd downloading, waiting to install, or just installed.
    const update = deps.updateLine ? deps.updateLine() : null;
    // Tester builds and the developer's machines: which model, and whether it is updating.
    const model = deps.modelLine ? deps.modelLine() : null;
    // Windows on the GPU path: the CUDA pack downloading after the model, or waiting for an answer.
    const pack = deps.packLine ? deps.packLine() : null;
    // A big model download on a metered connection (or with "Ask before downloading new models"):
    // "Update now" / "Later". After Later, only "Update now" stays until it asks again.
    const prompt = deps.modelPrompt ? deps.modelPrompt() : null;
    const promptItems = prompt
      ? [{ label: prompt.kind === 'pack' ? `Download GPU acceleration (${prompt.size})` : prompt.first ? `Download the speech model (${prompt.size})` : `New model available (${prompt.size}) — Update now`, click: () => deps.modelNow() },
        ...(prompt.later ? [] : [{ label: 'Later', click: () => deps.modelLater() }])]
      : [];
    // Where sharing exists (sharing.js): flag the last dictation, with its shortcut beside it.
    const canFlag = deps.canFlag ? deps.canFlag() : null;
    const flagKey = deps.flagKey ? deps.flagKey() : null;
    const flagItem = canFlag
      ? [{ label: 'That was wrong…', enabled: canFlag === 'ready', click: () => deps.flag(), ...(flagKey ? { accelerator: flagKey, registerAccelerator: false } : {}) }]
      : [];
    return Menu.buildFromTemplate([
      s.action ? { label: s.line, click: () => deps.statusAction(s.action.id) } : { label: s.line, enabled: false },
      ...(model ? [{ label: model, enabled: false }] : []),
      ...(pack ? [{ label: pack, enabled: false }] : []),
      ...promptItems,
      ...(update ? [update.action && deps.updateAction
        ? { label: update.label, click: () => deps.updateAction(update.action) }
        : { label: update.label, enabled: false }] : []),
      { type: 'separator' },
      { label: 'Open Typd', click: () => deps.open('home') },
      last
        ? { label: 'Copy “' + preview40(last) + '”', click: () => deps.copy(last) }
        : { label: 'Nothing dictated yet', enabled: false },
      ...flagItem,
      ...(lastLearned ? [{ label: `Forget learned word “${lastLearned}”`, click: () => deps.forget(lastLearned) }] : []),
      { label: 'Microphone', submenu: micMenu() },
      { label: 'Change shortcut…', click: () => deps.open('settings', { capture: true }) },
      { type: 'separator' },
      { label: "What's new", click: () => deps.open('news') },
      { label: 'Send feedback', click: feedback },
      // What a tester sends when Typd misbehaves: the life log and a few lines of state, no dictation text.
      ...(deps.diagnostics ? [{ label: 'Copy diagnostics', click: () => deps.diagnostics() }] : []),
      { type: 'separator' },
      { label: 'Quit Typd', click: () => (deps.quit ? deps.quit() : app.quit()) }
    ]);
  }

  function refresh() {
    if (!tray) return;
    const s = status.describe();
    const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;   // the taskbar's theme, not the app's
    const key = s.icon + (dark ? ':d' : ':l') + (brand.CHOSEN || '');
    if (key !== iconKey) {
      iconKey = key;
      tray.setImage(brand.trayImage(s.icon, { dark }));
    }
    tray.setToolTip(s.tooltip);
    tray.setContextMenu(menu());
  }

  function build() {
    const s = status.describe();
    tray = new Tray(brand.trayImage(s.icon, { dark: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI }));
    iconKey = null;
    refresh();
    // Windows: a left click opens the same menu (a right click already does). macOS opens it on any click.
    if (!MAC) tray.on('click', () => tray.popUpContextMenu());
    nativeTheme.on('updated', refresh);   // the taskbar went light or dark
    status.onChange(refresh);
    return tray;
  }

  return {
    build,
    refresh,
    /** The icon again, from scratch (a new mark finished drawing). */
    redraw() { iconKey = null; refresh(); },
    remember(text) { lastText = text; refresh(); },
    learned(term) { lastLearned = term; refresh(); },
    /** A word is gone from the dictionary (here, or from the window). */
    forgotten(term) {
      if (lastLearned && lastLearned.toLowerCase() === String(term).toLowerCase()) lastLearned = null;
      refresh();
    },
    setDevices(list) { devices = list; refresh(); },
    /** The menu as it would open now (for a screenshot or a test). */
    menu,
    popUp() { if (tray) tray.popUpContextMenu(); },
    get tray() { return tray; }
  };
}

module.exports = { createTray, preview40 };
