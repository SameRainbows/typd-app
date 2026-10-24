'use strict';

/**
 * Is there a text field to paste into? (0.2.10)
 *
 * Typd pastes with Ctrl+V / ⌘V into whatever has the focus. With no text field focused -- the
 * desktop, a File Explorer or Finder window, a button -- the paste lands nowhere and the dictation
 * looks lost. So before pasting, the focused element is classified from facts the screen read
 * already has (inject.ps1 Get-FieldFacts, Windows UI Automation; mac/inject-helper.js fieldFacts,
 * macOS Accessibility), and the answer is one of three:
 *
 *   editable      paste, as always
 *   not-editable  confident there is nowhere to paste: offer the text in the copy pop-up instead
 *   unknown       paste, as always
 *
 * Paste unless confident. Browsers, Electron and other Chromium/Gecko apps, terminals, chat apps
 * that send typing to their message box, games and anything custom-drawn are "unknown" whatever
 * their tree says, because their accessibility trees do not reliably say where a paste goes. Only
 * a small set is ever "not-editable": the desktop, the taskbar, an Explorer/Finder window, a
 * read-only text box or a non-text control (a button, a list) in a native UI framework, and on
 * Windows no focus at all with no foreground window.
 *
 * Facts never include text: control types, class names, framework ids, roles, read-only flags,
 * process names and bundle ids (the last two decide only, and are never logged).
 *
 * Tested on recorded trees in bench/copy-popup.js (test/fixtures/field-facts.json).
 */

const EDITABLE = 'editable';
const NOT_EDITABLE = 'not-editable';
const UNKNOWN = 'unknown';

/* --------------------------------------------------------------- Windows */

// UI frameworks whose controls mean what their control type says: a Button there takes no paste.
const WIN_NATIVE_FW = new Set(['Win32', 'WinForm', 'WPF', 'XAML', 'DirectUI']);

// Control types that never hold text. Not here on purpose: Pane, Window, Group, Custom (custom-drawn
// apps and games show up as these), Document and Edit (text), DataGrid/DataItem/Table (a spreadsheet
// cell takes a paste), ComboBox and Spinner (some are editable), Text (a terminal's text area).
const WIN_NONTEXT = new Set([
  'Button', 'CheckBox', 'RadioButton', 'Hyperlink', 'Image', 'List', 'ListItem', 'Menu', 'MenuBar',
  'MenuItem', 'ProgressBar', 'ScrollBar', 'Slider', 'StatusBar', 'Tab', 'TabItem', 'ToolBar', 'ToolTip',
  'Tree', 'TreeItem', 'TitleBar', 'SplitButton', 'Header', 'HeaderItem', 'Separator', 'Thumb', 'AppBar'
]);

