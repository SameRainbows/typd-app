# Typd UX plan: the Typd window, the hotkey, the tray, first run

*Version 2, 9 October 2026. Version 1 covered the hotkey, the tray and first run. Version 2 adds the
lead's decisions and the product owner's new scope: one real Typd window. Phase 2 (the code) waits
for the lead's "go", because the macOS and tester-data agents are still editing `index.js`,
`settings-window.js`, `hotkeys.js` and `inject*`.*

## Decisions already made

| # | Decision (lead, 9 Oct) | Where it lands |
|---|---|---|
| 1 | The window may open by itself **only** when Typd cannot work: the mic is blocked, or a Mac permission is missing. | F1, F2, W1 |
| 2 | The pill's look must not change. Only the windows follow the system's light/dark theme. | W8 |
| 3 | The Mac default key is Right ⌘. The macOS agent implements it; the picker builds on their darwin key table. | H1, H2 |
| 4 | Mouse side buttons (H5) come after the macOS agent is done. | H5 |
| 5 | `src/` is in git (private repo SameRainbows/Typd, branch `dev`). The lead commits; I don't. | Phase 2 |
| 6 | **New scope:** one calm Typd window like Wispr Flow / Typeless, with Home, History, Dictionary, Settings and What's new. The parked home window is restored rather than rebuilt. The Settings window becomes the window's Settings section. The tray menu changes. Law 2 is rewritten. | W1–W9, T1 |
| 7 | The tray keeps "Forget “word”", shown only right after a word is learned. | T1 |
| 8 | "Delete all" in History keeps the Home counts, and its confirm says so. | W3 |
| 9 | The lead fixed `pipeline/context.js`: the dictionary lives in Electron's `appData/typd` on every OS (the Windows path is unchanged). | W4, P18 |
| 10 | In Phase 2 I may edit `package.json` `build.files` (for CHANGELOG.md) and the "no window" line in `docs/MAC.md`. | W6, W9, P19 |
| 11 | The tester-data agent is finished. The bug where "Keep recordings" only records once the folder exists is mine to fix in Phase 2. | W5, P9 |

## What bounds this plan

**The laws, as they will read.**
- Law 8: one key. The plan changes *which* key, never *how many*.
- Law 2 is being rewritten (W9). One calm window, opened only when asked. Essentials only, and no
  engagement mechanics. The Settings section still holds at most five controls.
- Law 7: monochrome plus one red. The parked home window's terracotta accent goes. Red means only
  "the mic is live" and errors.
- Law 3: never destroy work. Deleting history and dictionary entries gets an Undo, and side
  buttons wait for H5.
- Law 1: history and the dictionary stay on this machine. History never stores screen context,
  the highlighted span or window titles. That is the same rule `collect.js` follows.
- Law 5: every new piece gets a bench that runs without Electron: `bench/hotkeys.js` and
  `bench/home.js`.

**The user.**
- Turkish Q keyboard: Right Alt is AltGr, so ordinary typing must never start a dictation.
- Mouse side buttons are popular for dictation.
- Little time to fiddle.

**Ownership in Phase 2.** I re-read every file right before editing it. I keep the macOS agent's
darwin branches and the tester-data agent's sharing logic exactly as they leave them. I don't touch
`collect.js`, `permissions-mac.js` or the packaging scripts. The exceptions the lead allowed: the
`build.files` entry in `package.json`, the bench scripts there, and the "no window" line in
`docs/MAC.md`. Anything else they need goes to the lead as a note.

## Priority list and order

Effort: **S** = half a day or less, **M** = 1–2 days, **L** = 3 days or more.

| # | Change | Pri | Effort |
|---|---|---|---|
| H1 | Hotkey logic: one binding format, tap or hold on one key, AltGr and chord safety, bench | P0 | M |
| W1 | The Typd window: shell, navigation, security, how it opens. Absorbs the Settings window | P0 | M |
| W5 | Settings section: the five controls, the new hotkey picker (H2), the tester sharing line folded in | P0 | M |
| T1 | Tray / menu-bar menu: status line, Open Typd, Copy last, Microphone ▸, Change shortcut…, What's new, Send feedback, Quit | P0 | M |
| W3 | History: the local store, search, copy, delete one or all, retention | P0 | M |
| W4 | Dictionary: manual and learned words, "heard as", add and remove | P0 | S |
| W2 | Home: status, current key, model status, three counts | P0 | S |
| W6 | What's new: from a bundled CHANGELOG.md | P1 | S |
| W8 | Windows follow the system theme; the pill stays exactly as it is | P0 | S |
| W9 | ROADMAP Law 2 and its refusals rewritten; README updated | P0 | S |
| H3 | The current key shown everywhere it matters | P0 | S |
| F1 | Windows first run: a "ready" note in the pill, mic privacy check, start at login applied | P0 | S–M |
| H4 | When the key fails: a tray status and the Settings section, not an env-var dialog | P1 | S |
| W7 | One place where the mark is drawn (for the new logo) | P1 | S |
| T2 | Tray icon: three states, follows the taskbar theme, sharp at 150% | P1 | M |
| F2 | macOS first run: a permissions block in the window (with the macOS agent) | P1 | M |
| H5 | Mouse side buttons, swallowed so the browser does not also go Back (after the macOS agent) | P1 | M |
| P | Paper cuts (end of this file) | P0–P2 | S each |

**Phase 2 order:**
1. H1, then W1 with W5 and W8. The Settings section carries the H2 picker from the start, so there
   is never a moment with two settings surfaces.
2. T1, W3, W4, W2, W6, W9 and H3.
3. F1 and H4.
4. W7 and T2.
5. The paper cuts.
6. H5, then F2 with the macOS agent.

