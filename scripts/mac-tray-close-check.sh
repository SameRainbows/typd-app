#!/bin/bash
# The macOS CI check "Open from the menu bar, close with the red X, stay running" (mac.yml), one pass.
#
#   scripts/mac-tray-close-check.sh <Typd.app> <label> tray|gui
#
# A tester's Mac (menu-bar mode, no Dock icon): menu-bar icon > "Open Typd" > the window's red X,
# and Typd was gone -- its menu-bar icon too. scripts/mac-close-check.sh opens the window from
# inside Typd and never saw that, so this pass takes the tester's own path. Typd is started the
# way Finder starts it (LaunchServices, `open`), and TYPD_TEST_LIFE (src/main/test-life.js) makes
# it write a marker every second from launch: where its menu-bar icon and window are, the key
# layer, keys heard before, during and after the window, the Dock icon, activations, timer lateness.
#
#   tray  Typd opens its window through the menu-bar menu's own "Open Typd" item and closes it with
#         win.close() (the red X's path).
#   gui   this script does what the tester did, with real clicks through the HID system
#         (scripts/mac-ui.swift, built into $RUNNER_TEMP/mac-ui): the menu-bar icon; "Open Typd"
#         (typed: o p e n, Return; System Events as a fallback); the window's title bar; its red X
#         (where Accessibility says it is, else 16 + 7 pt from the corner as trafficLightPosition puts it).
#
# Then IDLE seconds alone (default 150), watched every 10 s: is the process alive, does its
# menu-bar icon still exist, CPU, priority, App Nap (taskinfo), how late its timers run. Keys are
# pressed 15 s after the close and again at the end; they must be heard whenever keys were heard
# before the window opened. On a death: Typd's log, its life log (src/main/lifelog.js), crash
# reports and minidumps, and what macOS logged about it.

set -u
APP="${1:?the Typd.app to test}"
MODE="${2:?a label for the log}"
HOW="${3:-tray}"
IDLE="${IDLE:-150}"
BIN="$APP/Contents/MacOS/Typd"
MARK="$RUNNER_TEMP/typd-life-$MODE.txt"
LOG="$PWD/life-$MODE.log"
KEYS="$PWD/life-$MODE.keys.log"
STARTED="$RUNNER_TEMP/life-$MODE.start"
HERE="$(cd "$(dirname "$0")" && pwd)"
UI="${MAC_UI:-$RUNNER_TEMP/mac-ui}"
UD="$HOME/Library/Application Support/typd"
fail=0
pid=0
closed_at=0
died=""

