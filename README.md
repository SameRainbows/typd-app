# Typd

Voice dictation that runs on your computer.

[![Typd turning spoken sentences, fillers and restarts included, into finished text](https://github.com/SameRainbows/typd-app/releases/download/launch-video/typd_flip_loop.gif)](https://github.com/SameRainbows/typd-app/releases/download/launch-video/typd_launch_16x9.mp4)

Real recordings, real Typd output, a stylized reconstruction. [Watch the video with sound (MP4, 39 s)](https://github.com/SameRainbows/typd-app/releases/download/launch-video/typd_launch_16x9.mp4).

Tap a key and talk the way you actually think. One speech model, running locally, hears you and
writes the finished text — fillers gone, self-corrections resolved, lists and numbers written
properly — and pastes it into the app you were typing in. Highlight some text first and what you
say is taken as an instruction instead: "make this shorter", "turn this into a list".

This repository is the app's source code, under the **GPL-3.0** ([LICENSE](LICENSE)).

## Download

**Typd 0.2.11** for Windows 10/11 (x64) and Apple-silicon Macs:
**[typd.mehmetdedeler.com](https://typd.mehmetdedeler.com/download/)**.

- The installer has no model in it. On first launch Typd downloads the one that suits your
  computer, once:
  - **Full**: P2d, 1.7B parameters (1.4 GB), on a PC with an NVIDIA GPU with 4 GB of memory or
    more, or a Mac with 16 GB of memory or more;
  - **Light**: 0.6B parameters (0.6 GB), everywhere else.

  **Model** in Settings changes it.
- After that download, dictation works offline.
- The installers are not signed by Apple or Microsoft yet: macOS wants **Open Anyway** in System
  Settings, Windows shows a security warning (**Run**). The download page shows both steps.
- **Language:** English. The model is trained on English dictation; while it writes, it is held to
  English or Turkish, so a short phrase never comes out in another language or script.

## How accurate

The full model (P2d) against Wispr Flow (Pro). Word error rate on the words that carry meaning
(case, punctuation and number style ignored); lower is better. Wispr Flow's outputs were only
scored, never trained on.

| Test | Typd (P2d) | Wispr Flow |
|---|---:|---:|
| 70 real dictations, one speaker (the developer) | **3.5 %** | 6.1 % |
| AASR-Bench: 407 English dictations full of self-corrections, synthetic voices | **8.5 %** | 8.75 % |
| … AASR-Bench clips where real content was dropped | **4** | 6 |

One speaker is a small sample, and on AASR-Bench the two are close. The light model is a little
less accurate (4.0 % and 9.1 % on the same two tests).

## What is here, and what is not

| | |
|---|---|
| **Here (GPL-3.0)** | The desktop app: hotkeys, recording, the dictation pipeline, pasting, the overlay and the Typd window, history and dictionary, sharing (asked on first launch), model and app updates, packaging scripts, benches and docs. |
| **Not here** | The dictation model's weights. They are downloaded separately and licensed under [MODEL_LICENSE.txt](MODEL_LICENSE.txt), not the GPL. |
| **Not here** | The research and training that produced the model, and the server code behind sharing and updates. The app talks to that server only through the public routes described below. |

## How it works

```
dictate:  mic ─16 kHz PCM─► typd-dictate (local, llama-server) ─► clipboard ─► Ctrl+V ─► your app
revise:   mic ─► typd-dictate, with the highlighted text and your spoken instruction ─► paste over it
```

- **One model, not two.** `typd-dictate` is [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)
  (Apache-2.0, 1.7B or 0.6B) fine-tuned to write what you meant rather than every word you said.
  It runs in [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, started at launch
  and kept resident, so no dictation waits for a load. It uses the GPU when it can (CUDA on Windows,
  whose libraries are downloaded after the model on a PC with an NVIDIA GPU; Metal on a Mac) and
  works on the CPU alone, more slowly.
- **Long dictations arrive about as fast as short ones.** From about 20 seconds on, the full model
  starts writing while you are still talking.
- **Low-memory mode.** With the light model, or on a computer with less than 8 GB of memory, the
  model uses about 0.8 GB, with a small llama.cpp patch to its audio encoder
  (`patches/llama.cpp/`, built by `scripts/build-mtmd.js`).
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
  When there is no text field to paste into, a small card offers **Copy** instead
  (`src/main/pasteTarget.js`).
- **The hotkey.** Right Alt on Windows (only a clean tap counts, so AltGr chords keep working),
  Right ⌘ on a Mac; any other key can be chosen in Settings. The rules are
  `src/main/hotkey-logic.js`.
- **The self-test.** Every time the model starts, Typd transcribes `test/fixtures/dictation-3s.wav`
  (a synthetic text-to-speech clip) before using it. A GPU that answers wrong is caught and the
  model is moved to the CPU.

## Privacy

- **Dictation runs on your computer.** The model runs locally and needs no network to dictate;
  history and the dictionary stay in your user folder (`%APPDATA%\typd` on Windows,
  `~/Library/Application Support/typd` on a Mac).
- **Sharing is opt-in, asked on first launch.** The walkthrough's first screen asks whether to
  share your dictations (audio and text) to help train the model, with **Share** and **Don't
  share** and nothing pre-selected; nothing is shared until you choose **Share**. An install from
  0.2.4–0.2.6, when sharing was on by default, is asked once too, and **Don't share** there also
  deletes what it had shared. **Share dictations** in Settings changes it anytime.
- **What a shared dictation is:** the audio, the text Typd pasted or copied (not a revision of
  selected text), the app's process name, the model and its version, timings, OS and versions;
  never what is on your screen, your selection or window titles. At most 50 dictations or 20 MB a
  day. **Delete what I've shared** deletes everything stored for your install on the server. The
  code is `src/main/sharing.js` and `src/main/collect.js`; `TYPD_NO_SHARE=1` turns it off for one run.
- **Update checks** (packaged builds only) send the app version, the model version, the OS and an
  anonymous random install ID, so the developer can count which versions are in use
  (`src/main/versionStats.js`). Runs from source send none of it.

## Updates

- **Model updates** (`src/main/modelUpdate.js`). A packaged Typd reads the published model
  manifest every hour and follows it only if its **Ed25519 signature** verifies with a key built
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
node scripts/fetch-model.js --accept-license   # the full model, ~1.4 GB, into models/typd-dictate/ (read MODEL_LICENSE.txt first)
```

`fetch-model.js` downloads what a packaged Typd downloads for its model updates: it checks the
manifest's signature with the app's own code and every file's sha256 (`--check` only reads and
verifies the manifest).

Then llama.cpp's server, release b11351:

- **macOS:** `npm run fetch:llama-mac` downloads the official llama.cpp release, checks its SHA-256
  and keeps what `llama-server` needs in `vendor/llama-mac/<arch>/`.
- **Windows:** put `llama-server.exe` and its DLLs from the llama.cpp b11351 Windows release (the
  CUDA 12 x64 build for an NVIDIA GPU, with its `cudart` package; or the CPU build) into
  `vendor/llama/`.
- Optional, for low-memory mode's smaller audio encoder: the patched `mtmd` library,
  `npm run build:mtmd:win` on Windows (Visual Studio 2022) or `node scripts/build-mtmd.js mac arm64`
  on a Mac (Xcode tools and cmake). An unpatched llama.cpp works too, with more memory.

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
node bench/sharing.js      # sharing: enrollment, limits, flags, delete (a fake server)
node bench/share-choice.js # sharing is asked; nothing is shared before Share (a headless Chrome or Edge, if there is one)
node bench/no-modal.js     # none of Typd's dialogs can stop Typd
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
src/renderer/        the overlay pill, the Typd window (with the walkthrough), the flag window
scripts/             packaging hooks, icon builds, llama.cpp and model fetchers
patches/             the llama.cpp patch (low-memory mode)
bench/               the tests and measurements that decided the design
design/              standalone design studies, openable in a browser
parked/              working code taken out of the app for now
docs/                UX plan, macOS notes, the tester kit
```

[ROADMAP.md](ROADMAP.md) is where Typd is going; [CHANGELOG.md](CHANGELOG.md) is what changed.

## Contributing

Issues and pull requests are welcome. Typd is developed in a private repository and copied here,
one commit per private commit: an accepted pull request is applied there by hand and comes back
here with the next sync. The benches run in the private repository; this one runs only the
maintainer-started macOS build. Security problems: see [SECURITY.md](SECURITY.md).

## Licence

- The app's source code: **GNU General Public License v3.0** ([LICENSE](LICENSE)). Copyright (c)
  2026 Mehmet Dedeler.
- The dictation model: [MODEL_LICENSE.txt](MODEL_LICENSE.txt). It is not covered by the GPL. Its
  base model, Qwen3-ASR, is Apache-2.0.
- Dependencies keep their own licences (Electron and uiohook-napi: MIT; llama.cpp, downloaded
  separately: MIT).
- The launch video's speech clips: Earnings-22 (CC BY-SA 4.0), AMI Meeting Corpus (CC BY 4.0),
  Common Voice Spontaneous Speech (CC0).
