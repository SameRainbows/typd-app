#!/bin/bash
# The macOS CI check "Close the Typd window, stay running" (mac.yml), one pass.
#
#   scripts/mac-close-check.sh exec|open <Typd.app> [label]
#
# exec  starts Typd's binary from this shell: it runs with the runner's privacy rights, so its
#       event tap works and synthetic keys reach it.
# open  starts it the way Finder does, through LaunchServices: Typd is its own app to macOS --
#       its own privacy switches, App Nap -- as on a tester's Mac.
#
# TYPD_TEST_CLOSE_HOME (src/main/index.js, testCloseHome) makes Typd open its window 5 s after
# launch, close it 3 s after it shows through win.close() -- the close button's path -- and,
# from 10 s after the close, write a marker every second: pid, "alive", the key layer's state,
# how many keys it heard before the window opened, while it was open and since it closed, and
# how late its timer runs. Synthetic F19 presses (scripts/mac-post-keys.jxa) run meanwhile;
# then two taps of Right ⌘ start and finish a dictation (the tester's next step); then a
# minute alone, and the same again. Typd must still run with its key layer alive -- hearing
# keys whenever it heard them before its window opened -- and quit cleanly at the end.

set -u
HOW="${1:?exec or open}"
APP="${2:?the Typd.app to test}"
MODE="${3:-$HOW}"   # the label in the log
BIN="$APP/Contents/MacOS/Typd"
MARK="$RUNNER_TEMP/typd-close-home-$MODE.txt"
LOG="$PWD/close-home-$MODE.log"
KEYS="$PWD/close-home-$MODE.keys.log"
STARTED="$RUNNER_TEMP/close-home-$MODE.start"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0
pid=0

bad() { echo "::error::[$MODE] $1"; fail=1; }
alive() { [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; }
field() { sed -n "$1" "$MARK" 2>/dev/null || true; }
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
f19() { osascript -l JavaScript "$HERE/mac-post-keys.jxa" f19 "$1" "$2" >> "$KEYS" 2>&1 || true; }
tap() { echo "Right ⌘ tap posted at $(now)" >> "$KEYS"; osascript -l JavaScript "$HERE/mac-post-keys.jxa" rightcmd >> "$KEYS" 2>&1 || true; }
show() { echo "--- [$MODE] $1"; cat "$MARK" 2>/dev/null || echo "(no marker)"; }
threads() { echo "--- [$MODE] threads (PRI 4 = the background band App Nap throttles to)"; ps -M -p "$pid" 2>/dev/null | head -12 || true; }

# Another Typd running would make this one a second copy, which quits at once.
pkill -f "$BIN" || true
for i in $(seq 1 20); do pgrep -f "$BIN" >/dev/null || break; sleep 0.5; done
rm -f "$MARK" "$LOG" "$LOG.err" "$KEYS"
touch "$STARTED"

if [ "$HOW" = open ]; then
  if ! open "$APP" --env TYPD_DEBUG=1 --env "TYPD_TEST_CLOSE_HOME=$MARK" --stdout "$LOG" --stderr "$LOG.err"; then
    echo "open --env failed; passing the variables through launchd instead"
    launchctl setenv TYPD_DEBUG 1
    launchctl setenv TYPD_TEST_CLOSE_HOME "$MARK"
    open "$APP"
    sleep 3
    launchctl unsetenv TYPD_DEBUG
    launchctl unsetenv TYPD_TEST_CLOSE_HOME
  fi
  for i in $(seq 1 40); do pid=$(pgrep -nf "$BIN" || echo 0); [ "$pid" -gt 0 ] && break; sleep 0.5; done
else
  TYPD_DEBUG=1 TYPD_TEST_CLOSE_HOME="$MARK" "$BIN" > "$LOG" 2> "$LOG.err" &
  pid=$!
fi
echo "[$MODE] Typd pid $pid"

osascript -l JavaScript "$HERE/mac-post-keys.jxa" f19 100 400 >> "$KEYS" 2>&1 &
poster=$!
for i in $(seq 1 60); do [ -s "$MARK" ] && break; alive || break; sleep 1; done
kill $poster 2>/dev/null || true
sleep 2
if [ ! -s "$MARK" ] && alive; then
  # Running but silent: where is it stuck? Every thread's stack, main thread first.
  echo "--- [$MODE] no marker yet Typd runs: its threads, sampled"
  sample "$pid" 3 -file "$RUNNER_TEMP/sample-$MODE.txt" > /dev/null 2>&1 || true
  # The main thread and any thread in uiohook (the key's event tap), whole.
  awk '/^    [0-9]+ Thread_/ { if (b ~ /main-thread|uiohook|hook_|CGEventTap|AXIsProcess/) printf "%s", b; b = "" }
       /^Total number in stack/ { if (b ~ /main-thread|uiohook|hook_|CGEventTap|AXIsProcess/) printf "%s", b; exit }
       f { b = b $0 "\n" } /^Call graph:/ { f = 1 }' "$RUNNER_TEMP/sample-$MODE.txt" 2>/dev/null | cut -c1-240 | head -400 || true
  grep -c 'Thread_' "$RUNNER_TEMP/sample-$MODE.txt" 2>/dev/null | sed 's/^/threads sampled: /' || true
  echo "--- [$MODE] the start of its log"; head -60 "$LOG" "$LOG.err" 2>/dev/null | cut -c1-220 || true
fi

show "marker, 12 s after the close"
[ -s "$MARK" ] || bad "no marker: Typd did not get 10 s past closing its window"
alive && echo "[$MODE] Typd (pid $pid) is running" || bad "Typd (pid $pid) is gone"
grep -qx "pid: $pid" "$MARK" && grep -qx alive "$MARK" || bad "the marker is not this Typd's"
hot=$(field 's/^hotkey: //p')
case "$hot" in *listening*|*'waiting for Accessibility'*) ;; *) bad "the key layer is not running: $hot" ;; esac
before=$(field 's/^keys heard: \([0-9]*\) before.*/\1/p')
since=$(field 's/^keys heard: .*, \([0-9]*\) since it closed$/\1/p')
if [ "${before:-0}" -gt 0 ]; then
  [ "${since:-0}" -gt 0 ] || bad "the key layer heard $before keys before the window opened and none after it closed"