bad() { echo "::error::[$MODE] $1"; fail=1; }
alive() { [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; }
field() { sed -n "s/^$1: //p" "$MARK" 2>/dev/null | head -n 1; }
now() { date +%s; }
f19() { osascript -l JavaScript "$HERE/mac-post-keys.jxa" f19 "$1" "$2" >> "$KEYS" 2>&1 || true; }
tap() { echo "Right ⌘ tap posted at $(date +%T)" >> "$KEYS"; osascript -l JavaScript "$HERE/mac-post-keys.jxa" rightcmd >> "$KEYS" 2>&1 || true; }
show() { echo "--- [$MODE] $1"; cat "$MARK" 2>/dev/null || echo "(no marker)"; }
before() { field 'keys heard' | sed -n 's/.*total, \([0-9-]*\) before the window opened.*/\1/p'; }
since() { field 'keys heard' | sed -n 's/.*, \([0-9-]*\) since it closed$/\1/p'; }
num() { case "${1:-}" in ''|*[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }
marker_fresh() { [ -s "$MARK" ] && [ $(( $(now) - $(stat -f %m "$MARK") )) -le 5 ]; }
in15() { perl -e 'alarm shift @ARGV; exec @ARGV' 15 "$@"; }   # macOS has no timeout(1); System Events can hang
ax() { in15 osascript -e "tell application \"System Events\" to tell (first application process whose unix id is $pid) to $1" 2>&1; }
placed() { case "$(field tray)" in [0-9-]*,[0-9-]*,[1-9]*,[1-9]*) return 0 ;; esac; return 1; }   # on screen, with a size
watch_line() {
  local p n
  p=$(ps -o %cpu=,pri=,nice=,stat= -p "$pid" 2>/dev/null | tr -s ' ')
  n=$(sudo -n taskinfo "$pid" 2>/dev/null | grep -iE 'nap|darwinbg|qos|role|suppress' | tr -s ' \t' ' ' | tr '\n' ';' | cut -c1-260)
  echo "[$MODE] +$(( $(now) - closed_at )) s after the close: $(alive && echo alive || echo GONE) | cpu,pri,nice,stat:${p:- -} | marker $(marker_fresh && echo fresh || echo STALE) | tray $(field tray) | $(field timer) | keys since close $(since) | ${n:-taskinfo: n/a}"
}
evidence() {
  echo "--- [$MODE] Typd's own lines"
  { grep -hE '^\[typd' "$LOG" "$LOG.err" 2>/dev/null | grep -vE '^\[typd:local\] (server|llama)' | tail -80; } || true
  echo "--- [$MODE] stderr (last 40 lines)"; tail -40 "$LOG.err" 2>/dev/null || true
  echo "--- [$MODE] life log"; tail -60 "$UD/logs/life.log" 2>/dev/null || echo "(none)"
  echo "--- [$MODE] minidumps"; find "$UD" "$HOME/Library/Application Support/Typd" -path '*Crashpad*' -type f -newer "$STARTED" 2>/dev/null | head -20 | while IFS= read -r f; do ls -la "$f"; done
  echo "--- [$MODE] crash reports"
  find ~/Library/Logs/DiagnosticReports /Library/Logs/DiagnosticReports -newer "$STARTED" -iname '*typd*' 2>/dev/null | while IFS= read -r f; do echo "== $f"; head -120 "$f"; done
  echo "--- [$MODE] what macOS logged about Typd (termination, activation, assertions)"
  sudo -n log show --start "$(date -r "$(stat -f %m "$STARTED")" '+%Y-%m-%d %H:%M:%S')" --style compact \
    --predicate 'process == "Typd" OR eventMessage CONTAINS[c] "ai.typd.app" OR eventMessage CONTAINS "Typd"' 2>/dev/null \
    | grep -iE 'terminat|quit|exit|crash|kill|jetsam|suspend|nap|assertion|transform|activation|policy|uielement|signal|abort|fault|exception|runningboard' \
    | grep -viE 'Typd Helper \(Renderer\).*(gpu|font)' | tail -100 || true
}

# Another Typd running would make this one a second copy, which quits at once.
pkill -f "$BIN" || true
for i in $(seq 1 20); do pgrep -f "$BIN" >/dev/null || break; sleep 0.5; done
pkill -f "$APP/Contents/Resources/llama/llama-server" || true
rm -f "$MARK" "$LOG" "$LOG.err" "$KEYS"
touch "$STARTED"
sleep 1

# TYPD_NO_MODEL_UPDATE / TYPD_NO_APP_UPDATE: nothing from production during the check, and no count
# in the version stats. TYPD_NO_SHARE: nothing shared. TYPD_NO_WALKTHROUGH: no first-run window.
# TYPD_MODEL_DIR, when the workflow sets it: a model-less build loads the model the workflow fetched.
open "$APP" --env TYPD_DEBUG=1 --env "TYPD_TEST_LIFE=$MARK" --env "TYPD_TEST_LIFE_HOW=$HOW" \
  --env TYPD_NO_MODEL_UPDATE=1 --env TYPD_NO_APP_UPDATE=1 --env TYPD_NO_SHARE=1 --env TYPD_NO_WALKTHROUGH=1 \
  ${TYPD_MODEL_DIR:+--env "TYPD_MODEL_DIR=$TYPD_MODEL_DIR"} --stdout "$LOG" --stderr "$LOG.err" || bad "open could not start Typd"
for i in $(seq 1 40); do pid=$(pgrep -nf "$BIN" || echo 0); [ "$pid" -gt 0 ] && break; sleep 0.5; done
echo "[$MODE] Typd pid $pid, $HOW"

# Up, with its menu-bar icon placed on screen (its first bounds can have no height yet).
for i in $(seq 1 60); do placed && break; alive || break; sleep 1; done
show "marker at start"
placed || bad "no menu-bar icon on screen after a minute ($(field tray))"
grep -qx "pid: $pid" "$MARK" 2>/dev/null || bad "the marker is not this Typd's (pid $pid)"

# Keys before the window (tray: Typd opens it 12 s after launch): are synthetic keys heard here?
f19 12 250
sleep 1

if [ "$HOW" = gui ]; then
  IFS=, read -r tx ty tw th <<< "$(field tray)"
  if [ -n "${tw:-}" ]; then
    "$UI" click $(( tx + tw / 2 )) $(( ty + th / 2 )) >> "$KEYS" 2>&1 || bad "mac-ui could not click"
    sleep 1.5
    "$UI" keys 31 35 14 45 >> "$KEYS" 2>&1; sleep 0.4; "$UI" keys 36 >> "$KEYS" 2>&1
  fi
  for i in $(seq 1 20); do case "$(field window)" in open*) break ;; esac; sleep 0.5; done
  if [ "$(field window | cut -c1-4)" != open ]; then
    echo "[$MODE] typing in the menu did not open the window; System Events instead"
    "$UI" keys 53 >> "$KEYS" 2>&1; sleep 0.5
    ax 'ignoring application responses
  click menu bar item 1 of menu bar 2
