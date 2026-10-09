# Typd — vision and road

## The vision

**Voice should be a way to work on text, not just a way to enter it.**

Every dictation tool on the market is write-only. You speak, it inserts, the
session ends. The moment the output needs changing you are back on the keyboard,
which means voice is useless for anything that matters — anything you would
revise. Wispr Flow, Typeless, superwhisper, Willow and OpenWhispr all compete on
the same axis: words per minute, and how good the cleanup pass is. That axis is
saturated, the models underneath it are commodity, and an open-source clone of
any of them is a weekend's work.

Typd closes the loop. You speak it, you look at it, you tell it what is wrong,
it changes. Produce, inspect, revise — the second half of writing, which nobody
in this category has built.

Three bets follow from that, and the road below serves them in order:

**The loop is the product.** Not the accuracy, not the speed. Those are the
price of entry. A tool you can talk back to is a different category from a tool
you talk into.

**The people who need this most are not native English speakers.** For a native
speaker dictation is a 1.3× speedup. For someone thinking in one language and
writing in another it is the difference between writing and not writing — and
the anxiety it removes is worth more than the seconds. Every incumbent treats
this as a "translate" mode bolted on the side, because they were all built by
native speakers optimising WPM.

**The only moat is that it compounds.** Models are commodity and features get
copied in a quarter. What cannot be copied is six months of learning how one
specific person writes. Every session must leave the app better at *you*.

## The laws

These settle arguments. When a decision is close, the law wins.

1. **Your voice never leaves the machine.** Recognition is local, permanently,
   even when that costs accuracy. It is the one claim competitors cannot make
   honestly, and it is what makes an always-listening session acceptable.
2. **The overlay is the product.** One small Settings window may exist, for what
   cannot be learned or inferred. It opens only when asked, holds at most five
   controls, and never shows stats; a sixth setting has to replace one. No
   dashboard, no hub, no settings tour, no stats page. (Changed 2026-10-05 after
   `dictation-research/reports/product_preferences_home.md`: Windows hides tray
   icons, so a tray-only app cannot be found or configured by ordinary users.)
3. **Never destroy work that cannot be undone.** Revision overwrites the user's
   own writing. Every destructive path needs a way back before it ships.
4. **It must compound.** A feature that works identically on day 200 and day 1
   is a feature a competitor can clone. Prefer the version that accumulates.
5. **Nothing ships that is not measured.** The bench comes first. "It feels
   better" is a hypothesis, not a result.
6. **Invisible beats clever.** Reliability is the feature. A brilliant tool that
   fails twice a week is uninstalled by the third week.
7. **Restraint is the aesthetic.** Monochrome, one danger red, no decoration
   that is not doing work.
8. **One gesture, unless the state cannot say it.** A new hotkey has to be the
   only way to express something the current state does not already express.
   Dictate and revise share a key because the selection already says which is
   meant; every feature after them clears the same bar. The cost of a chord is
   not the chord, it is that the user has to hold a decision before acting.

## How to read the road

Ten phases. Phase *N* runs from sub-step *(N−1).1* to *N.0*, so the version
number and the progress are the same thing — reaching 1.0 completes phase 1.

Every sub-step names a **test**: how we know it worked, and how we would know if
it made things worse. A sub-step with no test is not a sub-step, it is a wish.
Where a test cannot be automated it says who has to look and at what.

---

# Phase 1 — 0.1 → 1.0 · Make the loop real

The revision turn exists and is unverified. Nothing else matters until you can
use it for a day without falling back to the keyboard.

