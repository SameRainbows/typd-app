# Tester kit

Typd gets better from real dictations by different people. Each new voice makes the model and the
release tests (several speakers, not just one) more trustworthy. This kit is for asking someone you
know to test.

## Before you ask anyone

- **Start with people you know:** family, friends, classmates, and people your parents know.
- **Have a parent look over the consent text and the setup with you.** Recordings of someone's
  voice are personal data (KVKK in Türkiye, GDPR in the EU). A parent should be part of
  collecting them, and a tester who is under 18 needs their own parent's OK too.
- **One tester, one key, one build.** Keys come from `node ../typd-collect/keys.mjs tester <name>`
  (see `../typd-collect/README.md`). Send the build privately, through a link from
  `dictation-research/scripts/publish_app.py` (expires in 7 days, 6 downloads), never in a public
  place.

## The ask (a message to send)

> Hey! I'm building Typd, a voice dictation app like Wispr Flow, except the AI runs entirely on
> your own computer, so it works offline and no AI company ever gets your voice. In blind tests
> it's already preferred over Wispr Flow on my own dictations. I need different voices to make it
> work for everyone. Would you use it instead of your keyboard (or Wispr) for a week? The tester
> version does send your dictations to my private server, only so I can improve and test the
> model. Details are below; you can stop any time.

## What's shared, in plain words (send this with the build)

> **What Typd shares with me while you test:** for each dictation, the audio and the text it
> typed, how long it took, and your OS and app version.
>
> **What it never shares:** what's on your screen, text you had selected, window titles, which
> app you were typing into, or anything when you're not dictating.
>
> **Update checks** send the app and model version with an anonymous install ID, so I can count
> versions in use.
>
> **What I do with it:** test new versions of the model and, if the quality is good, train it on
> them. Your recordings are stored privately, never published, and never sold or given to anyone.
> Only I (and my AI tools on my computer) work with them.
>
> **Stopping:** close or uninstall Typd any time, or turn sharing off in Settings. If you want your
> recordings deleted, tell me and I'll delete them from the server and my computer.
>
> **Avoid dictating** passwords, bank details or anything you wouldn't want stored.
>
> If that's OK, reply "I agree".

Keep their "I agree" message: it is the record of consent. Note the date in
your private consent record (name, date, what they agreed to).

## Install

- **Mac:** open the link, open the .dmg and drag Typd into Applications. The first time, right-click
  Typd and choose Open if macOS blocks it. Allow the microphone and accessibility permissions when
  asked.
- **Windows:** run the installer. If SmartScreen warns, choose More info, then Run anyway.
- **How to dictate:** hold the hotkey, speak and release. The text appears where the cursor is. New
  models download in the background and switch themselves on; there's nothing to reinstall.

## While they test

- Run `python dictation-research/scripts/pull_testers.py` to fetch their dictations. Each new
  tester's recordings become a held-out test set first, so
  every release is judged on more voices.
- Ask once, after a week, about anything that felt wrong (a bad word, a wrong format, slowness). One
  message, no nagging.

## Deleting a tester's data

1. Delete it from the server with `pull_testers.py --tester <name> --delete` after it's saved
   locally, or remove it there directly.
2. Delete `data/testers/<name>/`, plus any eval or training files built from it.
3. Remove their key from the server with `npx wrangler secret delete TESTER_<NAME>` in `../typd-collect` (see its README, "Remove a tester").