In all, about 8–10 working days.

---

## 1. The Typd window

### W1. The shell

**Before.** There are two surfaces:
- a 440×600 Settings window (`settings-window.js`, `renderer/settings.*`);
- a parked 1180×780 home window (`parked/main/home-window.js`, `store.js`, `renderer/home.*`,
  `preload/home.js`).

The parked window was built for an older Typd. It has:
- a terracotta accent (against Law 7);
- a Dark/Light/Auto switch that flips `nativeTheme` for the whole app, which would also turn the
  pill light (against decision 2);
- shortcuts hard-coded to Ctrl+Shift+D/A/T for features that are gone;
- a privacy line about a cleanup step that no longer exists;
- `sandbox: false`, and IPC handlers that never check who is calling.

**After.** One window, `src/main/home-window.js`, restored from parked and rewritten.

```
┌──────────────┬───────────────────────────────────────────────┐
│ ▬• Typd      │                                               │  title bar: drag region; Windows
│              │   (section content, one column,               │  draws its buttons over the right
│ Home         │    max 620 px wide, 32 px padding)            │  end; on Mac the traffic lights
│ History      │                                               │  sit at the top left of the sidebar
│ Dictionary   │                                               │
│ Settings     │                                               │
│              │                                               │
│ What's new   │                                               │
│ Runs on      │                                               │
│ this PC      │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

- **Size.** 860×580 by default, at least 720×500, resizable. Sidebar 188 px.
- **Type.** Section titles 20 px/600. Body 13.5 px. Numbers in tabular figures. Fonts: Segoe UI
  Variable on Windows, `-apple-system` on Mac.
- **Look.** The tokens of today's `settings.css`: `#FBFBFC`/`#17191E` grounds, cards with a
  hairline border, one ink colour, and red only for errors and destructive confirmations.
  No terracotta and no big display type. The parked 34–50 px headline goes; this is a calm tool.
- **Navigation icons.** The parked 17 px stroke icons are fine (monochrome). "What's new" and the
  fact line "Runs on this PC" / "Runs on this Mac" sit at the foot of the sidebar.
- **How it opens:**
  - "Open Typd" in the tray or menu bar opens Home.
  - "Change shortcut…" opens Settings with the hotkey row already waiting for a key.
  - "What's new" opens What's new.
  - Launching Typd again opens Home: `second-instance` on Windows, `activate` on Mac (P16).
  - **It never opens by itself, except** when Typd can't work (decision 1). Then it opens on the
    section that fixes it.
- **Life cycle.**
  - It is created on open and destroyed on close, so it uses no memory while closed. Measure it
    with `app.getAppMetrics()`; the target is under 150 MB while open.
  - It shows in the taskbar while open. On Mac (`LSUIElement`, no Dock icon), `app.dock.show()`
    while the window is open and `hide()` on close, so ⌘Tab can find it.
- **Security.** This window can delete history and change the mic, so it gets the full Electron
  checklist:
  - `sandbox: true`, `contextIsolation: true`, no Node.
  - CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:`.
  - Navigation is refused and `window.open` is denied.
  - **Every** `ipcMain.handle` checks `fromPage(e)`, the check `settings-window.js` already does.
  - The preload exposes only named calls, and every input is validated in main (ids, term length,
    enum values).
  - External links go through a main-side allowlist only:
    - `mailto:contact@mehmetdedeler.com`
    - `ms-settings:privacy-microphone`
    - Apple's privacy panes

**Files:**
- **New:** `src/main/home-window.js` (from parked), `src/preload/home.js` (from parked, merged with
  `preload/settings.js`), `src/renderer/home.html`, `home.css`, `home.js` (from parked, merged with
  `renderer/settings.*`).
- **Removed after the merge:** `settings.html/css/js`, `preload/settings.js`. Their handlers move
  into `src/main/settings-section.js`, which is today's `settings-window.js` without the window.
- **parked:** the restored files leave `parked/`, and `parked/README.md` says so.

**Test.**
- `bench/wiring.js` gains a home section: every `getElementById` id exists in `home.html`, every
  preload call has a matching `ipcMain.handle`, and every handler calls `fromPage`.
- By hand:
  - Each way in opens the right section.
  - Closing the window frees its renderer (`getAppMetrics`).
  - A link in the changelog does not navigate the window.
- Screenshots of every section in light and dark.

### W2. Home

**Layout:**
```
Home

┌────────────────────────────────────────────────────────────┐
│ ● Ready. Tap  [ Right Alt ]  in any app and talk.   Change │
│   Speech model typd-dictate · on this PC · ready           │
└────────────────────────────────────────────────────────────┘

  1,284                  2,340                   ≈ 6 h 10 min
  dictations so far      words this week         saved so far
                                                 vs typing at 40 wpm

  Highlight text first, then tap Right Alt, to revise it by voice.
```

**The status card** has the same states as the tray's status line, from one `status` object in
main (see T1):

| State | Card text | Action in the card |
|---|---|---|
| Getting ready | "Getting ready…" | none |
| Ready | "Ready. Tap [key] in any app and talk." | Change (opens the hotkey picker) |
| Mic blocked | "Windows is blocking the microphone." | Open privacy settings |
| Key not working | "Typd couldn't listen for Right Alt." | Choose another key |
| Model failed | "The speech model didn't start." | Try again |

The model line reads "Speech model typd-dictate · on this PC · ready", or "· on the CPU" when
there is no GPU.

**The three counts:**
- They are numbers only: no charts, no goals, no streaks, no comparison with anyone (W9).
- "Time saved" is labelled as an estimate and shows its one assumption, typing at 40 words a
  minute. Its rule: the time the same words take to type at 40 wpm, minus the time spent speaking
  and the wait for the text, summed over dictations and never below zero.
- On a fresh install the counts read "0", with the line "Your first dictation will show up here".
  There is no empty-state illustration.

**The tip line** is static text. It is not a nag and has no "dismiss" button.

**Files:** `renderer/home.*`, `home-window.js` (`home:get`), `store.js` (`counts()`).

**Test.**
- `bench/home.js`: the counts from a fixture history (this-week boundaries in local time, time
  saved never negative, revisions excluded from time saved).
- By hand:
  - Dictate one sentence with the window open: the counts update with no reload
    (`home:changed`).
  - Change the key: the card's keycap changes.

### W3. History, and how it is stored

**Layout:**
```
History                                              Keep  [ 30 days ▾ ]
[ Search your dictations…                                         ]

