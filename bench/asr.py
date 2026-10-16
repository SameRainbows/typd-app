#!/usr/bin/env python3
"""
Measure ASR accuracy on *your* voice.

Published word error rates are computed on native-speaker corpora -- LibriSpeech
and friends -- read by American and British voices in quiet rooms. Parakeet's
documented weak spot is accented English. Neither of those facts tells you what
Parakeet does with a Turkish speaker dictating English into a laptop mic, and
that is the only number that decides whether local ASR is viable here.

Three stages:

    python bench/asr.py record              read prompts aloud, save wavs
    python bench/asr.py score --backend groq        cheapest first look
    python bench/asr.py score --backend parakeet    the real question

Start with groq. It needs no model download and takes about a minute, and it
tells you the ceiling: how well a strong cloud model handles your voice. If
cloud Whisper is at 4% and Parakeet is at 6%, local is fine. If cloud is at 12%,
the problem is the audio, not the model, and no amount of model shopping fixes
it -- go fix the microphone first.
"""

import argparse
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORDINGS = HERE / "recordings"
SAMPLE_RATE = 16000  # what every ASR model in this file expects

# Chosen to stress the things that actually break dictation: identifiers that
# are not words, proper nouns, numbers with units, and one long sentence with a
# subordinate clause where a model is tempted to drop the thread.
PROMPTS = [
    "Move the retry logic out of the transport layer and into the queue consumer.",
    "The websocket drops about once an hour, so we lose the whole batch.",
    "Add a dead letter queue for anything that fails more than three times.",
    "Set the timeout to two hundred and fifty milliseconds, not two point five seconds.",
    "Parakeet gets six point three two percent word error rate on the leaderboard.",
    "Refactor getUserById to take an options object instead of four positional arguments.",
    "The Poolside endpoint is inference dot poolside dot ai, and the model is Laguna XS.",
    "I pushed the branch to origin, but the pipeline is still failing on the lint step.",
    "Kubernetes keeps evicting the pod because the memory limit is too aggressive.",
    "Because the handshake happens before we know which region to route to, the first "
    "request always pays an extra round trip that the rest of the session avoids.",
    "Schedule it for Tuesday the seventeenth at half past nine in the morning.",
    "The file is at C colon backslash Users backslash Documents backslash Typd.",
]


# --------------------------------------------------------------------- scoring

_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
         "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}


def spell_numbers(words):
    """
    Collapse spelled-out numbers into digits: "six point three two" -> "6.32",
    "two hundred and fifty" -> "250".

    A model that writes 6.32% when you said "six point three two percent" got it
    right -- that is what you wanted typed. Scoring that as five word errors
    measures the harness, not the model. Deliberately conservative: it only
    folds runs it fully understands and leaves anything else alone.
    """
    out = []
    i = 0
    while i < len(words):
        total, seen = 0, False
        while i < len(words):
            w = words[i]
            if w in _UNITS:
                total += _UNITS[w]
            elif w in _TENS:
                total += _TENS[w]
            elif w == "hundred" and seen:
                total *= 100
            elif w == "thousand" and seen:
                total *= 1000
            elif w == "and" and seen and i + 1 < len(words) and (
                    words[i + 1] in _UNITS or words[i + 1] in _TENS):
                i += 1
                continue
            else:
                break
            seen = True
            i += 1

        if not seen:
            out.append(words[i])
            i += 1
            continue

        # "<n> point <digit> <digit> ..." is a decimal, not separate numbers.
        if i < len(words) and words[i] == "point":
            j = i + 1
            digits = ""
            while j < len(words) and words[j] in _UNITS and _UNITS[words[j]] < 10:
                digits += str(_UNITS[words[j]])
                j += 1
            if digits:
                out.append("%d.%s" % (total, digits))
                i = j
                continue

        out.append(str(total))
    return out


