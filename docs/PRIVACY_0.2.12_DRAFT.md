# Privacy page, sharing section: draft for 0.2.12

Proposed text for the sharing section of the live page (`typd-site/public/privacy/index.html`,
lines 66-85 today: from `<h2>Sharing: Typd asks on first launch</h2>` to the "One dictation only"
paragraph). Not published: it goes live with 0.2.12's release, not before.

What changes:

- names Typd 0.2.4, 0.2.5 and 0.2.6 as the versions that shared by default;
- says every install that never chose is asked once (no exemption for installs first started
  before 18 October 2026, 15:00 UTC);
- drops "which app you were typing into, by its program name (for example "Discord")" from what is
  sent, and lists it under what Typd never shares.

Check before publishing: the Mac-only 0.2.7 hotfix (branch `mac-mic-0.2.7`, d5d38a9 / 0d47890)
does not contain the asked-sharing commit (8766bf4) and still has 0.2.6's default-on `shareFrom`;
docs/PUBLIC_BETA.md also says "0.2.4-0.2.7 on by default". If that build reached people, the
sentence should read "Typd 0.2.4, 0.2.5 and 0.2.6, and 0.2.7 on a Mac, shared dictations by
default."

---

## Sharing: Typd asks first

Typd can share your dictations so its model can be tested and trained on real speech. Typd asks
first, "Help make Typd better?", with **Share** and **Don't share**; nothing is chosen for you,
and until you answer nothing is shared. A new install asks on first launch. **Share dictations** in
Settings changes your answer at any time.

Typd 0.2.4, 0.2.5 and 0.2.6 shared dictations by default. Since Typd 0.2.12, every install where
nobody chose **Share** or **Don't share** asks once, the next time Typd starts, and shares nothing
until you answer. That includes installs that later versions kept sharing without asking. If you
choose **Don't share** there, Typd also deletes what it had already shared. If you turned sharing
off, it stays off. Earlier versions did not record whether sharing was on because you chose it, so
if you had chosen **Share**, Typd may ask you once more.

A dictation is sent after its text has been typed (or copied, when Typd could not type it), in the
background, never while you are dictating it. Typd shares at most 50 dictations, or 20 MB of audio,
a day. While sharing is on, Typd sends **for each dictation**:

- the recording of what you said, and the text Typd typed (when you ask Typd to change selected
  text, only the recording of your instruction, not the text);
- whether it was a dictation or a change to selected text, and how many characters Typd typed;
- which model wrote it and its version, and whether Typd's add-on for changing text was used;
- when you dictated, how long the recording was, and how long Typd took to write it;
- your operating system, its version and your processor type, and the versions of Typd and of
  Electron, the framework it is built on;
- a note, if you mark a dictation with "That was wrong" (and, for one already sent, the versions
  Typd was running when you marked it).

It is sent with a random install ID that the server makes the first time Typd shares. It is not
linked to your name, your email or an account. To limit how many new installs one network can add
in a day, the server counts them under a scrambled form of the IP address, never the address
itself, and forgets that count after two days.

**Typd never shares:**

- what is on your screen, or the text around your cursor;
- text you had selected, or window titles;
- which app you were typing into (Typd 0.2.11 and earlier sent its program name, for example
  "Discord", with each shared dictation; "Delete what I've shared" deletes those too);
- anything when you are not dictating.

**One dictation only.** If sharing is off and you mark a dictation with "That was wrong", Typd asks
whether to send that one dictation so it can be fixed. Only a yes sends it.

---

## Two other lines on the page

- The opening paragraph (line 55): "To make Typd better, Typd asks on first launch whether to share
  your dictations to train its model." becomes "To make Typd better, Typd asks whether to share
  your dictations to train its model."
- The "In short" box (line 117): "Typd asks on first launch whether to share your dictations to
  train the model; nothing is shared unless you say yes." becomes "Typd asks whether to share your
  dictations to train the model; nothing is shared unless you say yes."

## The section as HTML (to replace lines 66-85)

```html
    <h2>Sharing: Typd asks first</h2>
    <p>Typd can share your dictations so its model can be tested and trained on real speech. Typd asks first, “Help make Typd better?”, with <strong>Share</strong> and <strong>Don’t share</strong>; nothing is chosen for you, and until you answer nothing is shared. A new install asks on first launch. <strong>Share dictations</strong> in Settings changes your answer at any time.</p>
    <p>Typd 0.2.4, 0.2.5 and 0.2.6 shared dictations by default. Since Typd 0.2.12, every install where nobody chose <strong>Share</strong> or <strong>Don’t share</strong> asks once, the next time Typd starts, and shares nothing until you answer. That includes installs that later versions kept sharing without asking. If you choose <strong>Don’t share</strong> there, Typd also deletes what it had already shared. If you turned sharing off, it stays off. Earlier versions did not record whether sharing was on because you chose it, so if you had chosen <strong>Share</strong>, Typd may ask you once more.</p>
    <p>A dictation is sent after its text has been typed (or copied, when Typd could not type it), in the background, never while you are dictating it. Typd shares at most 50 dictations, or 20 MB of audio, a day. While sharing is on, Typd sends <strong>for each dictation</strong>:</p>
    <ul>
      <li>the recording of what you said, and the text Typd typed (when you ask Typd to change selected text, only the recording of your instruction, not the text);</li>
      <li>whether it was a dictation or a change to selected text, and how many characters Typd typed;</li>
      <li>which model wrote it and its version, and whether Typd’s add-on for changing text was used;</li>
      <li>when you dictated, how long the recording was, and how long Typd took to write it;</li>
      <li>your operating system, its version and your processor type, and the versions of Typd and of Electron, the framework it is built on;</li>
      <li>a note, if you mark a dictation with “That was wrong” (and, for one already sent, the versions Typd was running when you marked it).</li>
    </ul>
    <p>It is sent with a random install ID that the server makes the first time Typd shares. It is not linked to your name, your email or an account. To limit how many new installs one network can add in a day, the server counts them under a scrambled form of the IP address, never the address itself, and forgets that count after two days.</p>
    <p><strong>Typd never shares:</strong></p>
    <ul>
      <li>what is on your screen, or the text around your cursor;</li>
      <li>text you had selected, or window titles;</li>
      <li>which app you were typing into (Typd 0.2.11 and earlier sent its program name, for example “Discord”, with each shared dictation; “Delete what I’ve shared” deletes those too);</li>
      <li>anything when you are not dictating.</li>
    </ul>
    <p><strong>One dictation only.</strong> If sharing is off and you mark a dictation with “That was wrong”, Typd asks whether to send that one dictation so it can be fixed. Only a yes sends it.</p>
```