| # | Step | Test | |
|---|---|---|---|
| 0.1 | Verify the whole-document guard in Zen, Chrome, VS Code, Word, Notepad, Obsidian | Highlight one sentence in each and revise it. Only that sentence changes. `TYPD_DEBUG=1` names the mechanism used per app. | needs you |
| 0.2 | Verify the hotkey does not leak to the host application | Press it over a browser, an editor and an elevated terminal. The page must not react. If it leaks, that confirms integrity-level preemption and the fix is a native hook. | needs you |
| 0.3 | Undo — `Ctrl+Z` after a revision restores the original span | Revise, undo, compare byte for byte. Must hold in all six applications from 0.1. | needs you |
| 0.4 | Detect a lost selection between hotkey press and paste | Press, click elsewhere, finish. It must refuse and say why, not insert at the caret. | **done** |
| 0.5 | Every failure path has a legible message | Force each: no selection, no mic, no key, rejected key, timeout, empty completion. Each shows a sentence a non-programmer understands. | **done** |
| 0.6 | README describes the app that exists | A fresh reader follows it start to finish with no surprises. | **done** |
| 0.7 | Packaging: the injection helper survives `asar` | Build, install to a clean path, dictate. The helper spawns from inside the archive. | config done, build untested |
| 0.8 | Session lifecycle survives abuse | Hammer the hotkey, cancel mid-stream, start a session with and without a selection, unplug the mic. No crash, no stuck overlay, no dead click-region. | two bugs fixed, needs a real hammering |
| 0.9 | First run with no API key is not a dead end | Launch clean. The message says what to do and where to get it, and dictation still records rather than silently failing. | needs you |
| 1.0 | **Milestone — one working day** | Use Typd for a full day of real work. Log every fallback to the keyboard and why. Fewer than three is a pass. | |

Two steps arrived that were not on this list. **Dictate and revise were
collapsed onto a single hotkey**, with the selection deciding the mode — that
belongs to Law 8, which did not exist when the road was written. And **streaming
and result were removed as states**, leaving four: progress moved to a fill
behind the working state, and success is now the pill leaving rather than the
pill announcing. That is Law 6 applied to the interface itself — the pill was
asking to be looked at twice per session for information already on screen.

---

# Phase 2 — 1.1 → 2.0 · The interface becomes the product

Law 2 says the overlay *is* the product. Today it is a placeholder with good
bones. This phase is where design stops being a study and lands.

| # | Step | Test |
|---|---|---|
| 1.1 | Review the four design studies (ferrofluid, arch, refined pill, identity) and pick a direction | Each study self-assesses honestly. Choose on evidence, not novelty. A rejected direction with a written reason is a result. |
| 1.2 | Land the refined pill — proportion, glass, hairline, shadow, radius | Side-by-side at actual size over busy light and dark backgrounds. Screenshot both, judge cold the next morning. |
| 1.3 | Land the voice visualisation | Must read at 36px tall, hold 60fps, and be legible in peripheral vision — you are looking at your document, not at it. |
| 1.4 | Rework the state morph so it reads as one object changing | Auto-play the four states at real timings. If any transition reads as a swap rather than a change, it fails. Controls now fold rather than `display: none`, which was the cause. |
| 1.5 | Revise mode is visibly distinct from dictate | Someone who has never used it identifies which mode is live from a screenshot. It overwrites their writing, and with one hotkey the pill is the only thing that says which mode you are in — ambiguity here is a data-loss risk. |
| 1.6 | Land the mark and wordmark | Judge at 16px in a real taskbar next to real icons. If it needs 32px to work, it is the wrong mark. |
| 1.7 | Replace the procedural tray circle with the real mark | Visible and identifiable in light and dark Windows themes at 100% and 150% scaling. |
| 1.8 | Audit the sound design | Four cues, plus a decision on whether revision needs its own. Each must be identifiable without looking and must not be annoying on the fortieth use. Test with headphones and with laptop speakers. |
| 1.9 | Reduced-motion and high-contrast paths | Force both in Windows settings. Nothing breaks, nothing becomes unreadable, nothing keeps animating. |
| 2.0 | **Milestone: it looks like a product** | Show it to five people cold. Ask what they think it costs. Anything under "$10/month" means the interface is still under-selling the product. |

---

# Phase 3 — 2.1 → 3.0 · The session

The architectural bet. Stop treating dictation as one-shot: hold a session open
and let revision after revision land on the same text. This is the thing no
competitor has, and it only becomes possible once phases 1 and 2 are solid.