end ignoring' || true
    sleep 1.5
    ax 'click menu item "Open Typd" of menu 1 of menu bar item 1 of menu bar 2' || true
    for i in $(seq 1 20); do case "$(field window)" in open*) break ;; esac; sleep 0.5; done
  fi
  case "$(field window)" in open*) echo "[$MODE] the window is open: $(field window)" ;; *) bad "could not open the Typd window from the menu bar ($(field window))" ;; esac
  sleep 2
  IFS=' ' read -r _ wbox _ <<< "$(field window)"
  IFS=, read -r wx wy ww wh <<< "${wbox:-}"
  if [ -n "${ww:-}" ]; then
    "$UI" click $(( wx + ww / 2 )) $(( wy + 12 )) >> "$KEYS" 2>&1   # the title bar: the window comes forward, nothing else
    sleep 1
    f19 6 250
    sleep 1
    # The red X: where Accessibility says it is, else where trafficLightPosition {16, 16} puts it.
    xy=$(ax 'get {position, size} of (first button of window 1 whose subrole is "AXCloseButton")' | tr -d ' ')
    case "$xy" in
      [0-9]*,[0-9]*,[0-9]*,[0-9]*) IFS=, read -r bx by bw bh <<< "$xy"; cx=$(( bx + bw / 2 )); cy=$(( by + bh / 2 )); echo "[$MODE] red X from Accessibility: $xy" ;;
      *) cx=$(( wx + 23 )); cy=$(( wy + 24 )); echo "[$MODE] red X by position (Accessibility said: $xy)" ;;
    esac
    "$UI" click "$cx" "$cy" >> "$KEYS" 2>&1
    for i in $(seq 1 10); do case "$(field window)" in closed*) break ;; esac; sleep 0.5; done
    if [ "$(field window | cut -c1-6)" != closed ]; then
      echo "[$MODE] the click at $cx,$cy did not close it; pressing the close button through Accessibility"
      ax 'click (first button of window 1 whose subrole is "AXCloseButton")' || true
      for i in $(seq 1 10); do case "$(field window)" in closed*) break ;; esac; sleep 0.5; done
    fi
  fi
else
  for i in $(seq 1 40); do case "$(field window)" in open*) break ;; esac; alive || break; sleep 0.5; done
  f19 6 250
  for i in $(seq 1 30); do case "$(field window)" in closed*) break ;; esac; alive || break; sleep 0.5; done
fi
closed_at=$(now)
case "$(field window)" in closed*) echo "[$MODE] the window closed ($(field 'opened by'))" ;; *) bad "the window never closed ($(field window))" ;; esac

# Alone for IDLE seconds, watched; keys 15 s after the close and at the end.
pressed15=0
while [ $(( $(now) - closed_at )) -lt "$IDLE" ]; do
  if ! alive; then died="$(( $(now) - closed_at ))"; break; fi
  watch_line
  if [ $pressed15 = 0 ] && [ $(( $(now) - closed_at )) -ge 15 ]; then
    pressed15=1
    f19 10 200; tap; sleep 4; tap; sleep 2
    show "marker, 15 s after the close and two taps of Right ⌘"
    [ "$(num "$(before)")" -gt 0 ] && [ "$(num "$(since)")" -eq 0 ] && bad "the key layer heard keys before the window opened and none after it closed"
  fi
  sleep 10
done
if [ -z "$died" ] && alive; then
  at_end=$(num "$(since)")
  f19 10 200; tap; sleep 4; tap; sleep 3
  alive || died="$(( $(now) - closed_at ))"
fi
show "marker, at the end"

if [ -n "$died" ] || ! alive; then
  bad "Typd is GONE ${died:+$died s }after its window closed (its menu-bar icon with it)"
else
  echo "[$MODE] Typd (pid $pid) is running $(( $(now) - closed_at )) s after its window closed"
  marker_fresh || bad "Typd runs but its marker stopped (main thread stuck?)"
  placed || bad "the menu-bar icon is gone: $(field tray)"
  ax 'count menu bar items of menu bar 2' | sed "s/^/[$MODE] menu-bar items Accessibility sees: /" || true
  if [ "$(num "$(before)")" -gt 0 ]; then
    [ "$(num "$(since)")" -gt "${at_end:-0}" ] || bad "$IDLE s after the close the key layer no longer hears keys ($(since) since the close)"
  else
    echo "::warning::[$MODE] no synthetic key reached Typd before its window opened; the key layer is untested in this pass ($(field hotkey))"
  fi
fi
evidence

# Quit the way ⌘Q does; SIGTERM if that does not land.
if alive; then
  osascript -e 'tell application id "ai.typd.app" to quit' > "$RUNNER_TEMP/quit-$MODE.log" 2>&1 &
  q=$!
  for i in $(seq 1 20); do alive || break; sleep 0.5; done
  kill $q 2>/dev/null || true
  alive && kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 30); do alive || break; sleep 0.5; done
  if alive; then bad "Typd did not quit"; kill -9 "$pid" 2>/dev/null || true; fi
fi
pkill -f "$APP/Contents/Resources/llama/llama-server" || true
echo "--- [$MODE] synthetic input"; cat "$KEYS" 2>/dev/null || true
if find ~/Library/Logs/DiagnosticReports -newer "$STARTED" -name 'Typd-*' 2>/dev/null | grep -q .; then bad "Typd crashed (report above)"; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Open from the menu bar, close with the red X ($MODE, $HOW, $(sw_vers -productVersion))"; echo '```'; cat "$MARK" 2>/dev/null || echo "(no marker)"; [ -n "$died" ] && echo "GONE $died s after the close"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
exit $fail
