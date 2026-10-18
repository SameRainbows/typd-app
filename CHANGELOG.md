# What's new

## 0.2.8 · October 2026

- **Sharing is your choice.** A new install asks on its first screen whether to share your dictations (audio and text) to help train Typd's model, with nothing pre-selected, and shares nothing until you choose **Share**. Installs from before this change that were never asked see the same short question once; choosing **Don't share** there also deletes anything they had already shared. You can change it anytime in Settings.
- **Copied dictations count too.** When sharing is on, a dictation Typd could not paste and left on the clipboard ("Copied — press Ctrl+V") is shared like any other.
- **Low-memory mode.** On computers without a strong GPU, Typd's model now uses about 0.8 GB of memory instead of 1.4 GB, with the same accuracy. Long dictations are written in shorter pieces, and in this mode you can revise up to about 250 words at a time. It is on automatically with the Light model or on a computer with less than 8 GB of memory; **Settings → Low-memory mode** turns it on or off.
- **Steadier on slow processors.** A long dictation on a slow computer is given more time to start writing before Typd calls it stuck.

- **The ✕ and ✓ on the recording pill work again.** On some Windows PCs a click went straight through the pill. The buttons now take every click, on Windows and on a Mac, and the pill still never takes the focus from the app you are typing in. Typd also no longer watches every mouse move on the computer while the pill is up, so the pointer stays smooth while Typd is busy.
- **Dictate sooner on a new PC with an NVIDIA GPU.** If the full model would take more than a few minutes to download, Typd first fetches the smaller Light model so you can dictate right away, then gets the full model in the background and switches to it the next time you are not dictating. Home says which model you are using and how far the full one is.
- **No more slow dictation while the GPU libraries download.** On a PC with an NVIDIA GPU, Typd no longer runs the full model on the processor while the GPU libraries download (which made it lag): it starts the full model together with them, and until both are ready it uses the Light model or waits.
- **Sharing is sturdier and explains itself.** A file briefly locked by an antivirus no longer stops a dictation from being shared, and **Copy diagnostics** now says whether sharing is on, what was shared and, if nothing was, why. Typd also keeps a short timing line for each dictation there (how long the text took, on which model and device), never the words.

- **A much smaller download.** The installer no longer carries the speech model. On its first start Typd downloads the one that suits your computer (about 0.6 GB, or 1.6 GB on a PC with a strong NVIDIA GPU), checks it, and from then on works offline. The tray, Home and the walkthrough show how far it is, and on a metered connection Typd asks first.
- **GPU acceleration when your PC can use it (Windows).** On a PC with an NVIDIA GPU of 4 GB or more, Typd downloads NVIDIA's GPU libraries (about 340 MB) after the model and switches to them by itself as soon as you are not dictating. Until then, and on every other PC, Typd runs on the processor, so you can dictate right away. A PC that updates from an earlier Typd keeps the libraries it has and downloads nothing.
- **Updates arrive sooner.** Typd looks for a new version and a new model every hour, when it starts, and when your computer wakes up. It always installs the newest one directly, never one step at a time.
- **Check for updates** in the tray menu and in Settings, under the version. It says whether Typd is up to date, shows a download as it goes, and when a new Typd is ready, **Restart now** installs it straight away instead of waiting until you step away.

## 0.2.4 · October 2026

- **Closing the Typd window on a Mac keeps Typd running.** The red button closes only the window; Typd, its menu-bar icon and its key stay. Typd no longer appears in the Dock while its window is open (turn on **Show Typd in the Dock** in Settings if you want it there).
- **Copy diagnostics** in the menu-bar menu copies Typd's own log, never anything you dictated, so you can send it when something goes wrong.
- **The walkthrough is for new installs only.** Updating Typd never shows it; **Show the walkthrough** in Settings still opens it.
- **Sharing is on to help improve Typd.** Your dictations are shared to train the model, so it gets better for everyone. A new install's walkthrough says so on its first screen, and **Share dictations** in Settings turns it off at once. If you turned sharing off before, it stays off. What is shared has not changed: **What's shared** in Settings lists it. Dictating itself still runs on your computer and works offline.
- **No more first-run question about sharing.** The consent window is gone; Settings has the switch, **What's shared** and **Delete what I've shared**.
- **Send my past dictations.** If you share, Settings can also send the recordings Typd kept before, once and slowly over a few hours, skipping any already shared. Never while sharing is off.
- **Sharing stays light.** At most 50 dictations (or 20 MB of audio) a day are shared, and Typd waits quietly when the server is busy or full instead of trying again and again.