| # | Step | Test |
|---|---|---|
| 2.1 | Session state: an open chunk with a tracked region in the target app | Region survives typing above it, scrolling, and window resize. Bench measures how long tracking holds before drift. |
| 2.2 | Second and subsequent turns land on the same region | Ten consecutive revisions on one paragraph. The tenth must be as accurate as the first — no drift, no accumulation of stray whitespace. |
| 2.3 | Undo stack across a session | Five revisions, then "go back" three times. Lands exactly on state 2. |
| 2.4 | An explicit end-session gesture, distinct from end-turn | Users must never be unsure whether the mic is live. Test: after ending, speaking near the machine does nothing observable. |
| 2.5 | Session-scoped context: the model sees the current draft, not just the span | Bench: an instruction referring to something earlier in the draft ("make it match the tone of the first paragraph") must work. |
| 2.6 | Prompt-cache the stable draft prefix across turns | Measure turn 1 vs turn 5 latency. Turn 5 should be materially faster or the caching is not working. |
| 2.7 | Visible, unmistakable listening indicator for the whole session | A stranger looking at the screen can tell the mic is open. Non-negotiable given the mic stays live. |
| 2.8 | Insertion vs instruction stays explicit within a session | Extend the two-hotkey model into session mode. Bench: 50 utterances that are ambiguous in isolation, 100% correctly routed. |
| 2.9 | Graceful degradation when the target app loses the region | Detect and say so rather than pasting into the wrong place. Test by closing the document mid-session. |
| 3.0 | **Milestone: write a page by voice alone** | Dictate a full page, then revise it to publishable without touching the keyboard. Time it. Compare against typing the same page. |

---

# Phase 4 — 3.1 → 4.0 · It compounds

Law 4. Everything in `parked/` was built and tested; this is where it returns,
plus the one thing no competitor does — biasing the recogniser *before* it makes
the error rather than repairing after.

| # | Step | Test |
|---|---|---|
| 3.1 | Restore the dictionary from `parked/` | 9/9 detection tests still pass against current code. |
| 3.2 | Restore learn-from-corrections | Fix a word in a pasted result; it is remembered with no dialog. Measure false-positive rate on ordinary edits — poisoning the dictionary is worse than not learning. **Restored 2026-10-06** (`npm run bench:learn`): on the user's own dictations, 33/35 real fixes learned, 0/1,104 ordinary edits; 5/104 swaps of one name for an unrelated one are learned (they only add a name the user typed). |
| 3.3 | Feed the dictionary into the Parakeet decoder as hotwords, not into the cleanup prompt | Bench WER on your own voice with and without. Repairing after the fact cannot fix what biasing before prevents; the delta is the whole argument. |
| 3.4 | Harvest vocabulary from screen context into a rolling personal lexicon | Names, repo names, product names accumulate without anyone typing them. Measure lexicon precision — junk in the lexicon is worse than a small lexicon. |
| 3.5 | Decay: terms not seen for N weeks fall out | Lexicon size stabilises rather than growing forever. Bench: WER does not regress after decay. |
| 3.6 | Per-application register learned from evidence, not presets | Bench: the same dictation into a code editor and a chat app produces appropriately different output, with no per-app configuration. |
| 3.7 | Revision instructions you repeat become cheaper | If you say "tighten this" fifty times, the fiftieth should be faster and more predictable than the first. |
| 3.8 | Everything learned is inspectable and deletable | Law 3 applied to learning. There must be a way to see and remove what it thinks it knows, without a settings dashboard. |
| 3.9 | Learning survives update and reinstall | Export, reinstall, import. Accuracy on your vocabulary is unchanged. |
| 4.0 | **Milestone: measurably better at you** | Re-run `bench/asr.py` on your own recordings against the phase-1 baseline. The number must have moved, and the movement must be attributable. |

---

# Phase 5 — 4.1 → 5.0 · Speak like yourself

The market wedge. This is where the 10× value is, and where every incumbent is
weakest because none of them were built by someone who needed it.

| # | Step | Test |
|---|---|---|
| 4.1 | Baseline: measure WER on Turkish-accented English and on Turkish | Honest starting number. Parakeet's published WER is on native-speaker corpora and will not hold. |
| 4.2 | Within-sentence code-switching survives recognition | Bench set of mixed Turkish/English sentences. Competitors detect one language per utterance and destroy these. |
| 4.3 | Speak in L1, write in L2 as a first-class path, not a mode | Say it in Turkish, get fluent English. Bench: meaning preserved, register appropriate, no translationese. |
| 4.4 | Fluency repair without meaning drift | Bench: non-native phrasings become native phrasings, and a native reader cannot tell. Meaning must be identical — measure drift explicitly, it is the risk. |
| 4.5 | Proper nouns and loanwords survive the language boundary | Turkish names in English text keep their diacritics and spelling. |
| 4.6 | Revision instructions work in either language | "Bunu kısalt" and "make this shorter" do the same thing to the same span. |
| 4.7 | The recogniser learns your accent specifically | Ties to phase 4. Measure WER on your voice at week 1 vs week 6. |
| 4.8 | Nothing about this is a setting | No language picker, no mode. It works out of the box or the design is wrong. |
| 4.9 | Second-language test with real users | Five non-native speakers, one hour each. The question is not "did it work" but "would you write more because of this". |
| 5.0 | **Milestone: the wedge is real** | A non-native speaker prefers Typd to typing in English. That preference, stated unprompted, is the milestone. |

