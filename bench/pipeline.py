#!/usr/bin/env python3
"""
End to end: microphone -> Parakeet -> Laguna -> text, scored against what you
actually said.

`asr.py` measures the recogniser alone, which is the wrong thing to optimise.
The user never sees the raw transcript -- they see what the cleanup model made
of it. An ASR error the LLM repairs costs nothing; one it entrenches costs
twice. This is the only number that describes the product.

    python bench/pipeline.py
    python bench/pipeline.py --context   # pass the app and a hint of vocabulary

Reuses the recordings made by `asr.py record`.
"""

import argparse
import importlib.util
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORDINGS = HERE / "recordings"
BASE_URL = "https://inference.poolside.ai/v1/chat/completions"
MODEL = "poolside/laguna-xs-2.1"

spec = importlib.util.spec_from_file_location("asr", str(HERE / "asr.py"))
asr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asr)

def load_prompts():
    """
    Read the prompts out of the shipping module rather than keeping a copy.

    A benchmark that scores its own copy of the prompt drifts away from the app
    within a week and then reports confidently on something nobody runs.
    """
    import subprocess
    out = subprocess.run(
        ["node", "-e",
         "process.stdout.write(JSON.stringify(require('./src/main/pipeline/prompts')))"],
        cwd=str(HERE.parent), capture_output=True, text=True, encoding="utf-8",
    )
    if out.returncode != 0:
        sys.exit("could not read src/main/pipeline/prompts.js:\n" + out.stderr[:400])
    return json.loads(out.stdout)


PROMPTS = load_prompts()

# What a real session would have on screen anyway: the app, and the vocabulary
# already visible in it. This is the cheap half of the context idea from
# RESULTS.md -- no screen scraping, just the words the user is surrounded by.
CONTEXT = (
    "<active_application>Visual Studio Code — transport.ts</active_application>\n"
    "<visible_text>\n"
    "import { DeadLetterQueue } from './dlq'\n"
    "// Poolside inference endpoint, model laguna-xs-2.1\n"
    "export async function getUserById(id: string) { ... }\n"
    "// kubectl get pods -n typd\n"
    "// paths under C:\\Users\\me\\Documents\\Typd\n"
    "</visible_text>\n\n"
)


def clean(transcript, api_key, with_context, timeout=60):
    user = (CONTEXT if with_context else "") + \
        "<raw_transcript>\n" + transcript + "\n</raw_transcript>"

    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": PROMPTS["dictate"]},
                     {"role": "user", "content": user}],
        # Correction has one right answer. Sampling only buys instability -- the
        # same clip scored 0% and 44% on consecutive runs at 0.2.
        "temperature": 0,
        "max_tokens": 512,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read())
    text = body["choices"][0]["message"]["content"].strip()
    return text, time.perf_counter() - started


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--context", action="store_true",
                    help="include app name and visible vocabulary in the prompt")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    api_key = os.environ.get("POOLSIDE_API_KEY")
    if not api_key:
        sys.exit("POOLSIDE_API_KEY is not set.")

    ref_file = RECORDINGS / "refs.json"
    if not ref_file.exists():
        sys.exit("No recordings. Run:  python bench/asr.py record")
    refs = json.loads(ref_file.read_text(encoding="utf-8"))

    raw_err = raw_words = 0
    out_err = out_words = 0
    rows = []
    llm_time = 0.0

    for name in sorted(refs):
        path = RECORDINGS / name
        if not path.exists():
            continue
        reference = refs[name]

        heard, _ = asr.backend_parakeet(str(path))
        cleaned, secs = clean(heard, api_key, args.context)
        llm_time += secs

        r_rate, _, _ = asr.wer(reference, heard)
        c_rate, _, _ = asr.wer(reference, cleaned)

        words = len(asr.normalise(reference).split())
        raw_err += r_rate * words
        raw_words += words
        out_err += c_rate * words
        out_words += words

        rows.append((name, r_rate, c_rate, cleaned, reference))

    if not raw_words:
        sys.exit("Nothing scored.")

    print("\ncontext: %s   model: %s\n" % ("on" if args.context else "off", MODEL))
    header = "%-10s %8s %8s   %s" % ("clip", "asr", "after", "result")
    print(header)
    print("-" * 100)
    for name, r, c, cleaned, reference in rows:
        arrow = "  " if abs(c - r) < 1e-9 else ("->" if c < r else "!!")
        print("%-10s %7.1f%% %7.1f%% %s %s" % (name, r * 100, c * 100, arrow, cleaned[:56]))
        if args.verbose:
            print("%-10s %17s    want: %s" % ("", "", reference[:56]))

    print("-" * 100)
    print("%-10s %7.1f%% %7.1f%%   over %d words" %
          ("OVERALL", raw_err / raw_words * 100, out_err / out_words * 100, raw_words))
    print("%-10s cleanup: %.2fs per utterance" % ("SPEED", llm_time / len(rows)))

    delta = (raw_err - out_err) / raw_words * 100
    if delta > 0.5:
        print("\nThe cleanup model removed %.1f points of error." % delta)
    elif delta < -0.5:
        print("\nThe cleanup model ADDED %.1f points of error." % -delta)
    else:
        print("\nThe cleanup model left the error rate unchanged.")


if __name__ == "__main__":
    main()
