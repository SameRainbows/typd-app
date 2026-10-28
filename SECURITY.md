# Security

## Reporting a problem

Please report security problems privately, not in a public issue:

- **GitHub:** use **Report a vulnerability** on this repository's Security tab (private
  vulnerability reporting), or
- **E-mail:** contact@mehmetdedeler.com, with "Typd security" in the subject.

Say what you found, which version of Typd (Settings shows it) and OS, and how to reproduce it.
You should get a reply within a few days. Please give a reasonable time for a fix before you
publish details.

## What matters most

- Anything that lets audio, text or screen content leave the computer beyond what sharing is
  documented to send, before the user chose **Share**, or after they turned sharing off
  (`src/main/sharing.js`, `src/main/collect.js`, `src/main/settings.js`; asked since 0.2.7, and
  since 0.2.12 on only where the user chose it).
- The app updater: a way to make Typd install something not signed with the update key
  (`src/main/appUpdate.js`, `src/main/app-update/`), or to downgrade it.
- The model updater: a way to make Typd load files that do not match the published manifest
  (`src/main/modelUpdate.js`).
- Text on screen being treated as an instruction (prompt injection through the screen context or
  a selection).
- Keys or personal data in this repository. None should be here; if you find one, report it as
  above.

## Supported versions

Only the latest release gets fixes. Packaged builds update themselves.
