# Typd

Voice dictation that runs on your computer.

Tap a key and talk the way you actually think. One small speech model, running locally, hears you
and writes the finished text — fillers gone, self-corrections resolved, lists and numbers written
properly — and pastes it into whatever app you were typing in. Highlight some text first and what
you say is taken as an instruction instead: "make this shorter", "turn this into a list".

Typd is a desktop app for Windows and macOS, built with Electron, with the model served by
[llama.cpp](https://github.com/ggml-org/llama.cpp). Website and demo video:
[typd.mehmetdedeler.com](https://typd.mehmetdedeler.com).

This repository is the app's source code, under the **GPL-3.0** ([LICENSE](LICENSE)).

## What is here, and what is not

| | |
|---|---|
| **Here (GPL-3.0)** | The desktop app: hotkeys, recording, the dictation pipeline, pasting, the overlay and the Typd window, history and dictionary, opt-in sharing, model and app updates, packaging scripts, benches and docs. |
| **Not here** | The dictation model's weights. They are downloaded separately and licensed under [MODEL_LICENSE.txt](MODEL_LICENSE.txt), not the GPL. |
| **Not here** | The research and training that produced the model, and the server code behind sharing and updates. The app talks to that server only through the public routes described below. |

## How it works

```
dictate:  mic ─16 kHz PCM─► typd-dictate (local, llama-server) ─► clipboard ─► Ctrl+V ─► your app
revise:   mic ─► typd-dictate, with the highlighted text and your spoken instruction ─► paste over it
```

- **One model, not two.** `typd-dictate` is [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)
  (Apache-2.0) fine-tuned to write what you meant rather than every word you said. It runs in
  llama.cpp's `llama-server`, started at launch and kept resident, so no dictation waits for a load.
  It uses the GPU when there is one (CUDA on Windows, Metal on Apple chips) and works on the CPU
  alone, more slowly.
- **Revising** runs on the same local model when the model supports it (`"revise": true` in its
  `model.json`, with an optional LoRA adapter switched on for revise requests only). Otherwise it
  falls back to a cloud model (`src/main/pipeline/cleanup.js`, which needs `POOLSIDE_API_KEY`).
- **What is on screen decides the mode.** Nothing highlighted: dictate. Something highlighted:
  revise it. No model guesses which one you meant.
- **Screen context.** At the start of a dictation Typd reads the text around your cursor and
  your dictionary as a spelling hint, so names and terms come out right. That text is treated as
  untrusted data, never as an instruction (`bench/formatting.js` and `bench/revise.js` check it).
- **It learns your words.** Correct a misheard name in what Typd just pasted and it is added to
  your dictionary (`src/main/learn.js`); the tray offers to forget it again.
- **Pasting.** Windows has no "type this into the focused app" API, so Typd stashes the clipboard,
  writes the text, sends Ctrl+V through one long-lived PowerShell helper (`src/main/inject.ps1`)
  and puts your clipboard back. On a Mac it uses a small helper of its own (`src/main/inject-mac.js`).
- **The hotkey.** Right Alt on Windows (only a clean tap counts, so AltGr chords keep working),
  Right ⌘ on a Mac; any other key can be chosen in Settings. The rules are
  `src/main/hotkey-logic.js`.
- **The self-test.** Every time the model starts, Typd transcribes `test/fixtures/dictation-3s.wav`
  (a synthetic text-to-speech clip) before using it. A GPU that answers wrong is caught and the
  model is moved to the CPU.

## Privacy

- **Dictation never leaves your computer.** The model runs locally; history and the dictionary
  stay in your user folder (`%APPDATA%\typd` on Windows, `~/Library/Application Support/typd` on
  a Mac).
- **Sharing is opt-in.** On its first run a packaged Typd asks once whether you want to share your
  dictations to help improve it. Nothing is shared, queued or sent unless you choose **Share my
  dictations to improve Typd**. A shared item is the audio, the pasted text, the app's process
  name, timings, OS and versions; never what is on your screen, your selection or window titles.
  Settings turns it off at any time, and **Delete what I've shared** deletes everything stored for
  your install on the server. The code is `src/main/sharing.js`, `src/main/collect.js` and
  `src/renderer/consent.html`.
- **Update checks** (packaged builds only) send the app version, the model version, the OS and an
  anonymous random install ID, so the developer can count which versions are in use
  (`src/main/versionStats.js`). Runs from source send none of it.

## Updates

- **Model updates** (`src/main/modelUpdate.js`). A packaged Typd reads the published model
  manifest every 6 hours and follows it only if its **Ed25519 signature** verifies with a key built
  into the app (`src/main/modelManifestKey.js`). It downloads a new version in the background
  (resumable, every file checked against the manifest's size and sha256) and switches to it only
  when you are not dictating. If the new model fails to start or fails its self-test, the previous
  one comes back.
- **App updates** (`src/main/appUpdate.js`). A packaged Typd downloads a newer version, then
  installs it only while you are away: a helper script (`src/main/app-update/`) swaps the app
  folder, starts the new version, and puts the old one back if the new one does not pass its
  start-up check. Nothing is installed unless the manifest's **Ed25519 signature** verifies against
  the public key built into the app (`src/main/appUpdateKey.js`); a sequence number stops old
  manifests being replayed.
- Runs from source (`npm start`) never update themselves. **If you package your own build**, it
  will follow the official update channel unless you start it with `TYPD_NO_APP_UPDATE=1` (and
  `TYPD_NO_MODEL_UPDATE=1` to keep your model).

## Build and run from source

You need [Node.js](https://nodejs.org/) 24 and Git, on Windows 10/11 (x64) or macOS 13.3+.

```bash
npm ci
node scripts/fetch-model.js --accept-license   # the model, ~1.5 GB, into models/typd-dictate/ (read MODEL_LICENSE.txt first)
```

`fetch-model.js` downloads what a packaged Typd downloads for its model updates: it checks the
manifest's signature with the app's own code and every file's sha256 (`--check` only reads and
verifies the manifest).

Then llama.cpp's server:

- **macOS:** `npm run fetch:llama-mac` downloads the official llama.cpp release (b11351), checks
  its SHA-256 and keeps what `llama-server` needs in `vendor/llama-mac/<arch>/`.
- **Windows:** put `llama-server.exe` and its DLLs from a llama.cpp Windows release (the CUDA 12
  x64 build for an NVIDIA GPU, with its `cudart` package; or the CPU build) into `vendor/llama/`.
  Use a build at least as new as the one the Mac script pins, since Qwen3-ASR audio support is recent.

```bash
npm start              # run Typd
npm start -- --stub    # the overlay with canned responses: no model, no server
```

Packaging (unsigned): `npm run dist:win` (NSIS installer) or `npm run dist:mac` (dmg and zip;
must run on a Mac, which signs the app ad hoc). `scripts/before-pack.js` ships only the model that
`models/typd-dictate/model.json` names. See [docs/MAC.md](docs/MAC.md) for the Mac details.

The official macOS builds come from [.github/workflows/mac.yml](.github/workflows/mac.yml). Only a
maintainer can start it, and it never runs on pushes or pull requests. It signs the app with
Typd's own certificate and puts the dmg and the app-update package on a draft release, which only
maintainers can see. An app update reaches users only after a maintainer signs it, with a key that
is never on GitHub.

`TYPD_DEBUG=1` logs what the pipeline, selection reading and updates are doing.

## Tests

The benches need no model, no Electron window and no network:

```bash
node bench/wiring.js       # the overlay's and the window's seams
node bench/hotkeys.js      # AltGr+Q never starts a dictation; every key's gesture and refusal
node bench/home.js         # history, undo, the dictionary
node bench/learn.js        # which corrections are learned, and which edits are not
node bench/updates.js      # model updates: download, resume, verify, switch, revert; the self-test
node bench/lora.js --no-model   # the revise adapter's requests, against a fake server
node bench/sharing.js      # consent gating, enrollment, flags, opt-out, delete (a fake server)
node bench/versions.js     # version headers on update checks; nothing from source runs
node bench/app-update.js   # signed app updates, idle gating, real installs and rollbacks with the helper, in a temp folder
node bench/public-build.js # a public build carries no key
```

`node bench/formatting.js` and `node bench/revise.js` (the prompt suites) and `python bench/asr.py`
call a cloud model or need recordings; `npm run bench` runs the whole set, so it needs those too.
`npm run smoke` and `node bench/lora.js` with the model files exercise the real `llama-server`.

## Layout

```
src/main/            the main process: hotkeys, sessions, pasting, tray, updates, sharing
src/main/pipeline/   the local model (local.js), prompts, context, the cloud fallback (cleanup.js)
src/main/app-update/ the helper scripts that swap in an app update
src/renderer/        the overlay pill, the Typd window, the consent and flag windows
scripts/             packaging hooks, icon builds, llama.cpp and model fetchers
bench/               the tests and measurements that decided the design
design/              standalone design studies, openable in a browser
parked/              working code taken out of the app for now
docs/                UX plan, macOS notes, the tester kit
```

[ROADMAP.md](ROADMAP.md) is where Typd is going; [CHANGELOG.md](CHANGELOG.md) is what changed.

## Contributing

Issues and pull requests are welcome. Typd is developed in a private repository and copied here,
one commit per sync: an accepted pull request is applied there by hand and comes back here with the
next sync. Continuous integration runs in the private repository; this one has none.
Security problems: see [SECURITY.md](SECURITY.md).

## Licence

- The app's source code: **GNU General Public License v3.0** ([LICENSE](LICENSE)). Copyright (c)
  2026 Mehmet Dedeler.
- The dictation model: [MODEL_LICENSE.txt](MODEL_LICENSE.txt). It is not covered by the GPL. Its
  base model, Qwen3-ASR, is Apache-2.0.
- Dependencies keep their own licences (Electron and uiohook-napi: MIT; llama.cpp, downloaded
  separately: MIT).