TODAY
14:32   Thanks for the update, I'll send the draft tonight and…     Copy  Delete
        Chrome · 42 words
14:05   Make this shorter                                           Copy  Delete
        Revised · Word · 9 words
YESTERDAY
…
                                                                Delete all…
```

- **Rows.** A row shows up to three lines and opens to the full text on click. Copy and Delete
  appear on hover, and are always visible on keyboard focus.
  - Copy goes through main (`inject.copy`), so it stays out of Win+V clipboard history.
- **Labels.**
  - Revisions say "Revised".
  - A dictation whose paste failed says "Copied, not pasted". It is the one that needed rescuing.
- **Search** runs as you type over everything kept, ignoring case and accents. It handles Turkish
  İ/ı correctly. 200 rows render first, with "Show more" after them.
- **Keep:**
  - **30 days** is the default. **Forever** and **Off** are the other choices.
  - Choosing **Off** asks first, in place: "Stop keeping history and delete 312 dictations?
    [Turn off] [Cancel]".
- **Delete:**
  - **Delete one** happens at once, with "Deleted · Undo" for 6 s (Law 3).
  - **Delete all** asks first, in place: "Delete all 312 dictations? Your counts on Home stay.
    [Delete all] [Cancel]".
- **Empty states, one line each:**
  - "Nothing yet. Your dictations show up here, on this PC only."
  - "History is off. Typd isn't keeping your dictations."
  - "No dictation contains “kaggle”."

**Data model.** One file, `history.json`, in the same folder as `dictionary.json` and
`settings.json` (`app.getPath('userData')`). It is written atomically: write `.tmp`, then rename,
as `dictionary.js` does.
```jsonc
{
  "v": 2,
  "keep": "30d",                       // "30d" | "forever" | "off"
  "items": [                           // oldest first; capped at 5,000
    {
      "id": "20261009T143212Z-3f2a",   // time stamp + 4 random hex; stable, used for delete
      "at": "2026-10-09T14:32:12.345Z",// when the text landed
      "mode": "dictate",               // "dictate" | "revise"
      "text": "Thanks for the update…",// what was pasted (for a revision, the rewrite)
      "words": 42,
      "seconds": 12.4,                 // length of the audio
      "waitMs": 410,                   // stop -> text ready
      "app": "chrome",                 // process name only
      "outcome": "pasted"              // "pasted" | "copied" (paste failed or selection lost)
    }
  ],
  "days": {                            // counts only, no text; kept when history is off or cleared
    "2026-10-09": { "n": 14, "words": 610, "seconds": 301, "typedSeconds": 915 }
  }
}
```

**Rules.**
- **Never stored:** screen context, the highlighted span, window titles, audio. Audio is the
  separate "Keep recordings" switch.
- **When it is written:** in `endSession`, after the paste result (both the pasted and the copied
  outcomes), at the same place `remember()` runs. It is written on `setImmediate`, off the paste
  path.
- **Pruning** for "30d" happens at load and once a day.
- **The "days" counts** are what Home reads, so Home still works with history off. They are tiny
  (about 15 KB a year).
- **Migration.** The parked v1 file (`{retentionDays, sessions}`; one entry from August exists on
  this machine) moves to v2 on first load, taking the new default "30d".
- **"Copy last dictation"** in the tray reads the newest item, so it survives a restart, unless
  history is off; then it falls back to memory, as now.

**Files:**
- `src/main/store.js`, restored and rewritten: `record`, `list`, `remove(id)`, `restore(item)`
  for Undo, `clear`, `setKeep`, `counts`.
- `src/main/index.js`: one `store.record(...)` call.
- `home-window.js`: `history:list`, `history:copy`, `history:delete`, `history:undo`,
  `history:clear`, `history:keep`.
- `renderer/home.*`.

**Test** (`bench/home.js`, no Electron, on a temp folder):
- `record` drops unknown fields, so a `context` or `span` passed in never reaches the file.
- The 5,000 cap holds.
- "30d" prunes a 31-day-old item and keeps a 29-day-old one; "off" keeps no items but still
  counts days.
- `remove` and then `restore` give back the same file.
- The v1 file migrates.
- A half-written `.tmp` never replaces a good file.
- Search finds "İstanbul" from "istanbul" and "Ayşe" from "ayse".

By hand: dictate three times, search, copy one and paste it into Notepad, delete one and Undo,
then Delete all.

### W4. Dictionary

**Layout:**
```
Dictionary
Words Typd should spell your way. Learned words come from your corrections.

[ Add a word…                     ]  [ Add ]

Aysel        heard as “Ayşe”                 Learned · 9 Oct     ×
Kaggle        heard as “cable”, “kegel”       Learned · 6 Oct     ×
Poolside                                      Added · 3 Oct       ×