else
  echo "::warning::[$MODE] no synthetic key reached Typd even before its window opened, so whether it still hears keys is untested in this pass ($hot)"
fi

# The tester's next step: dictate. Right ⌘ starts, Right ⌘ again finishes.
tap; sleep 4
alive || bad "Typd died when its key started a dictation after the window closed"
tap; sleep 6
alive || bad "Typd died when its key finished a dictation after the window closed"
show "marker, after two taps of Right ⌘"
threads

# Then left alone for a minute, as a person's Mac would leave it, and pressed again.
sleep 60
show "marker, after a minute alone"
threads
idle=$(field 's/^keys heard: .*, \([0-9]*\) since it closed$/\1/p')
f19 10 300
tap; sleep 4
alive || bad "Typd died when its key was pressed a minute after the window closed"
tap; sleep 3
again=$(field 's/^keys heard: .*, \([0-9]*\) since it closed$/\1/p')
show "marker, after pressing again"
if [ "${before:-0}" -gt 0 ]; then
  [ "${again:-0}" -gt "${idle:-0}" ] || bad "a minute after the window closed the key layer no longer hears keys ($idle, then $again)"
fi

# Quit the way ⌘Q does (a quit Apple event); SIGTERM if that cannot be sent within 10 s.
if alive; then
  osascript -e 'tell application id "ai.typd.app" to quit' > "$RUNNER_TEMP/quit-$MODE.log" 2>&1 &
  q=$!
  for i in $(seq 1 20); do alive || break; sleep 0.5; done
  kill $q 2>/dev/null || true
  if alive; then echo "[$MODE] the quit Apple event did not land ($(cat "$RUNNER_TEMP/quit-$MODE.log" 2>/dev/null)); SIGTERM"; kill -TERM "$pid" 2>/dev/null || true; fi
  for i in $(seq 1 30); do alive || break; sleep 0.5; done
  if alive; then bad "Typd did not quit"; kill -9 "$pid" 2>/dev/null || true; fi
  grep -q '\[typd:quit\] will-quit' "$LOG" || bad "Typd did not go through will-quit"
fi
pkill -f "$APP/Contents/Resources/llama/llama-server" || true

echo "--- [$MODE] synthetic keys"; cat "$KEYS" 2>/dev/null || true
echo "--- [$MODE] Typd's own lines"; { grep -hE '^\[typd' "$LOG" "$LOG.err" 2>/dev/null | grep -vE '^\[typd:local\] (server|llama)' | tail -100; } || true
# Crash reports written during this pass: Typd's own fails it; its helpers' are shown.
find ~/Library/Logs/DiagnosticReports -newer "$STARTED" -iname '*typd*' 2>/dev/null | while IFS= read -r f; do echo "--- $f"; head -150 "$f"; done
if find ~/Library/Logs/DiagnosticReports -newer "$STARTED" -name 'Typd-*' 2>/dev/null | grep -q .; then bad "Typd crashed (report above)"; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Close the Typd window, stay running ($MODE)"; echo '```'; cat "$MARK" 2>/dev/null || echo "(no marker)"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
exit $fail