---

# Phase 6 — 5.1 → 6.0 · Trust

Aggressive cleanup is only usable if the user believes it did not change their
meaning. This is the top churn reason in the category, and nobody addresses it.

| # | Step | Test |
|---|---|---|
| 5.1 | The raw transcript is always recoverable | After any dictation, "what did I actually say" is one gesture away. |
| 5.2 | Show what changed in a revision | The touched span is visibly marked at the moment it lands, then fades. Test: users notice unintended edits they previously missed. |
| 5.3 | Never silently return the original | If the model declined to change anything, say so. Silent no-ops read as broken. |
| 5.4 | Never silently truncate | Token-budget exhaustion must be an error, not a half-finished paragraph pasted over a whole one. |
| 5.5 | Confidence signal on low-quality recognition | When ASR confidence is poor, the interface says so before the text lands rather than after. |
| 5.6 | The injection boundary is visible in the bench, permanently | `bench/revise.js` and `bench/formatting.js` injection cases stay green on every prompt change. Already true; keep it true. |
| 5.7 | Nothing leaves the machine that the user did not compose | Audit every outbound request. Screen context is the risk — it can contain anything on screen. Document exactly what is sent. |
| 5.8 | A visible, honest privacy statement inside the product | One sentence, checkable: "your voice never leaves this machine". If a future feature breaks it, the sentence changes or the feature does not ship. |
| 5.9 | Failure modes are boring | Every error leaves the user's document exactly as it was. Test by killing the process at each pipeline stage. |
| 6.0 | **Milestone: trusted with real work** | Use it on something that matters — a real email, a real document — without re-reading every word. |

---

# Phase 7 — 6.1 → 7.0 · Reach

It has to work in the places people actually write. Coverage is unglamorous and
it decides whether anyone keeps the app.

| # | Step | Test |
|---|---|---|
| 6.1 | Application coverage matrix, measured not assumed | Extend `bench/selection.js` into a scored matrix: Word, Outlook, VS Code, Notepad, Obsidian, Slack, Discord, Chrome, Edge, Zen, Teams, Notion. |
| 6.2 | Fix or explicitly refuse every red cell | An app that cannot be revised safely must refuse loudly, not silently do the wrong thing. |
| 6.3 | Elevated applications | Either a native hook that survives integrity boundaries, or an honest message. Silence is not an option. |
| 6.4 | Display scaling: 100%, 125%, 150%, 175% | Overlay is correctly sized and positioned at each. Screenshot each. |
| 6.5 | Multi-monitor, mixed DPI | Overlay appears on the display with the focused window. Test with monitors at different scale factors. |
| 6.6 | Right Alt and other unreachable keys | Native keyboard hook. `hotkeys.js` already exposes the contract for the swap. |
| 6.7 | Hotkey conflict detection at launch | Detect a taken binding and say which application has it, rather than failing silently. |
| 6.8 | Cold-start and warm-start timings | Measure both. First dictation after launch must not pay the 3.9s model load. |
| 6.9 | Behaviour on sleep, resume, mic change, audio device switch | Nothing hangs. The mic is re-acquired without a restart. |
| 7.0 | **Milestone: no app-specific excuses** | A week of use with no "it doesn't work in X" moment. |

---

# Phase 8 — 7.1 → 8.0 · Speed

Latency is not the product, but it is the difference between a tool you reach
for and one you think about reaching for.

