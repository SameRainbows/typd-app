#!/usr/bin/env python3
"""
Measure Poolside Laguna latency for the transcript-cleanup path.

The question this answers: with thinking off, is XS 2.1 meaningfully faster than
S 2.1 -- and does either fit inside a dictation latency budget once you start
stuffing screen context into the prompt?

Reports time-to-first-token and total wall time. TTFT is what the user feels,
because the overlay can start revealing text the moment the first token lands.

  set POOLSIDE_API_KEY=...
  python bench/latency.py
  python bench/latency.py --runs 8 --thinking both
"""

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

BASE_URL = "https://inference.poolside.ai/v1/chat/completions"

MODELS = {
    "xs": "poolside/laguna-xs-2.1",
    "s": "poolside/laguna-s-2.1",
    "m": "poolside/laguna-m.1",
}

SYSTEM = (
    "You rewrite raw speech-to-text output into what the speaker meant to write. "
    "Remove filler words, false starts and repetitions. Fix grammar and punctuation. "
    "Preserve the speaker's voice, register and word choice. Match the formatting "
    "conventions of the surrounding application. Output only the corrected text, "
    "with no preamble, quotes or commentary."
)

# A genuinely messy utterance -- restarts, fillers, a self-correction, and a
# technical term ASR would plausibly mangle without context.
TRANSCRIPT = (
    "okay so um i think what we should do is uh we should probably move the "
    "the retry logic out of the uh out of the transport layer and put it in "
    "the i mean actually no put it in the queue consumer because right now if "
    "the socket drops we we lose the whole batch and thats that's just not "
    "acceptable so yeah lets do that and also we need to add a a dead letter "
    "thing for the ones that fail more than three times"
)

# Simulated screen context at increasing sizes. This is the lever that decides
# whether "just send it the whole screen" is actually affordable.
CODE_UNIT = """\
export class TransportLayer {
  private socket: WebSocket | null = null;
  private retryCount = 0;

  async send(batch: Envelope[]): Promise<void> {
    try {
      this.socket?.send(encode(batch));
    } catch (err) {
      if (this.retryCount++ < MAX_RETRIES) return this.send(batch);
      throw new TransportError('batch dropped', { cause: err });
    }
  }
}

export class QueueConsumer {
  constructor(private transport: TransportLayer, private dlq: DeadLetterQueue) {}

  async drain(): Promise<void> {
    for await (const envelope of this.stream()) {
      await this.transport.send([envelope]);
    }
  }
}
"""


def build_context(approx_tokens):
    """Repeat the code sample until it lands near the requested token budget."""
    if approx_tokens <= 0:
        return None
    # ~4 chars per token is close enough for a latency probe.
    target_chars = approx_tokens * 4
    reps = max(1, target_chars // len(CODE_UNIT))
    return (CODE_UNIT * reps)[:target_chars]


CONTEXT_SIZES = [
    ("none", 0),
    ("window", 800),      # the focused editor pane
    ("screen", 4000),     # everything visible, plus recent history
    ("greedy", 16000),    # "just send it all" -- does the 1M window pay off?
]


def build_messages(context):
    user = ""
    if context:
        user += (
            "<active_application>Visual Studio Code - transport.ts</active_application>\n"
            "<visible_text>\n" + context + "\n</visible_text>\n\n"
        )
    user += "<raw_transcript>\n" + TRANSCRIPT + "\n</raw_transcript>"
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": user},
    ]