Open the file          (shows dictionary.json in Explorer / Finder)
```

**Behaviour.**
- It reads and writes the same `dictionary.json` through `src/main/dictionary.js`: `load`,
  `add(term, null, 'manual')`, `remove`.
- Entries already have the shape `{term, heardAs[], source: 'auto'|'manual', addedAt}`. Learned
  entries come from `learn.js` with `source 'auto'`. The labels are plain words: "Learned" and
  "Added". There are no sparkles.
- **Adding.** Over 64 characters is refused with "Up to 64 characters". A word already there
  gives "Already in your dictionary" and highlights the existing row.
- **Removing** happens at once, with "Removed · Undo" for 6 s.
- **Search** appears only once there are more than 30 entries.
- If `learn.js` learns a word while the window is open, the list updates (`home:changed`).
- The tray's "Forget “Aysel”" and this list are the same data.

**Files:** `home-window.js` (`dictionary:list`, `dictionary:add`, `dictionary:remove`,
`dictionary:reveal`), `renderer/home.*`. No change to `dictionary.js`, except where P18 needs one.

**Test.**
- `bench/home.js`, with `dictionary.js` pointed at a temp file:
  - add, then a duplicate in a different case, then remove;
  - a hand-edited file is re-read rather than overwritten.
- By hand: correct a word after a paste (`npm run bench:learn` covers the detection itself) and
  watch it appear with its "heard as".

### W5. Settings section

**Layout.** At most five controls (Law 2):
```
Settings

Microphone        [ System default                    ▾ ]
                  ▁▂▃▅▃▂  (level, live only while this section is on screen)

Hotkey            [ Right Alt ]                           Change
                  Tap to start, tap again to finish. AltGr + a key still types.

Sounds                                                    (switch)
                  Soft tones when Typd starts, finishes or fails.

Start at login                                            (switch)
                  Ready on Right Alt as soon as you sign in.

Keep recordings                                           (switch)
                  312 recordings, 1.2 GB on this PC. They make the model better at your voice.
                  Open folder
                  ── tester builds only, inside this row ──
                  Sharing with Mehmet for model testing — on          Pause

Dictation runs on this PC. Your voice is never sent anywhere.
Model typd-dictate · Typd 0.1.0
```

- **Moved, not redesigned.** These are today's five Settings rows. Only the hotkey row changes, to
  the H2 picker.
- **The tester-data agent's sharing row** (`shareRow`, `sharePaused`, `collect.status()`, and the
  changed privacy footer) moves *into* the Keep recordings row. It becomes a sub-line with a
  Pause/Resume text button rather than a sixth switch. Its logic, wording and setting stay theirs;
  only its place changes. Ordinary builds show nothing there.
- **The mic is opened only while the Settings section is visible and the window has focus.**
  Today's Settings page opens it on load. In a window whose first section is Home, that would light
  the OS mic indicator every time someone looks at their history.
- **Wording follows the platform:** "Start with Windows" or "Open at login", "Windows default" or
  "System default", "this PC" or "this Mac".

**Files:** `renderer/home.*` (the section), `src/main/settings-section.js` (today's handlers:
`state`, `set`, `open-recordings`, `startAtLogin`, and collect's `sharing`), `settings.js`.

**Test.**
- Every switch persists across a restart.
- Choosing a mic moves the meter.
- Switching from Settings to History stops the meter, and the OS mic indicator goes out.
- With `tester.json` present, the sharing line shows inside Keep recordings and Pause sets
  `sharePaused`; without it, nothing shows.
- Count the controls: five.

### W6. What's new

**Layout:**
```
What's new

0.2.0 · 12 October 2026
• Pick any key for dictation: press the key you want in Settings.
• History: find, copy and delete what you dictated. It stays on this PC.
…
0.1.0 · 6 October 2026
…
                                                  Typd 0.2.0