// Windows' own shell: the desktop, the taskbar, File Explorer windows.
const WIN_DESKTOP = new Set(['Progman', 'WorkerW']);
const WIN_TASKBAR = new Set(['Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
const WIN_EXPLORER = new Set(['CabinetWClass', 'ExploreWClass']);

// Chromium (every browser, Electron, WebView2), Gecko, CEF: their trees say little reliably.
const WIN_WEB_WINDOW = /^(Chrome_WidgetWin_\d+|Chrome_RenderWidgetHostHWND|MozillaWindowClass|MozillaDialogClass|CefBrowserWindow)$/;
const WIN_WEB_FW = new Set(['Chrome', 'Gecko']);

// Terminals: their text area is not an edit control, and a paste always lands.
const WIN_TERMINAL_WINDOW = new Set(['ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'PseudoConsoleWindow',
  'mintty', 'PuTTY', 'VirtualConsoleClass', 'org.wezfurlong.wezterm', 'Alacritty', 'kitty']);

// By process: browsers, editors, terminals, and apps that send a paste to their message box
// wherever the focus is (chat apps), or handle paste themselves (Calculator). The Start menu and
// Windows search send typing to their search box.
const WIN_UNCLEAR_PROC = new RegExp('^(' + [
  'chrome', 'msedge', 'msedgewebview2', 'firefox', 'zen', 'floorp', 'librewolf', 'waterfox', 'brave', 'opera', 'opera_gx',
  'vivaldi', 'arc', 'thorium', 'chromium', 'iexplore',
  'code', 'code - insiders', 'cursor', 'windsurf', 'zed', 'devenv', 'idea64', 'pycharm64', 'webstorm64', 'rider64',
  'windowsterminal', 'wt', 'openconsole', 'conhost', 'cmd', 'powershell', 'pwsh', 'wezterm-gui', 'alacritty', 'mintty',
  'putty', 'kitty', 'tabby', 'hyper', 'conemu', 'conemu64', 'cmder', 'warp', 'wsl', 'bash',
  'discord', 'slack', 'teams', 'ms-teams', 'whatsapp', 'whatsapp.root', 'telegram', 'signal', 'skype', 'zoom',
  'messenger', 'element', 'notion', 'obsidian', 'claude', 'chatgpt',
  'calculatorapp', 'calculator', 'startmenuexperiencehost', 'searchhost', 'searchapp', 'shellexperiencehost'
].map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|') + ')$', 'i');

// A Win32 edit control seen without UI Automation's client-side proxies (inject.ps1 does not load
// them): a Pane whose class says what it is.
const WIN32_EDIT_CLASS = /(^|\.)(edit|richedit\w*|richedit20w|richedit50w|scintilla)(\.|$)/i;

const lower = (s) => String(s || '').toLowerCase();

function classifyWindows(f) {
  if (!f || typeof f !== 'object') return { kind: UNKNOWN, why: 'no-facts' };
  if (f.error) return { kind: UNKNOWN, why: 'error' };

  const win = String(f.win || '');
  const proc = lower(f.proc), eproc = lower(f.eproc);
  const shell = WIN_DESKTOP.has(win) || WIN_TASKBAR.has(win);

  // Nothing focused at all. Confident only when there is no foreground window either, or it is the
  // desktop or the taskbar; an app window with no focused element (a game) still gets the paste.
  if (f.none === true || f.root === true) {
    if (f.fg === false || shell) return { kind: NOT_EDITABLE, why: 'desktop' };
    return { kind: UNKNOWN, why: 'no-focused-element' };
  }

  const ct = String(f.ct || '');
  // Editable: a writable value, a text control not marked read-only, a Win32 edit control.
  if (f.val === 'rw') return { kind: EDITABLE, why: 'value' };
  if (f.txt && f.tro === false) return { kind: EDITABLE, why: 'text' };
  const readOnly = f.val === 'ro' || f.tro === true;
  if ((ct === 'Edit' || ct === 'Document') && !readOnly) return { kind: EDITABLE, why: 'edit' };
  if (ct === 'Pane' && WIN32_EDIT_CLASS.test(String(f.cls || ''))) return { kind: EDITABLE, why: 'win32-edit' };

  // Unclear: web engines, terminals, and the apps listed above. Their trees do not say where a paste goes.
  if (WIN_WEB_FW.has(String(f.fw || '')) || WIN_WEB_WINDOW.test(win) || WIN_WEB_WINDOW.test(String(f.cls || ''))) return { kind: UNKNOWN, why: 'web' };
  if (WIN_TERMINAL_WINDOW.has(win)) return { kind: UNKNOWN, why: 'terminal' };
  if (WIN_UNCLEAR_PROC.test(proc) || WIN_UNCLEAR_PROC.test(eproc)) return { kind: UNKNOWN, why: 'app' };

  // Windows' own shell.
  if (WIN_DESKTOP.has(win)) return { kind: NOT_EDITABLE, why: 'desktop' };
  if (WIN_TASKBAR.has(win)) return { kind: NOT_EDITABLE, why: 'taskbar' };
  if (WIN_EXPLORER.has(win) && (proc === 'explorer' || !proc)) return { kind: NOT_EDITABLE, why: 'explorer' };

  // Native UI frameworks: a read-only text box, or a control that never holds text. Only with the
  // app known (its process name read), so the lists above could rule it out.
  const fw = String(f.fw || '');
  if (WIN_NATIVE_FW.has(fw) && (proc || eproc)) {
    if ((ct === 'Edit' || ct === 'Document') && readOnly) return { kind: NOT_EDITABLE, why: 'read-only' };
    if (WIN_NONTEXT.has(ct)) return { kind: NOT_EDITABLE, why: 'control' };
  }
  return { kind: UNKNOWN, why: 'unclear' };
}

/* ----------------------------------------------------------------- macOS */

const MAC_TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
const MAC_TEXT_SUBROLES = new Set(['AXSearchField', 'AXSecureTextField']);

// Roles that never hold text (AppKit). Not here: AXGroup, AXScrollArea, AXWindow, AXSplitGroup,
// AXLayoutArea, AXUnknown (custom-drawn), AXWebArea (web content), AXCell (a spreadsheet's cell).
const MAC_NONTEXT = new Set([
  'AXButton', 'AXCheckBox', 'AXRadioButton', 'AXRadioGroup', 'AXPopUpButton', 'AXMenuButton', 'AXList', 'AXOutline',
  'AXTable', 'AXRow', 'AXColumn', 'AXBrowser', 'AXImage', 'AXLink', 'AXMenu', 'AXMenuItem', 'AXMenuBar',
  'AXMenuBarItem', 'AXDisclosureTriangle', 'AXTabGroup', 'AXToolbar', 'AXSlider', 'AXIncrementor', 'AXProgressIndicator',
  'AXStaticText', 'AXColorWell', 'AXDockItem', 'AXSplitter', 'AXValueIndicator'
]);

// By bundle id: browsers, terminals, editors, and apps that send a paste to their message box.
// Chromium, Electron and CEF apps are found by their frameworks instead (fieldFacts `web`).
const MAC_UNCLEAR_BUNDLE = new RegExp('^(' + [
  'com\\.apple\\.Safari.*', 'com\\.apple\\.SafariTechnologyPreview', 'org\\.mozilla\\..*', 'app\\.zen-browser\\..*',
  'company\\.thebrowser\\..*', 'com\\.google\\.Chrome.*', 'com\\.microsoft\\.edgemac.*', 'com\\.brave\\..*',
  'com\\.operasoftware\\..*', 'com\\.vivaldi\\..*', 'org\\.chromium\\..*', 'com\\.kagi\\..*',
  'com\\.apple\\.Terminal', 'com\\.googlecode\\.iterm2', 'dev\\.warp\\..*', 'net\\.kovidgoyal\\.kitty', 'io\\.alacritty',
  'com\\.github\\.wez\\.wezterm', 'co\\.zeit\\.hyper', 'com\\.mitchellh\\.ghostty', 'org\\.tabby',
  'com\\.microsoft\\.VSCode.*', 'com\\.todesktop\\..*', 'dev\\.zed\\..*', 'com\\.jetbrains\\..*', 'com\\.apple\\.dt\\.Xcode',
  'com\\.apple\\.MobileSMS', 'ru\\.keepcoder\\.Telegram', 'org\\.telegram\\..*', 'net\\.whatsapp\\..*', 'desktop\\.WhatsApp',
  'com\\.hnc\\.Discord', 'com\\.tinyspeck\\.slackmacgap', 'com\\.microsoft\\.teams.*', 'org\\.whispersystems\\..*',
  'com\\.anthropic\\.claudefordesktop', 'com\\.openai\\.chat', 'notion\\.id', 'md\\.obsidian',
  'com\\.apple\\.calculator', 'com\\.apple\\.Spotlight', 'com\\.raycast\\..*', 'com\\.runningwithcrayons\\.Alfred.*'
].join('|') + ')$');

function classifyMac(f) {
  if (!f || typeof f !== 'object') return { kind: UNKNOWN, why: 'no-facts' };
  if (f.error || f.denied) return { kind: UNKNOWN, why: f.denied ? 'denied' : 'error' };

  const role = String(f.role || ''), sub = String(f.subrole || '');
  if (f.focused !== false) {
    if (MAC_TEXT_ROLES.has(role) || MAC_TEXT_SUBROLES.has(sub)) return { kind: EDITABLE, why: 'text' };
    if (f.settable === true) return { kind: EDITABLE, why: 'value' };
  }

  const bundle = String(f.bundle || '');
  if (f.web) return { kind: UNKNOWN, why: 'web' };
  if (MAC_UNCLEAR_BUNDLE.test(bundle)) return { kind: UNKNOWN, why: 'app' };
  if (role === 'AXWebArea') return { kind: UNKNOWN, why: 'web' };

  // Finder: its windows and the desktop (no focused element there is the desktop).
  if (bundle === 'com.apple.finder') return { kind: NOT_EDITABLE, why: f.focused === false ? 'desktop' : 'finder' };

  // Anywhere else, no focused element is not confident: apps without accessibility (games, custom UIs) still paste.
  if (f.focused === false) return { kind: UNKNOWN, why: 'no-focused-element' };
  // A control that never holds text, in an app known (its bundle read, no web engine found).
  if (MAC_NONTEXT.has(role) && bundle && f.web === false) return { kind: NOT_EDITABLE, why: 'control' };
  return { kind: UNKNOWN, why: 'unclear' };
}

/* ------------------------------------------------------------------ both */

// The names the life log may use: UI Automation's control types and the usual AX roles. Anything
// else an app reports is logged as "other" -- a role string is the app's to choose.
const UIA_TYPES = new Set(['AppBar', 'Button', 'Calendar', 'CheckBox', 'ComboBox', 'Custom', 'DataGrid', 'DataItem', 'Document',
  'Edit', 'Group', 'Header', 'HeaderItem', 'Hyperlink', 'Image', 'List', 'ListItem', 'Menu', 'MenuBar', 'MenuItem', 'Pane',
  'ProgressBar', 'RadioButton', 'ScrollBar', 'SemanticZoom', 'Separator', 'Slider', 'Spinner', 'SplitButton', 'StatusBar', 'Tab',
  'TabItem', 'Table', 'Text', 'Thumb', 'TitleBar', 'ToolBar', 'ToolTip', 'Tree', 'TreeItem', 'Window']);
const AX_ROLES = new Set([...MAC_TEXT_ROLES, ...MAC_NONTEXT, 'AXGroup', 'AXScrollArea', 'AXWindow', 'AXWebArea', 'AXSplitGroup',
  'AXCell', 'AXLayoutArea', 'AXLayoutItem', 'AXUnknown', 'AXApplication', 'AXSheet', 'AXDrawer', 'AXGrid', 'AXPopover',
  'AXDateField', 'AXTimeField', 'AXLevelIndicator', 'AXBusyIndicator', 'AXHandle', 'AXMatte', 'AXRuler', 'AXHelpTag']);

/** A short, text-free name for the element, for the life log: "UIA List", "AX AXButton". */
function roleOf(field, platform) {
  if (!field || typeof field !== 'object') return platform === 'mac' ? 'AX nothing' : 'UIA nothing';
  if (platform === 'mac') {
    if (field.focused === false) return 'AX no focused element';
    return 'AX ' + (AX_ROLES.has(field.role) ? field.role : field.role ? 'other' : 'unknown');
  }
  if (field.none === true) return 'UIA no focused element';
  return 'UIA ' + (UIA_TYPES.has(field.ct) ? field.ct : field.ct ? 'other' : 'unknown');
}


/**
 * {kind, why, role} for a field read on `platform` ('win32' | 'darwin' | 'mac'), never throwing.
 * `role` is text-free, for the life log.
 */
function classify(field, platform = process.platform) {
  const mac = platform === 'darwin' || platform === 'mac';
  let r;
  try {
    r = mac ? classifyMac(field) : classifyWindows(field);
  } catch {
    r = { kind: UNKNOWN, why: 'error' };
  }
  return { ...r, role: roleOf(field, mac ? 'mac' : 'win') };
}

const WHY_WORDS = {
  desktop: 'the desktop', taskbar: 'the taskbar', explorer: 'File Explorer', finder: 'Finder',
  'read-only': 'read-only', control: 'not a text control'
};

/** The life-log line for an offered dictation: "not pasted: no text field (UIA List, the desktop), offered copy". */
function logLine(verdict) {
  const why = WHY_WORDS[verdict && verdict.why];
  return 'not pasted: no text field (' + ((verdict && verdict.role) || 'unknown') + (why ? ', ' + why : '') + '), offered copy';
}

/**
 * The decision endSession makes for a dictation (index.js): paste it, or offer it in the pop-up.
 *
 *   field     the facts read when the dictation started (inject.focusContext), or undefined
 *   recheck   async () => fresh facts, or null -- called only when the first read says
 *             "not-editable": the user may have clicked into a text field while talking, and a
 *             paste is never skipped on an old answer. Its failure means "unknown": paste.
 *
 * Returns {paste: boolean, verdict}. Never throws.
 */
async function decide({ field, recheck, platform = process.platform } = {}) {
  const first = classify(field, platform);
  if (first.kind !== NOT_EDITABLE) return { paste: true, verdict: first };
  let fresh = null;
  try { fresh = recheck ? await recheck() : null; } catch { fresh = null; }
  if (!fresh) return { paste: true, verdict: { kind: UNKNOWN, why: 'recheck-failed', role: first.role } };
  const now = classify(fresh, platform);
  return { paste: now.kind !== NOT_EDITABLE, verdict: now };
}

/**
 * Paste a finished dictation, or do not: the step endSession takes when the text is ready (index.js).
 *
 *   mode      'dictate' is checked; a revision always pastes (it replaces a selection the user made)
 *   field     the facts from the key press (current.target.field)
 *   inject    {paste(text), fieldState()} -- inject.js / inject-mac.js
 *   current   () => false once the session has been superseded: then nothing is pasted (null back)
 *
 * Returns {result, verdict}: result is inject.paste's ({ok} / {ok:false, copied, reason}), or
 * {ok:false, offered:true} when there was no text field -- no keystroke was sent and the
 * clipboard was not touched. Null when superseded first.
 */
async function land({ text, mode, field, inject, current = () => true, platform = process.platform }) {
  const where = mode === 'dictate'
    ? await decide({ field, recheck: inject.fieldState, platform })
    : { paste: true, verdict: null };
  if (!current()) return null;
  const result = where.paste
    ? await inject.paste(text)
    : { ok: false, offered: true, reason: 'no text field' };
  return { result, verdict: where.verdict };
}

module.exports = {
  classify, classifyWindows, classifyMac, decide, land, logLine, roleOf,
  EDITABLE, NOT_EDITABLE, UNKNOWN
};