| # | Step | Test |
|---|---|---|
| 7.1 | Instrument the whole pipeline honestly | Per-stage timings on every real session, not just on the bench. Find where the seconds actually go. |
| 7.2 | Optimistic paste: raw transcript at ~350ms, cleaned version swapped in | Measure felt latency separately from actual. If the swap flickers, it fails — this is a high-risk, high-reward step. |
| 7.3 | Keep the last utterance's audio in memory | "Try again" re-runs the same audio with a different mode or hint, with no re-speaking. Structurally impossible for streaming-first competitors. |
| 7.4 | Cut the revision cold-start | The bench measured a 21s first call against 0.5–8s warm. Find and remove it. |
| 7.5 | Edit-operation output format for large spans | Emit a targeted replacement, not the whole document. Measure token count and wall time against full rewrite. |
| 7.6 | Streaming reveal tuned to real token arrival | The overlay's reveal should match the stream, not a canned animation. |
| 7.7 | Re-evaluate the model choice against the bench | `bench/revise.js` scores restraint; that is the axis that matters, not tok/s. Diffusion models are worth re-testing when reliability improves. |
| 7.8 | Idle cost | Measure CPU, RAM and battery while sitting in the tray all day. A background utility that costs battery gets uninstalled. |
| 7.9 | Session-mode continuous listening cost | VAD-gated so ASR only runs on speech. Measure against always-transcribing. |
| 8.0 | **Milestone: it feels instant** | Blind A/B against the phase-1 build. Testers pick the faster one without being told which is which. |

---

# Phase 9 — 8.1 → 9.0 · Ship it

| # | Step | Test |
|---|---|---|
| 8.1 | Signed installer | Installs on a clean Windows machine with no SmartScreen warning. |
| 8.2 | Auto-update that never interrupts a session | Test by updating while a session is open. |
| 8.3 | Licence chosen, third-party notices carried | OpenWhispr's MIT notice ships with the native helpers derived from it. |
| 8.4 | Onboarding that is not a tour | The first successful dictation must happen within 60 seconds of install, with no reading. Measure with five people. |
| 8.5 | Crash and error telemetry the privacy claim survives | If it cannot be done without sending user content, it does not ship. Law 1. |
| 8.6 | Pricing decided | Local inference means near-zero marginal cost. Incumbents charge ~$15/mo because they cannot follow you down. Use that deliberately. |
| 8.7 | A landing page that shows the loop | The revision loop is the pitch and it must be shown, not described. One video, no feature grid. |
| 8.8 | Support surface | One channel, answered. Not a help centre nobody reads. |
| 8.9 | Uninstall is clean and complete | Everything learned goes with it, on request. |
| 9.0 | **Milestone: strangers use it** | Fifty people who are not you. Watch five of them for an hour. |

---

# Phase 10 — 9.1 → 10.0 · The moat

Everything above is copyable within a year. This phase is what is not.

| # | Step | Test |
|---|---|---|
| 9.1 | The personal model is a real artifact, not scattered state | Vocabulary, phrasing, register, correction history — one coherent thing. |
| 9.2 | It measurably improves month over month | Publish your own WER curve over six months. If the line is flat, law 4 is being violated somewhere. |
| 9.3 | Switching cost is real and honest | A user who has used Typd for six months should feel a fresh install of anything else as a downgrade. Test by having someone go back. |
| 9.4 | The model is portable and exportable | Law 3. Users own what they taught it. This also makes the claim credible rather than a lock-in threat. |
| 9.5 | Revision quality improves from your accepted and rejected edits | The instructions you keep and the ones you undo are both signal. |
| 9.6 | Style: it learns how you write, not just what words you use | Bench: blind test whether readers can distinguish Typd-revised text from your own writing. |
| 9.7 | Second user on the same machine stays separate | Profiles do not bleed. |
| 9.8 | The compounding story is legible to a new user on day one | They must understand that it gets better, or they will not stay long enough for it to. |
| 9.9 | Re-run the full bench suite against the phase-1 baseline | Every number better, and every regression explained. |
| 10.0 | **Milestone: uncopyable** | A competitor could clone every feature in a quarter and still not have this. |

---

## What this road refuses

Written down so it stays refused:

- **No dashboard and no hub.** Law 2. Configuration is learned where it can be.
  The few choices that cannot be learned (microphone, sounds, start at login,
  recordings, hotkey) live in one capped Settings window that never opens on its own.
- **No cloud recognition.** Law 1. Not as an option, not as a "faster mode".
- **No agent, no tool-calling, no "ask anything".** It is in `parked/` and it
  works, and it is still the wrong product. Typd is a text tool.
- **No feature that works identically on day 1 and day 200.** Law 4.
- **No chat interface.** The target application is the interface.
- **No mobile.** The whole product is a desktop overlay pasting into desktop
  applications.
- **No second hotkey without a fight.** Law 8. If a feature seems to need one,
  the first question is what on screen could have told us instead.
