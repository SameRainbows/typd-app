#!/bin/bash
# Typd started again and again the way Finder starts it, already trusted for Accessibility
# (mac.yml, after the privacy grant). Each launch must come up -- the key's event tap
# listening and the model ready, both of which need a main thread that answers -- and quit
# on a quit Apple event.
#
#   scripts/mac-launch-loop.sh <Typd.app> [launches]
#
# uiohook-napi's start could hang the main thread for good at launch, intermittently (2 of
# 3 CI runs; scripts/build-uiohook-mac.js has the story), so one good launch proves little.

set -u
APP="${1:?the Typd.app to test}"
N="${2:-8}"
BIN="$APP/Contents/MacOS/Typd"
fail=0

for n in $(seq 1 "$N"); do
  pkill -f "$BIN" || true
  pkill -f "$APP/Contents/Resources/llama/llama-server" || true
  for i in $(seq 1 20); do pgrep -f "$BIN" >/dev/null || break; sleep 0.5; done
  LOG="$RUNNER_TEMP/launch-$n.log"
  rm -f "$LOG" "$LOG.err"
  t0=$(date +%s)
  open "$APP" --env TYPD_DEBUG=1 --env TYPD_NO_MODEL_UPDATE=1 --stdout "$LOG" --stderr "$LOG.err"   # no model download from production
  pid=0
  for i in $(seq 1 40); do pid=$(pgrep -nf "$BIN" || echo 0); [ "$pid" -gt 0 ] && break; sleep 0.5; done

  up=0
  for i in $(seq 1 60); do
    if grep -q '\[typd:hotkey\] .* is listening' "$LOG" 2>/dev/null && grep -qE '\[typd:local\] (model .* ready|reusing server)' "$LOG" 2>/dev/null; then up=1; break; fi
    sleep 1
  done
  if [ $up = 1 ]; then
    osascript -e 'tell application id "ai.typd.app" to quit' >/dev/null 2>&1 &
    q=$!
    for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill $q 2>/dev/null || true
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "::error::launch $n: Typd (pid $pid) $([ $up = 1 ] && echo 'did not quit' || echo 'did not come up')"
    fail=1
    sample "$pid" 3 -file "$RUNNER_TEMP/sample-launch-$n.txt" >/dev/null 2>&1 || true
    awk '/^    [0-9]+ Thread_/ { if (b ~ /main-thread|uiohook|hook_/) printf "%s", b; b = "" }
         /^Total number in stack/ { if (b ~ /main-thread|uiohook|hook_/) printf "%s", b; exit }
         f { b = b $0 "\n" } /^Call graph:/ { f = 1 }' "$RUNNER_TEMP/sample-launch-$n.txt" 2>/dev/null | cut -c1-240 | head -200 || true
    kill -9 "$pid" 2>/dev/null || true
  else
    echo "launch $n: up and quit in $(( $(date +%s) - t0 )) s"
  fi
  grep -hE '^\[typd:(hotkey|quit)\]' "$LOG" "$LOG.err" 2>/dev/null | sed "s/^/  /" || true
done
pkill -f "$APP/Contents/Resources/llama/llama-server" || true
exit $fail