def merge_compounds(ref_words, hyp_words):
    """
    Re-join words the model split apart: "web socket" -> "websocket",
    "get user by id" -> "getuserbyid".

    Only merges when the joined form is a word the reference actually contains,
    so it cannot invent a match. Splitting a compound is a formatting choice the
    cleanup model fixes for free -- it is not a mishearing, and counting it as
    one buries the errors that matter.
    """
    refs = set(ref_words)
    out = []
    i = 0
    while i < len(hyp_words):
        joined = None
        for n in (4, 3, 2):
            if i + n <= len(hyp_words) and "".join(hyp_words[i:i + n]) in refs:
                joined = "".join(hyp_words[i:i + n])
                i += n
                break
        if joined:
            out.append(joined)
        else:
            out.append(hyp_words[i])
            i += 1
    return out


def normalise(text, fold=True):
    """Fold away everything a dictation user would not care about being wrong."""
    text = text.lower()
    text = text.replace("’", "'")
    text = text.replace("%", " percent ")
    # Keep the dot inside decimals; drop every other piece of punctuation, since
    # punctuation is the cleanup stage's job rather than the recogniser's.
    text = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", text)
    text = re.sub(r"[^\w\s'.]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    words = text.split()
    return " ".join(spell_numbers(words) if fold else words)


def align(ref_words, hyp_words):
    """
    Levenshtein over words, with a backtrace.

    Returns (substitutions, deletions, insertions, ops) where ops is a list of
    (kind, ref_word, hyp_word) -- the per-word detail is the point. An aggregate
    WER tells you whether local ASR is viable; the op list tells you *why*, and
    "every error is a proper noun" is a fixable problem while "it loses the verb
    in long sentences" is not.
    """
    n, m = len(ref_words), len(hyp_words)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref_words[i - 1] == hyp_words[j - 1]:
                d[i][j] = d[i - 1][j - 1]
            else:
                d[i][j] = 1 + min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1])

    ops = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and ref_words[i - 1] == hyp_words[j - 1] and d[i][j] == d[i - 1][j - 1]:
            ops.append(("ok", ref_words[i - 1], hyp_words[j - 1]))
            i, j = i - 1, j - 1
        elif i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + 1:
            ops.append(("sub", ref_words[i - 1], hyp_words[j - 1]))
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            ops.append(("del", ref_words[i - 1], ""))
            i -= 1
        else:
            ops.append(("ins", "", hyp_words[j - 1]))
            j -= 1

    ops.reverse()
    subs = sum(1 for o in ops if o[0] == "sub")
    dels = sum(1 for o in ops if o[0] == "del")
    ins = sum(1 for o in ops if o[0] == "ins")
    return subs, dels, ins, ops


def wer(reference, hypothesis, fold=True):
    """
    With fold=True (the default) this measures mishearing. With fold=False it
    also counts formatting differences -- digits versus words, split compounds --
    which is the stricter number but not the one that decides anything, because
    the cleanup model normalises all of it downstream.
    """
    ref = normalise(reference, fold).split()
    hyp = normalise(hypothesis, fold).split()
    if not ref:
        return 0.0, (0, 0, 0), []
    if fold:
        hyp = merge_compounds(ref, hyp)
    subs, dels, ins, ops = align(ref, hyp)
    return (subs + dels + ins) / len(ref), (subs, dels, ins), ops


# -------------------------------------------------------------------- backends
#
# Each backend takes a wav path and returns (text, seconds). Adding one is a
# dozen lines; the harness above is the part worth keeping.

def backend_groq(path):
    """Cloud reference: whisper-large-v3-turbo. Needs GROQ_API_KEY."""
    import urllib.request
    import uuid

    key = os.environ.get("GROQ_API_KEY")
    if not key:
        sys.exit("GROQ_API_KEY is not set.\n  PowerShell:  $env:GROQ_API_KEY = 'gsk_...'")

    boundary = "----typd" + uuid.uuid4().hex
    audio = Path(path).read_bytes()

    parts = []
    for field, value in (("model", "whisper-large-v3-turbo"),
                         ("response_format", "json"),
                         ("language", "en")):
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n{value}\r\n'
            .encode()
        )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
        f'Content-Type: audio/wav\r\n\r\n'.encode() + audio + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        data=body,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "multipart/form-data; boundary=" + boundary,
        },
        method="POST",
    )

    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read())
    return payload.get("text", ""), time.perf_counter() - started


