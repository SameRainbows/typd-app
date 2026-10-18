'use strict';

/**
 * The pill's controls in a real Electron window -- CI only, or a spare machine nobody is using.
 *
 *   TYPD_GUI_TEST=1 npx electron bench/pill-electron.js
 *
 * It shows the overlay, moves the real mouse pointer and clicks: never run it on a PC someone is
 * working on. Without TYPD_GUI_TEST=1 it says so and does nothing. bench/pill.js covers the rest
 * headlessly; this is what only a real window can show:
 *
 *   1. (every platform) the page in a real overlay window: input sent to its webContents at the
 *      tick's centre ends in overlay:confirm.
 *   2. (Windows) a real click through the OS -- SetCursorPos and a left press and release -- on
 *      the X: the click gate opens the window under the pointer, Windows delivers the click
 *      (WM_MOUSEACTIVATE and all), the page sends overlay:cancel, and the overlay never becomes
 *      the focused window.
 *   3. (Windows) the same real click on the meter between the controls sends nothing.
 *
 * Not yet run anywhere (written for 0.2.6 on a PC in use): the first CI run is its first run.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const electron = require('electron');

if (typeof electron === 'string') {
  console.log('Run it with Electron: TYPD_GUI_TEST=1 npx electron bench/pill-electron.js');
  process.exit(0);
}
if (process.env.TYPD_GUI_TEST !== '1') {
  console.log('skipped: this test shows a window and clicks the real mouse. Set TYPD_GUI_TEST=1, on CI or a spare machine only.');
  process.exit(0);
}

const { app, ipcMain, BrowserWindow } = electron;
const ow = require(path.join(__dirname, '..', 'src', 'main', 'overlay-window.js'));

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')'));
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const heard = [];
ipcMain.on('overlay:confirm', () => heard.push('confirm'));
ipcMain.on('overlay:cancel', () => heard.push('cancel'));
// The rest of what the page sends, so nothing goes unanswered.
for (const c of ['overlay:audio', 'overlay:chunk', 'overlay:mic', 'overlay:devices', 'overlay:hidden']) ipcMain.on(c, () => {});

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return fn();
}

/** Windows: move the real pointer to (x, y) in physical pixels and press and release the left button. */
function osClick(x, y) {
  const ps = `
Add-Type -Namespace T -Name M -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e);'
[T.M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 200   # the click gate looks every 25 ms
[T.M]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[T.M]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit', timeout: 20000 });
}

async function session(win) {
  heard.length = 0;
  win.webContents.send('session:start', { mode: 'dictate' });
  await sleep(600);   // the pill enters and the controls unfold
  return win.webContents.executeJavaScript(
    '["cancel","confirm"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })');
}

app.whenReady().then(async () => {
  const win = ow.createOverlayWindow({ dev: false });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript('window.__typdSynthetic = true; 0');   // no microphone needed
  ow.positionOverlay(win);
  ow.showOverlay(win);

  // 1. Input to the page itself.
  let c = await session(win);
  const [tx, ty] = [Math.round(c[1].x), Math.round(c[1].y)];
  win.webContents.sendInputEvent({ type: 'mouseMove', x: tx, y: ty });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: tx, y: ty, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: tx, y: ty, button: 'left', clickCount: 1 });
  check('input on the tick: overlay:confirm', await waitFor(() => heard.includes('confirm'), 2000), heard);
  win.webContents.send('session:cancel', {});
  await sleep(400);

  if (process.platform === 'win32') {
    const { screen } = electron;
    const toScreen = (p) => {
      const b = win.getBounds();
      // dipToScreenPoint: DIPs to physical pixels, on the display the pill is on.
      return screen.dipToScreenPoint({ x: b.x + p.x, y: b.y + p.y });
    };
    ow.showOverlay(win);
    // 2. A real click on the X.
    c = await session(win);
    const before = BrowserWindow.getFocusedWindow();
    const px = toScreen(c[0]);
    osClick(px.x, px.y);
    check('a real click on the X: overlay:cancel', await waitFor(() => heard.includes('cancel'), 2000), heard);
    check('...and the overlay never became the focused window', !win.isFocused() && BrowserWindow.getFocusedWindow() === before);
    win.webContents.send('session:cancel', {});
    await sleep(400);

    // 3. A real click on the meter: nothing.
    ow.showOverlay(win);
    c = await session(win);
    const mid = toScreen({ x: (c[0].x + c[1].x) / 2, y: c[0].y });
    osClick(mid.x, mid.y);
    await sleep(500);
    check('a real click on the meter between them: nothing sent', heard.length === 0, heard);
  } else {
    console.log('  skip  real OS clicks are Windows-only here (macOS would need Accessibility for synthetic clicks)');
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all pill window checks passed') + '\n');
  app.exit(failures ? 1 : 0);
});
