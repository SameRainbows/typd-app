# Typd on a Mac

## Which file

| Your Mac | File |
|---|---|
| Apple chip (M1, M2, M3, M4…) | `Typd-0.1.0-mac-arm64.dmg` |
| Intel chip | `Typd-0.1.0-mac-x64.dmg` |

To check which chip you have, open the Apple menu  → **About This Mac** and look at **Chip** (or
**Processor**). You need macOS 13.3 (Ventura) or newer. The download is about 650 MB because the
speech model is inside it. Nothing you say is ever sent anywhere.

## Install

1. Double-click the `.dmg` file. A window opens.
2. Drag **Typd** onto **Applications**.
3. Eject the disk image (the eject button next to "Typd" in Finder's sidebar).

## Open it the first time

Apple has not checked Typd, so the first time you open it the Mac stops it. You do this once.

1. Open **Applications** and double-click **Typd**. A message says it cannot be opened or that Apple
   could not verify it. Click **Done** (or **OK**). Do not click "Move to Trash".
2. Open **System Settings** → **Privacy & Security**. Scroll down to the **Security** section. It
   says *"Typd" was blocked…*. Click **Open Anyway**, enter your password, and then click **Open**.

On macOS 13 or 14 you can also right-click (or Control-click) Typd in Applications, choose **Open**,
and then click **Open** again.

**If that does not work**, or the Mac says Typd "is damaged", open **Terminal** (in Applications →
Utilities), paste this line, and press Return:

```
xattr -dr com.apple.quarantine /Applications/Typd.app
```

Then open Typd normally. This line only removes the "downloaded from the internet" mark from Typd.

## Give it three permissions

Typd needs three permissions. Each one is a switch in **System Settings → Privacy & Security**.
macOS asks for some of them by itself. If it does not, turn them on yourself.

| Permission | Why Typd needs it |
|---|---|
| **Microphone** | To hear you. It listens only after you press the Typd key, and stops when you finish. |
| **Accessibility** | To type the finished text into the app you were using (it presses ⌘V for you) and to read the text you highlighted when you ask it to change that text. |
| **Input Monitoring** | To notice when you press the Typd key while another app is in front. It watches only for that key. It does not record what you type. |

For each one: open **System Settings → Privacy & Security**, click the permission, and turn on
**Typd**. If Typd is not in the list, click **+**, choose Typd from Applications, and turn it on.

After you turn on Input Monitoring, **quit Typd and open it again**. macOS only applies that one
when the app starts. Accessibility works as soon as you turn it on.

If a message asks to let Typd control **System Events**, click **OK**. Typd uses it to read the
text you highlighted and the text around your cursor, so it can learn the words you correct. The
paste itself (⌘V) does not need it: Typd presses ⌘V directly.

**After an update:** a new version can lose these permissions, because the app is not signed with
an Apple developer ID. If dictation stops pasting or the key stops working, go to each list, select
Typd, remove it with **–**, then add it again with **+**.

## Use it

Typd lives in the **menu bar** at the top right of the screen, with no Dock icon. Click its icon to
see whether it is ready and which key to press, switch microphones, change the key, open the Typd
window (Home, History, Dictionary, Settings), or quit. While the Typd window is open, Typd also
shows in the Dock and in ⌘Tab.

Press the Typd key once and talk. Press it again and the text appears where your cursor is. To
change some text, highlight it, press the key, say what to change ("make this shorter"), and press
the key again.

The first start after installing can take a few seconds while the Mac prepares the speech model.

## Quit

Click the Typd icon in the menu bar and choose **Quit Typd**.

On a MacBook with a notch, the menu bar can run out of room and hide Typd's icon. Then open Typd
again from Applications or Spotlight and its window opens. To quit without the icon, open **Activity Monitor** (Applications → Utilities), search for **Typd**,
select it, and click the **✕** button at the top → **Quit**.

## Uninstall

Quit Typd and drag it from Applications to the Trash. Your dictionary and settings are kept in
`~/Library/Application Support/Typd`. Delete that folder if you want them gone too. To remove the
permissions, select Typd in each Privacy & Security list and click **–**.

---

## For whoever builds it

You need a Mac with Node 24, and the model (`node scripts/fetch-model.js --accept-license`; see MODEL_LICENSE.txt).

```bash
npm ci
mkdir -p models/typd-dictate
node scripts/fetch-model.js --accept-license          # the current model (MODEL_LICENSE.txt)
npm run dist:mac        # fetches llama.cpp b11351 for arm64 + x64, then builds
```

This makes `dist/Typd-<version>-mac-<arch>.dmg` and `.zip` for both chips. To build one chip only,
run `node scripts/fetch-llama-mac.js arm64 && npx electron-builder --mac dmg zip --arm64` (name
the targets: with `--arm64` alone, electron-builder still builds every arch listed in package.json).

- **The model.** `scripts/before-pack.js` reads `models/typd-dictate/model.json` and ships only the
  model and mmproj it names (and its `revise_lora` adapter, if it names one). A new model needs a new release (model files plus `SHA256SUMS`) and a
  new `MODEL_TAG` in `.github/workflows/mac.yml`.
- **llama.cpp.** `scripts/fetch-llama-mac.js` downloads the official macOS builds of the release
  Windows uses (b11351), checks their SHA-256, and keeps only `llama-server` and the libraries it
  loads, in `vendor/llama-mac/<arch>/`. Apple chips use Metal. Intel Macs use the CPU, because
  llama.cpp's Intel build has no Metal. The script explains how symlinks and executable bits are
  kept through packaging.
- **Signing.** The app is ad-hoc signed by `scripts/after-pack.js` (`codesign --sign -`), which
  works only on a Mac. Ad-hoc signing makes the app run on Apple chips and keeps it from being
  reported as "damaged". It does not get past Gatekeeper; that needs a paid Apple Developer ID and
  notarization. That is also why permissions do not survive updates.
- **CI.** `.github/workflows/mac.yml` runs on pushes to `dev` and by hand (Actions → macOS → Run
  workflow, where you can also choose x64 or both). It builds, checks the signature and
  Info.plist, transcribes `test/fixtures/dictation-3s.wav` with the bundled server and model, and
  uploads the dmg as the `Typd-mac-arm64.dmg` artifact. The dmg contains the private model, so it must
  stay in a private repository.
- **Tester build.** Set `TYPD_TESTER_CONFIG` to a tester's `tester.json` and build. The file is
  copied to `Contents/Resources/tester.json` before signing, which turns on
  tester sharing (`src/main/sharing.js`). Without the variable, the build contains no `tester.json`.
  ```bash
  TYPD_TESTER_CONFIG=~/tester.<name>.json npx electron-builder --mac dmg --arm64 \
    -c.directories.output=dist/tester '-c.mac.artifactName=${productName}-${version}-mac-${arch}-tester.${ext}'
  ```
  On Windows: `$env:TYPD_TESTER_CONFIG='...\tester.<name>.json'; npm run dist:win`. In CI, the
  repository secret `TYPD_TESTER_JSON` does the same and the tester dmg is uploaded as
  `Typd-mac-arm64-tester.dmg` (kept one day). The file holds an upload key, so never commit it,
  attach it to a release, or send the tester dmg to anyone else.
- **Check the server by hand:**
  `node scripts/smoke-llama.js --server dist/mac-arm64/Typd.app/Contents/Resources/llama/llama-server --models dist/mac-arm64/Typd.app/Contents/Resources/models/typd-dictate`