def backend_parakeet(path):
    """
    Local Parakeet via sherpa-onnx.

    Expects the unpacked model directory in bench/models/parakeet, containing
    encoder / decoder / joiner onnx files and tokens.txt. sherpa-onnx publishes
    pre-converted Parakeet bundles on its GitHub releases; the exact filenames
    have moved between versions, so this globs rather than hardcoding them.
    """
    try:
        import sherpa_onnx
    except ImportError:
        sys.exit("sherpa-onnx is not installed.\n  pip install sherpa-onnx soundfile numpy")

    import numpy as np
    import soundfile as sf

    model_dir = HERE / "models" / "parakeet"
    if not model_dir.is_dir():
        sys.exit(
            f"No model at {model_dir}\n"
            "Download a Parakeet TDT bundle from the sherpa-onnx releases page and\n"
            "unpack it there: https://github.com/k2-fsa/sherpa-onnx/releases"
        )

    def one(pattern):
        hits = sorted(model_dir.glob(pattern))
        if not hits:
            sys.exit(f"{model_dir} has no file matching {pattern}")
        return str(hits[0])

    global _PARAKEET
    if "_PARAKEET" not in globals() or _PARAKEET is None:
        _PARAKEET = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=one("*encoder*.onnx"),
            decoder=one("*decoder*.onnx"),
            joiner=one("*joiner*.onnx"),
            tokens=one("tokens.txt"),
            num_threads=4,
            model_type="nemo_transducer",
        )

    samples, sr = sf.read(path, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)

    started = time.perf_counter()
    stream = _PARAKEET.create_stream()
    stream.accept_waveform(sr, samples)
    _PARAKEET.decode_stream(stream)
    return stream.result.text, time.perf_counter() - started