## 0.2.3 · October 2026

- **Long dictations finish much sooner.** Typd now writes a long dictation while you are still talking, so the text arrives a second or two after you stop instead of many seconds later.
- **Cleaner joins in long dictations.** No doubled or invented words where one piece meets the next, and full stops and capitals where they belong.
- **Revising never pastes a broken result.** When nothing changed, when your instruction came back, or when part of your text went missing, your selection stays and Typd says so. You can now revise up to about 1,000 words at once.
- **The right model for your computer.** Typd picks the full model or a lighter, faster one for your hardware. Change it under **Model** in Settings.
- **Asks before big downloads.** On a metered connection, Typd asks before downloading a large new model. **Ask before downloading new models** in Settings makes it ask every time.
- **A short walkthrough** on first start shows a dictation, a revision and **That was wrong**. **Show the walkthrough** in Settings opens it again.

## 0.2.2 · October 2026

- **Mac permissions stay on.** Typd is now signed with its own certificate, so macOS keeps Accessibility, Microphone and Input Monitoring on when Typd updates itself. After this one update you may need to switch them on once more; from then on they stay.
- **Signed model updates.** Typd installs a new dictation model only when it carries the developer's signature.
- **Use it for work.** The model licence now allows any use, work and commercial work included. The model files stay inside Typd.

## 0.2.1 · October 2026

- **Update checks count versions.** When Typd checks for an update, it now sends its version and the model's version with an anonymous install ID, so the developer can see which versions are in use. The ID is random and made on your computer, it is not your sharing ID, and nothing you say or type goes with it.
- **Shared dictations name their model.** If you share, each dictation and each **That was wrong** now records the exact model version that wrote it, and whether the revise adapter was used.
- **Better models arrive on their own.** When a new dictation model is published, Typd downloads it in the background and switches to it when you are not dictating; if it does not start, the model you had comes back. The tray shows which model you have. Its licence is under **Model licence** in Settings.

## 0.2.0 · October 2026

- **Share your dictations, only if you choose.** On its first start Typd asks once. Nothing is shared unless you pick **Share my dictations to improve Typd**. Change it any time in Settings, where **Delete what I've shared** removes what you sent.
- **That was wrong.** When a dictation comes out wrong, pick **That was wrong…** in the tray, or press Alt + Shift + Backspace (Ctrl + Shift + Backspace on a Mac), and add a note if you like. If you don't share, Typd asks before sending that one dictation.
- **Typd updates itself.** A new version downloads in the background and installs while you are away. If it fails its first start, the version you had comes back. The tray says when Typd was updated.
- **Typd stays running on the Mac.** Closing the Typd window no longer quits Typd or stops its key, and Typd no longer hangs at launch once its permissions are on. **Show Typd in the Dock** in Settings keeps its icon in the Dock.
- **Long dictations** are cut at real pauses, so sentences no longer break where a piece ended.
- **Revising** a reply highlighted in a chat app or browser works on Windows, and long speech over a selection is typed as dictation.
- **Your microphone** is found by name when its id changes, instead of falling back to the default one.
- **A new mark** for the tray, the menu bar and the app icon.

## 0.1.0 · October 2026

- **One window for Typd.** Open it from the tray (the menu bar on a Mac), or by starting Typd again: Home, History, Dictionary and Settings in one place. It never opens by itself unless Typd cannot work without you.
- **Pick any key.** In Settings, click **Change** and press the key you want: Right Ctrl, F13, or a combination like Ctrl + Shift + Space. Typd checks that it can hear the key before it keeps it.
- **Hold or tap.** F13–F24 can be held while you talk and let go to finish, or tapped to start and tapped again to finish. Right Alt stays tap-only, so AltGr keeps typing @ on a Turkish keyboard.
- **History.** Find, copy and delete what you dictated. It stays on this computer, for 30 days unless you choose otherwise, and can be switched off.
- **Dictionary.** See the words Typd learned from your corrections and what it heard instead, and add or remove your own.
- **A clearer tray.** The first line says whether Typd is ready, which key to press, and what to do when something is wrong. Switch microphones from the tray.
- **Safer revising.** Highlighting more text than Typd can revise now says so, instead of rewriting only the first part.
- **Typd on the Mac.** Tap Right ⌘ to dictate. Typd asks for the permissions it needs in plain words.