def one_run(api_key, model_id, messages, thinking, timeout):
    """Fire one streaming request. Returns (ttft, ttfc, total, text, err)."""
    payload = {
        "model": model_id,
        "messages": messages,
        "stream": True,
        "temperature": 0.2,
        "max_tokens": 512,
        "chat_template_kwargs": {"enable_thinking": bool(thinking)},
    }
    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )

    started = time.perf_counter()
    ttft = None   # first delta of any kind, including reasoning
    ttfc = None   # first delta of user-visible content
    chunks = []

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                body = line[5:].strip()
                if body == "[DONE]":
                    break
                try:
                    event = json.loads(body)
                except json.JSONDecodeError:
                    continue
                choices = event.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                now = time.perf_counter()

                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                if reasoning and ttft is None:
                    ttft = now - started

                content = delta.get("content")
                if content:
                    if ttft is None:
                        ttft = now - started
                    if ttfc is None:
                        ttfc = now - started
                    chunks.append(content)
    except urllib.error.HTTPError as e:
        return None, None, None, "", "HTTP %s: %s" % (e.code, e.read()[:200].decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 - a probe should report, not crash
        return None, None, None, "", "%s: %s" % (type(e).__name__, e)

    total = time.perf_counter() - started
    return ttft, ttfc, total, "".join(chunks), None


def summarise(values):
    clean = [v for v in values if v is not None]
    if not clean:
        return None, None
    clean.sort()
    p50 = statistics.median(clean)
    p95 = clean[min(len(clean) - 1, int(len(clean) * 0.95))]
    return p50, p95


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", default="xs,s", help="comma list of xs,s,m (default xs,s)")
    ap.add_argument("--thinking", default="off", choices=["off", "on", "both"])
    ap.add_argument("--runs", type=int, default=5, help="runs per cell (default 5)")
    ap.add_argument("--warmup", type=int, default=1, help="discarded runs per cell (default 1)")
    ap.add_argument("--timeout", type=float, default=90.0)
    ap.add_argument("--budget", type=float, default=250.0, help="target TTFC in ms (default 250)")
    ap.add_argument("--show-output", action="store_true", help="print one cleaned sample per model")
    args = ap.parse_args()

    api_key = os.environ.get("POOLSIDE_API_KEY")
    if not api_key:
        sys.exit("POOLSIDE_API_KEY is not set.\n  PowerShell:  $env:POOLSIDE_API_KEY = 'psk_...'")

    picked = [m.strip() for m in args.models.split(",") if m.strip()]
    unknown = [m for m in picked if m not in MODELS]
    if unknown:
        sys.exit("unknown model key(s): %s (choose from %s)" % (", ".join(unknown), ", ".join(MODELS)))

    thinking_modes = {"off": [False], "on": [True], "both": [False, True]}[args.thinking]

    print("Poolside cleanup-path latency probe")
    print("  transcript: %d chars   runs/cell: %d (+%d warmup)   budget: %.0f ms\n"
          % (len(TRANSCRIPT), args.runs, args.warmup, args.budget))

    header = "%-6s %-6s %-8s %9s %9s %9s %9s" % (
        "model", "think", "context", "ttft p50", "ttfc p50", "ttfc p95", "total p50")
    print(header)
    print("-" * len(header))

    samples = {}
    failures = []

    for key in picked:
        model_id = MODELS[key]
        for thinking in thinking_modes:
            for label, size in CONTEXT_SIZES:
                messages = build_messages(build_context(size))

                for _ in range(args.warmup):
                    one_run(api_key, model_id, messages, thinking, args.timeout)

                ttfts, ttfcs, totals = [], [], []
                for _ in range(args.runs):
                    ttft, ttfc, total, text, err = one_run(
                        api_key, model_id, messages, thinking, args.timeout)
                    if err:
                        failures.append("%s/%s/%s: %s" % (key, "on" if thinking else "off", label, err))
                        continue
                    ttfts.append(ttft)
                    ttfcs.append(ttfc)
                    totals.append(total)
                    samples.setdefault((key, thinking), text)

                ttft_p50, _ = summarise(ttfts)
                ttfc_p50, ttfc_p95 = summarise(ttfcs)
                total_p50, _ = summarise(totals)

                def ms(v):
                    return "%.0f" % (v * 1000) if v is not None else "--"

                flag = ""
                if ttfc_p50 is not None:
                    flag = "  ok" if ttfc_p50 * 1000 <= args.budget else "  over"

                print("%-6s %-6s %-8s %9s %9s %9s %9s%s" % (
                    key, "on" if thinking else "off", label,
                    ms(ttft_p50), ms(ttfc_p50), ms(ttfc_p95), ms(total_p50), flag))

    if args.show_output:
        print("\n--- sample output ---")
        for (key, thinking), text in samples.items():
            print("\n[%s, thinking %s]\n%s" % (key, "on" if thinking else "off", text.strip()))

    if failures:
        print("\n--- failures (%d) ---" % len(failures))
        for f in failures[:12]:
            print("  " + f)

    print("\nttft = first token of any kind (reasoning included)")
    print("ttfc = first token of user-visible text -- this is what the overlay waits on")
    print("Network RTT is inside every number. Run this from where you actually dictate.")


if __name__ == "__main__":
    main()