def backend_whisper(path):
    """Local Whisper via faster-whisper, for the accented-audio comparison."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper is not installed.\n  pip install faster-whisper")

    global _WHISPER
    if "_WHISPER" not in globals() or _WHISPER is None:
        # int8 on CPU keeps this runnable on any machine; switch to
        # device="cuda", compute_type="float16" to use the 3050 Ti.
        _WHISPER = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")

    started = time.perf_counter()
    segments, _ = _WHISPER.transcribe(path, language="en", beam_size=5)
    text = " ".join(s.text for s in segments)
    return text.strip(), time.perf_counter() - started


BACKENDS = {"groq": backend_groq, "parakeet": backend_parakeet, "whisper": backend_whisper}


# --------------------------------------------------------------------- record

def record():
    try:
        import sounddevice as sd
        import soundfile as sf
    except ImportError:
        sys.exit("Recording needs two packages.\n  pip install sounddevice soundfile numpy")

    RECORDINGS.mkdir(parents=True, exist_ok=True)

    print("Read each line aloud at your normal dictation pace and volume.")
    print("Do not perform it -- if you rush or over-enunciate, the number is worthless.")
    print("Enter to start, Enter again to stop. 's' to skip, 'q' to finish early.\n")

    refs = {}
    for i, prompt in enumerate(PROMPTS):
        print(f"[{i + 1}/{len(PROMPTS)}] {prompt}")
        choice = input("      > ").strip().lower()
        if choice == "q":
            break
        if choice == "s":
            print()
            continue

        frames = []
        stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                callback=lambda d, f, t, s: frames.append(d.copy()))
        with stream:
            input("      recording — Enter to stop ")

        if not frames:
            print("      nothing captured, skipping\n")
            continue

        import numpy as np
        audio = np.concatenate(frames, axis=0)
        path = RECORDINGS / f"{i:02d}.wav"
        sf.write(str(path), audio, SAMPLE_RATE)

        seconds = len(audio) / SAMPLE_RATE
        refs[path.name] = prompt
        print(f"      saved {path.name}  ({seconds:.1f}s)\n")

    if not refs:
        sys.exit("Nothing recorded.")

    # Merge rather than overwrite, so a partial second pass tops up the set.
    ref_file = RECORDINGS / "refs.json"
    if ref_file.exists():
        existing = json.loads(ref_file.read_text(encoding="utf-8"))
        existing.update(refs)
        refs = existing
    ref_file.write_text(json.dumps(refs, indent=2), encoding="utf-8")
    print(f"{len(refs)} clips in {RECORDINGS}")


# ---------------------------------------------------------------------- score

def duration(path):
    try:
        with wave.open(str(path)) as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return 0.0


def score(backend_name, verbose):
    ref_file = RECORDINGS / "refs.json"
    if not ref_file.exists():
        sys.exit(f"No recordings. Run:  python {Path(__file__).name} record")

    refs = json.loads(ref_file.read_text(encoding="utf-8"))
    transcribe = BACKENDS[backend_name]

    total_errors = 0
    total_words = 0
    total_audio = 0.0
    total_compute = 0.0
    rows = []
    all_ops = []

    for name in sorted(refs):
        path = RECORDINGS / name
        if not path.exists():
            continue

        reference = refs[name]
        hypothesis, seconds = transcribe(str(path))
        rate, (subs, dels, ins), ops = wer(reference, hypothesis)

        words = len(normalise(reference).split())
        total_errors += subs + dels + ins
        total_words += words
        total_audio += duration(path)
        total_compute += seconds
        all_ops.extend(o for o in ops if o[0] != "ok")

        rows.append((name, rate, subs, dels, ins, hypothesis, reference))

    if not total_words:
        sys.exit("No clips scored.")

    print(f"\nbackend: {backend_name}\n")
    header = "%-10s %7s %4s %4s %4s   %s" % ("clip", "wer", "sub", "del", "ins", "heard")
    print(header)
    print("-" * 96)
    for name, rate, subs, dels, ins, hyp, ref in rows:
        print("%-10s %6.1f%% %4d %4d %4d   %s" % (name, rate * 100, subs, dels, ins, hyp[:52]))
        if verbose:
            print("%-10s %s   %s" % ("", " " * 21, "want: " + ref[:52]))

    overall = total_errors / total_words
    rtf = (total_audio / total_compute) if total_compute else 0

    print("-" * 96)
    print("%-10s %6.1f%%  over %d words, %d clips" % ("OVERALL", overall * 100, total_words, len(rows)))
    print("%-10s %.1fs audio in %.1fs  (%.0fx realtime)" % ("SPEED", total_audio, total_compute, rtf))

    # Repeated substitutions are the actionable finding: a word the model gets
    # wrong every time belongs in a custom dictionary, not in a WER complaint.
    misses = {}
    for kind, ref_w, hyp_w in all_ops:
        if kind == "sub":
            misses[(ref_w, hyp_w)] = misses.get((ref_w, hyp_w), 0) + 1
    repeated = sorted(((c, r, h) for (r, h), c in misses.items() if c > 1), reverse=True)
    if repeated:
        print("\nrepeated substitutions — dictionary candidates:")
        for count, ref_w, hyp_w in repeated[:12]:
            print("  %-22s heard as  %-22s  x%d" % (ref_w, hyp_w, count))

    print("\nUnder 5%: local ASR is fine, ship it.")
    print("5-10%:    workable — the cleanup model repairs a lot of this.")
    print("Over 10%: check the cloud backend before blaming the model. If cloud is")
    print("          also bad, the microphone or the room is the problem.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("record", help="read the prompts aloud and save them")
    s = sub.add_parser("score", help="transcribe the recordings and report WER")
    s.add_argument("--backend", choices=sorted(BACKENDS), default="groq")
    s.add_argument("-v", "--verbose", action="store_true", help="show the reference alongside")
    args = ap.parse_args()

    if args.cmd == "record":
        record()
    else:
        score(args.backend, args.verbose)


if __name__ == "__main__":
    main()