```

- **Source.** It is rendered from a bundled `CHANGELOG.md` by the parked `markdown.js`, restored to
  `src/renderer/markdown.js`. It already escapes everything before adding markup, and allows only
  http(s) links, which open in the browser through the allowlist.
- **Writing.** The changelog is written for users, in plain words, one line per change.
- **No update button** until there is a real update check; a button that does nothing is worse than
  none. The tray item "What's new" opens this section. Nothing is badged and nothing pops up after
  an update (W9).
- **Packaging.** `package.json` `build.files` currently excludes `!**/*.md`, which would leave
  CHANGELOG.md out of the build. I add an exception for it in Phase 2 (decision 10), and check that
  the packaged build contains it.

**Test.**
- In `bench/home.js`, the renderer outputs no raw HTML for a changelog line containing `<img
  onerror>`.
- By hand, the section shows the bundled file in the packaged build.

### W7. One place where the mark is drawn

**The rule.** A new logo is being designed (`assets/brand/`, `design/identity-study-02.html`).
Exactly one module knows what the mark looks like: `src/main/brand.js`.
- `brand.windowMark()` returns the SVG text for the sidebar and the window icon path. It comes from
  `assets/brand/mark.svg` when that file exists, and otherwise from today's pill-and-dot as a
  built-in fallback.
- `brand.trayImage(state, { dark, template })` returns a `nativeImage` with 16/20/24/32 px
  representations. It comes from hand-tuned PNGs in `assets/brand/tray/` when present
  (`ready`, `dim`, `live` × `light`, `dark`, `template`, at each size), and otherwise is drawn in
  code as today.

The window gets the SVG through the preload (`brand:mark`). No HTML or CSS file draws the mark.

**Swapping the logo** means dropping files into `assets/brand/`. No code changes.

**Test.** Put a test `mark.svg` and a set of tray PNGs into `assets/brand/` and restart. Both the
window and the tray change. Remove them and the fallback returns.

### W8. Windows follow the system theme; the pill does not change

**The problem.**
- `index.js:420` forces `nativeTheme.themeSource = 'dark'` for the whole app, which is why the pill
  is always dark.
- Setting it to `'system'` would make the windows follow the OS, but the pill's CSS switches on
  `prefers-color-scheme`, so it would turn light in light mode.

**The fix.**
- Set `themeSource = 'system'`, so the windows, their title-bar overlay colours and the native
  menus follow the OS.
- Pin the pill to the palette it has today. In `overlay.css`, the
  `@media (prefers-color-scheme: dark)` block becomes `:root[data-scheme="dark"]` with identical
  values, and `overlay.html` carries `data-scheme="dark"`.
- `--preview` with `TYPD_PREVIEW_THEME=light` flips that attribute instead of `themeSource`, so the
  design preview still works.
- The window's `titleBarOverlay` colours update on `nativeTheme` `updated`.

**Test.** Render the pill with `TYPD_PREVIEW_OUT` before and after the change, with Windows in light
mode and again in dark mode. The four PNGs must match pixel for pixel. Then switch Windows between
light and dark with the window open: the window follows, and the pill does not.

### W9. ROADMAP Law 2, rewritten

**Proposed Law 2:**
> **2. The overlay is the product; the window is its quiet companion.** One calm window exists for
> what the overlay cannot show: Home, History, Dictionary, Settings and What's new. It opens only
> when asked — from the tray or menu bar, or by launching Typd again — except when Typd cannot work
> without you (the microphone is blocked, a Mac permission is missing). It holds essentials only.
> No engagement mechanics: no streaks, goals, badges, nags, upsells, or notifications asking you
> to come back. Its Settings section holds at most five controls; a sixth setting has to replace
> one. (Changed 2026-10-09: the product owner asked for a home window like Wispr Flow and Typeless.)

**The refusals at the end of ROADMAP** change to match. "No dashboard and no hub" becomes:

> No engagement mechanics and no settings sprawl. The window shows what you did and what Typd
> learned, plainly. The few choices that cannot be learned live in its Settings section.

**ROADMAP 3.8** ("inspectable and deletable … without a settings dashboard") is met by W4.

**Also updated:**
- `README.md`: "It lives in the tray", how to change the key, the stale "Right Alt is
  unreachable" gap.
- `docs/MAC.md`: the "Typd has no Dock icon and no window" line, which I may edit (decision 10).
  It becomes: no Dock icon until you open the Typd window from the menu bar.

---

## 2. Changing the hotkey

### H1. Hotkey logic

**Why.** Settings offers two hard-coded keys (`settings.js:20`). Anything else needs
`TYPD_HOTKEY`, which ordinary users cannot reach.

**One binding string, two kinds of key.**

| Kind | Stored as | Read by | Gesture |
|---|---|---|---|
| Single key, via the native hook | `RightAlt`, `RightCtrl`, `RightShift`, `RightMeta` (Mac: Right ⌘, the Mac default), `F13`…`F24`, `Mouse4`/`Mouse5` (after H5) | uiohook on Windows, the macOS agent's hook on Mac | tap, or hold (Right Alt and Right Option: tap only) |
| Combination, via `globalShortcut` | `CommandOrControl+Shift+Space`, `Ctrl+Shift+D`, `Alt+F9` | Electron | press to start, press again to finish |

The current values stay valid. On Mac, the names and keycodes come from the macOS agent's darwin
table (decision 3). The picker and labels read that table and do not duplicate it.

**Tap or hold on the same key ("Auto", as in Handy and VoiceInk), with no setting:**
- **Tap**, released in under 400 ms: start, and tap again to finish.
- **Hold**, 400 ms or longer: talk while holding, and let go to finish.
- **Right Alt and Right Option are tap only.** You hold AltGr or Option while looking for the next
  key, and a hold trigger would start recording in the middle of typing `@`. Today's clean-tap rule
  (released within 600 ms, with no other key in between) stays.
- **Combinations are tap only.** `globalShortcut` never reports a release.
- **Other modifiers** (Right Ctrl, Right Shift, Right ⌘): a hold starts after 400 ms only if no
  other key went down. A key pressed after that start (a slow Right Ctrl+C) cancels the session
  silently.
- **F13–F24 and side buttons** start on key-down; whether it was a hold or a tap is decided on
  release.

**Refused, with one sentence each:**

| Pressed | Message |
|---|---|
| Any combination with Ctrl and Alt, or AltGr + a key | "Ctrl+Alt is AltGr on many keyboards and would block typing @. Try Ctrl+Shift+Space." |
| A letter, digit, Space, Enter, Tab or Backspace alone | "That key types. Hold Ctrl or Shift with it, or pick Right Ctrl or F13." |
| F1–F12 alone | "F5 already does something in most apps. Add Ctrl or Shift, or use F13–F24." |
| Ctrl/⌘ + one letter | "Ctrl+C is already used in every app. Add Shift: Ctrl+Shift+C." |
| Left Ctrl, Left Alt or Left Shift alone | "Left Ctrl gets tapped by accident. Try Right Ctrl." |
| Win alone, or any Win combination (Windows) | "Windows keeps the Win key for itself." |
| Caps Lock, Insert, Num Lock | "Caps Lock would also switch capitals on and off." |
| Mouse side buttons, before H5 | "Side buttons come with the next update." |
| A combination already registered elsewhere | "Another app is already using Ctrl+Shift+D." |
| Left, right or middle click | ignored, so Cancel can still be clicked |
| Esc | cancels the capture |

**Refactor.** A new `src/main/hotkey-logic.js`, with no Electron, holds:
- `parse`
- `validate(binding, platform)`
- `label(binding, platform)`
- the tap/hold state machine `createTapHold(...)`

`hotkeys.js` keeps the wiring. The macOS agent's darwin branch feeds the same state machine.

**Test.** `bench/hotkeys.js` (`npm run bench:hotkeys`, also part of `npm run bench`):
- **Sequences:**
  - A Right Alt tap starts.
  - Real AltGr+Q events do nothing.
  - Right Alt held 900 ms does nothing.
  - Right Ctrl held 800 ms starts, then finishes on release.
  - Right Ctrl, then C at 120 ms, does nothing.
  - Right Ctrl, then C at 700 ms, starts and then cancels.
  - An F13 tap starts, and another tap finishes.
  - Auto-repeat is ignored.
- **The validator:** every row of the table, and every platform default.
- **The labels:** on both platforms.

By hand: type `@ € { [` on the Turkish layout for a minute in Notepad. No dictation may start.

### H2. "Press the key you want", then "press it again"

The picker lives in the Settings section's hotkey row (W5).

**Before** (`settings.html:50-59`):
```
Hotkey
Tap to start, tap again to finish.
[  Right Alt  |  Ctrl + Shift + Space  ]
```

**After:**
```
Hotkey     [ Right Alt ]                                         Change
           Tap to start, tap again to finish. AltGr + a key still types.

→ Change:
Hotkey     Press the key you want…                               Cancel
           A key like Right Ctrl or F13, a mouse side button, or a combination
           like Ctrl + Shift + Space.                 Use Right Alt (default)

→ pressed Right Ctrl:
Hotkey     [ Right Ctrl ]   Press it once more to check it works…  Cancel

→ heard through the real hook:
Hotkey     [ Right Ctrl ]                                        Change
           ✓ Works. Tap to start, tap again to finish — or hold it while you talk.
```

- **Refusals** show in place, in red, with the H1 sentence. They stay until the next keypress.
- **Capture** happens in the page (`e.code`, `e.button`). Main pauses the live key meanwhile.
  AltGr arrives as a fake `ControlLeft` and then `AltRight` a few ms apart, which reads as Right
  Alt.
- **Main validates and arms** the new key, keeping the old one in hand.
- **The check.** The new key must be heard through the *real* path (uiohook, `globalShortcut` or
  the macOS hook) within 10 s. If it isn't heard, or the window is closed first, the old key is
  restored: "Didn't hear Right Ctrl — Windows may be keeping it for itself. Try another key."
  A key that was never heard is never saved. On Mac this also catches missing Input Monitoring.
- **Checking any time.** While the Typd window has focus, pressing the hotkey does not start a
  dictation; the Settings row (or Home's status card) flashes "✓ Heard Right Alt".

**Test.**
- Change to Right Ctrl, to `Ctrl+Shift+Space`, then back to Right Alt, dictating in Notepad after
  each.
- Try each refused key.
- Start a change and close the window: the old key still works.
- Restart: the new key is kept.
- A screenshot of each state.

### H3. The current key, everywhere it matters

`hotkey-logic.label` is used for:
- the tray status line and tooltip;
- Home's status card and tip line;
- the Settings hotkey row;
- the start-at-login line (today hard-coded "Right Alt", `settings.html:36`);
- the first-run pill note;
- the key-failure messages;
- "press Ctrl+V" / "⌘V".

Tap keys say "tap", combinations say "press". Pill texts stay under about 30 characters.

**Test.** With Right Alt, Right Ctrl and `Ctrl+Shift+Space` in turn, the old key's name appears
nowhere.

### H4. A failed key says so, and offers the fix

- **Before.** A modal dialog (`index.js:490-497`) blames "another application" (on the Right Alt
  path it is actually uiohook failing to load) and points to an env var. A swap refused
  mid-dictation says "That key is taken by another app" (`renderer/settings.js:99`).
- **After.**
  - No dialog. The status (tray line and Home card) says "Right Alt isn't working — Choose another
    key…", which opens the hotkey picker.
  - A combination taken by another program says "Another app is already using Ctrl+Shift+D."
  - A change during a dictation says "Finish the dictation first."
- **Test.** Temporarily rename `node_modules/uiohook-napi` and launch: no dialog, and the status
  says it. Change the key mid-dictation: "Finish the dictation first."

### H5. Mouse side buttons (Windows), after the macOS agent

**Why it waits for suppression.**
- uiohook only listens, so a side button would also be Back in browsers, Explorer and VS Code.
- Pressing it in a web form would navigate away from half-written text (Law 3).

**How.**
- A low-level mouse hook (`WH_MOUSE_LL`), in C# inside the running `inject.ps1` helper, on its own
  thread with a message loop.
- It swallows `XBUTTON1`/`XBUTTON2` only while `Mouse4`/`Mouse5` is bound, and reports
  `{"ev":"mouse","b":4,"down":true}` lines.
- `inject.js` routes those lines to `hotkeys.js`, which feeds them to the H1 state machine.
- It is re-armed on resume and unlock.

**Works today, with no code:** map the button to F13–F24 in Logitech Options+ or G HUB, and H2
accepts it.

**Mac:** this needs an active event tap. That is the macOS agent's call; until then the picker
refuses side buttons there.

**Test.**
- Bind the back button. In Chrome with page history, a press starts a dictation and the page does
  **not** go back. Explorer does not go back either.
- Unbind it: Back works again.
- After sleep and resume, the button still dictates.

---

## 3. Tray (Windows) and menu bar (Mac)

### T1. The menu

**Before** (`index.js:371-382`; right-click only):
```
Dictate    Right Alt           (grey, lined up with spaces)
Revise     select text first   (grey)
Copy last dictation
Forget “Aysel”                (after learning)
Settings…
Quit Typd
```

**After** (the lead's list, plus the status line):
```
Ready — tap Right Alt to dictate              ← status line, grey
─────────
Open Typd
Copy “Thanks for the update, I'll send it…”   ← "Nothing dictated yet" (grey) when empty
Microphone                                 ▸  ● System default
                                              ○ Headset (Jabra Evolve 65)
                                              ○ Microphone Array (AMD Audio Device)
Change shortcut…
─────────
What's new
Send feedback
─────────
Quit Typd
```

**The status line.** One `status` object in main (`src/main/status.js`, a few lines) feeds both
the tray and Home's card. Warm-up, the mic check, hotkey arming and sessions set it.

| State | Line | Clickable? | Icon (T2) |
|---|---|---|---|
| loading | Getting ready… | no | dim |
| ready | Ready — tap Right Alt to dictate | no | solid |
| listening | Listening — tap Right Alt to finish | no | red dot |
| mic blocked | Microphone is blocked — Fix… | opens the OS privacy page | dim |
| key failed | Right Alt isn't working — Choose another key… | opens the hotkey picker | dim |
| model failed | Speech model didn't start — Try again | re-runs warm-up | dim |
| Mac permission | Typd needs Accessibility — Fix… | opens the window's permission block | dim |

**The items.**
- **Open Typd** opens Home.
- **Copy “…”** copies the newest history item (or the last text in memory with history off). The
  preview is cut to about 40 characters, with newlines shown as spaces. It goes through
  `inject.copy`, so it stays out of Win+V history.
- **Microphone ▸** is a radio list: "System default" first, then every input device, with the
  current one checked.
  - The list comes from the always-loaded overlay renderer (`enumerateDevices` at load and on
    `devicechange`), sent to main over a new `overlay:devices` call.
  - A saved device that is unplugged shows as "Headset (not connected)", checked and greyed, while
    Typd uses the default.
  - Picking one writes `mic` and `micLabel`, exactly as the Settings select does.
  - Device names need a `setPermissionCheckHandler` that answers yes for `media` from Typd's own
    pages.
- **Change shortcut…** opens Settings with the hotkey row already waiting for a key.
- **What's new** opens What's new.
- **Send feedback** opens `mailto:contact@mehmetdedeler.com?subject=Typd%20feedback%20(0.1.0,%20Windows)`.
  Only the version and OS name go in the subject, nothing about the user.
- **"Forget learned word “Aysel”"** stays (decision 7). It sits under Copy and appears only right
  after a word is learned, as the one-click way back from a wrong lesson (Law 3).
- **Clicks.** Left-click on Windows opens the menu, and double-click opens Home. On Mac a click
  opens the menu.
- **The tooltip** follows the status: "Typd — ready · Right Alt".

**Files:** `src/main/index.js` (menu), new `src/main/status.js`, `src/preload/overlay.js` and
`src/renderer/overlay.js` (device list), `bench/wiring.js` (the new call).

**Test.**
- Launch and open the menu at once: "Getting ready…", then "Ready — tap Right Alt…".
- Dictate: the Copy row shows the text and copies it.
- Plug in a USB mic: it appears in Microphone ▸. Pick it: Settings shows it too, and the next
  dictation uses it.
- Unplug it: "(not connected)", and dictation still works.
- Each item opens the right section.
- Send feedback opens a mail draft addressed to contact@mehmetdedeler.com.
- Screenshots of the menu in the ready and blocked states.

### T2. The icon

- **Before.** A white 16 px disc at 1× only (blurry at 150%), invisible on a light taskbar, and
  not the mark.
- **After** (through `brand.trayImage`, W7):

  | State | Look |
  |---|---|
  | ready | solid |
  | dim (loading or a problem) | about 45% opacity |
  | listening | the dot in the one red (`#E5483B`) |

  - **Windows.** The ink follows the *taskbar* theme
    (`nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`), at 16/20/24/32 px.
  - **Mac.** A template image (16 pt and @2x). Listening fills the dot; macOS's own orange mic dot
    already signals recording.
- **Test.** Screenshots on light and dark taskbars at 100% and 150%. Start a dictation and the dot
  turns red; cancel and it returns.

---

## 4. First run

### F1. Windows: install, then talk in your own app

1. The installer finishes and Typd starts (packaging agent).
2. **Silent mic check.** `systemPreferences.getMediaAccessStatus('microphone')` reads Windows'
   global setting without opening the mic.
   - If it is `denied`, the Typd window opens on Settings with the Microphone row saying "Windows
     is blocking microphones for desktop apps. [Open privacy settings]". The status says
     "Microphone is blocked — Fix…". This is approved (decision 1).
   - The row clears by itself once access is allowed (re-checked on focus).
3. The tray says "Getting ready…" while the model loads.
4. **First run only:** when ready, the pill shows **"Ready — tap Right Alt and talk"**.
   - It stays until the key is first pressed, or 10 s.
   - Later launches stay silent, including at login.
   - First run means `settings.json` did not exist at launch.
5. **Start at login is applied** on first run, since its default is on. When packaged this uses
   `app.setLoginItemSettings`; in development, the Startup shortcut as now.
6. The user taps Right Alt in the app they were in, talks, taps again, and the text lands.
   - The Typd window does **not** open on first run. Wispr found that practising inside its own
     window made people drop off.
   - The window is one click away: "Open Typd", or search for Typd in Start.

**Test.**
- With a fresh profile (rename `%APPDATA%\typd`, then put it back): the note shows once; relaunch
  and it does not.
- With mic access off: the window opens on the blocked row, and the button opens the right page.
- The login item exists on a fresh profile.
- Stopwatch from the end of install to the first pasted text.

### F2. macOS, with the macOS agent

**What it needs.** `docs/MAC.md` lists three permissions: Microphone, Accessibility and Input
Monitoring.
- Two of them only apply after a restart.
- With ad-hoc signing, an update can silently lose them.

So "can't work" can also happen after an update, not only on first run. The same block must
detect it at every launch.

**The block** sits at the top of the window's Home section; the window opens there only while
something is missing:
```
Three things before Typd can type for you
✓ Microphone                                              Allowed
○ Accessibility — to paste and read what you highlight    [ Open System Settings ]
○ Input Monitoring — to hear Right ⌘ in other apps        [ Open System Settings ]
                                                           [ Restart Typd ]
```
- **Microphone:** the button calls `askForMediaAccess('microphone')`.
- **Accessibility:** the button calls `isTrustedAccessibilityClient(true)`, and opens Settings
  after it.
- **Input Monitoring:** the macOS agent's check from `permissions-mac.js`, or the H2 heard-it
  check ("Press Right ⌘ now").
- The block polls every second and ticks each row as it is granted. **Restart Typd**
  (`app.relaunch()`) appears when a grant needs one.
- When everything is ticked: "Ready — tap Right ⌘ in any app and talk." The first press shows
  "✓ Heard it", and the window closes about 1.5 s later.

**Test** (on a Mac):
- `tccutil reset` for each permission, then launch. Grant each one and watch the ticks.
- Restart when asked.
- Right ⌘ shows "✓ Heard it", and the window closes.
- Dictate into TextEdit.

---

## 5. Paper cuts

| # | Where | Problem | Fix | Effort |
|---|---|---|---|---|
| P1 | `settings.html:36` | "Ready on Right Alt…" is hard-coded | Use the label (H3) | S |
| P2 | `settings.js:16`, `settings-window.js:31-50,68` | Start at login defaults to on but is never applied; the switch shows off on a fresh install | F1 | S |
| P3 | `index.js:490-497` | The hotkey dialog blames another app and points to an env var | H4 | S |
| P4 | `renderer/settings.js:99` | Every refusal says "taken by another app" | The real reason (H2, H4) | S |
| P5 | `index.js:373-374` | Menu rows lined up with spaces, and grey rows that look broken | T1 | S |
| P6 | `index.js:409-413` | Left-clicking the tray does nothing on Windows | T1 | S |
| P7 | `index.js:337-361` | The tray icon blurs at 150% and vanishes on a light taskbar | T2 | M |
| P8 | `index.js:420` | Forced dark theme for everything | W8 | S |
| P9 | `index.js:26-31` | "Keep recordings" is on, but nothing is recorded until the folder exists | The switch alone decides: on records, creating the folder; off records nothing. `TYPD_KEEP_AUDIO` still forces it on. Keep `collect.js` working as the tester-data agent left it (decision 11). **Test:** delete the recordings folder, dictate with the switch on, and a `.wav` and `.json` appear; switch off, dictate, and nothing new appears. | S |
| P10 | `index.js:301` | "press Ctrl+V" on Mac | H3 (the macOS agent may already have done it) | S |
| P11 | `index.js:590` | "No mic access — check settings": which settings? | "Mic blocked by Windows privacy", plus the status line's "Fix…" | S |
| P12 | `settings.html:20` | "Windows default" on Mac | W5 wording | S |
| P13 | the window | No sign of whether Typd is working | Home's status card (W2) | S |
| P14 | `hotkeys.js:5-26`, `:68` | The comment describes two hotkeys; `label()` writes "Ctrl" on Mac | H1 | S |
| P15 | `README.md:44-59, 262-266` | Points to `TYPD_HOTKEY`; "Right Alt is unreachable" is stale | W9 | S |
| P16 | `index.js:605-611` | On Mac, reopening the app does nothing useful | `activate` opens Home (W1) | S |
| P17 | `renderer/settings.js:8-12` | Errors vanish after 4 s | Refusals stay until the next action (H2) | S |
| P18 | `pipeline/context.js:43` | `VOCAB_FILE` was built from `%APPDATA%`, which is empty on a Mac | **Fixed by the lead** (decision 9). W4 and `bench/home.js` use `VOCAB_FILE` as it now stands, and `history.json` goes in the same folder | — |
| P19 | `package.json` `build.files` | `!**/*.md` would drop the bundled CHANGELOG.md | I add an exception in Phase 2 (decision 10) | S |

---

## Not in this plan

- **A hold/toggle switch.** Auto covers both (H1).
- **Several bindings for one action.** It is the same gesture, but more to explain and test. Later,
  if asked for.
- **A theme switch in the window.** The windows follow the system and the pill stays as it is
  (decision 2). The parked Dark/Light/Auto switch goes.
- **Charts, goals, streaks, "you're on a roll" moments, badges on What's new, Windows toast
  notifications, a login-time window** (W9).
- **A setup wizard on Windows.** The first dictation happens in the user's own app.
- **An update button.** Not until there is a real update check.

## How Phase 2 checks itself

- **Before each edit:** re-read the file, because other agents' changes land first. No copies to
  the scratchpad; `src/` is in git. I don't commit; the lead does.
- **After each item:**
  - `node --check` on every edited `.js`
  - `npm run bench:wiring`
  - `npm run bench:learn`
  - the new `npm run bench:hotkeys` and `npm run bench:home`
- **At the end:** restart Typd for real (`scripts/restart_typd.ps1`). Dictate with the default key
  and with a changed key, then use History, Dictionary and Settings with real data.
- **Screenshots:**
  - **The window:** every section, light and dark, via `webContents.capturePage()` from a small
    Electron script in the scratchpad (no new app flags).
  - **The tray menu and the Microphone submenu:** a desktop screen capture while they are open.
  - **The pill:** before and after W8, for the pixel comparison.
