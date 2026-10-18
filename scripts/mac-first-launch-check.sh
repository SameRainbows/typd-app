#!/bin/bash
# The macOS CI check "An update opens no window" (mac.yml): the first-run walkthrough is for
# fresh installs only (the user's rule, 0.2.4).
#
#   scripts/mac-first-launch-check.sh <Typd.app>
#
# 1. An existing install: Typd's user-data folder as 0.2.3 left it on a Mac where the walkthrough
#    never showed (settings.json with walkthrough '', history), then this build started the way
#    Finder starts it. For 25 s no Typd window may open (TYPD_TEST_LIFE_HOW=watch: Typd only
#    reports; src/main/test-life.js), and settings.json must say walkthrough "done".
# 2. The control, a fresh install (no user-data folder): the walkthrough's window must open, or
#    the first check proves nothing.
# Nothing is downloaded, shared or counted (TYPD_NO_MODEL_UPDATE, TYPD_NO_SHARE, TYPD_NO_APP_UPDATE).

set -u
APP="${1:?the Typd.app to test}"
BIN="$APP/Contents/MacOS/Typd"
UD="$HOME/Library/Application Support/typd"
fail=0

bad() { echo "::error::[first launch] $1"; fail=1; }
field() { sed -n "s/^$1: //p" "$MARK" 2>/dev/null | head -n 1; }

pass() {   # $1 label, then: watch for 25 s, then quit
  MARK="$RUNNER_TEMP/typd-first-$1.txt"
  LOG="$PWD/first-$1.log"
  rm -f "$MARK"
  open "$APP" --env TYPD_DEBUG=1 --env "TYPD_TEST_LIFE=$MARK" --env TYPD_TEST_LIFE_HOW=watch \
    --env TYPD_NO_MODEL_UPDATE=1 --env TYPD_NO_APP_UPDATE=1 --env TYPD_NO_SHARE=1 \
    ${TYPD_MODEL_DIR:+--env "TYPD_MODEL_DIR=$TYPD_MODEL_DIR"} --stdout "$LOG" --stderr "$LOG.err"
  opened=""
  for i in $(seq 1 25); do
    sleep 1
    case "$(field window)" in open*) opened="${opened:-$i s}" ;; esac
  done
  echo "--- [first launch, $1] marker after 25 s"; cat "$MARK" 2>/dev/null || echo "(no marker)"
  grep -hE '^\[typd:life\] (walkthrough|window)' "$LOG" 2>/dev/null || true
  osascript -e 'tell application id "ai.typd.app" to quit' >/dev/null 2>&1 &
  for i in $(seq 1 30); do pgrep -f "$BIN" >/dev/null || break; sleep 0.5; done
  pkill -9 -f "$BIN" 2>/dev/null || true
  pkill -f "$APP/Contents/Resources/llama/llama-server" || true
}

pkill -f "$BIN" || true
for i in $(seq 1 20); do pgrep -f "$BIN" >/dev/null || break; sleep 0.5; done

# 1. An existing install (0.2.3's settings, the walkthrough never shown).
rm -rf "$UD"
mkdir -p "$UD"
cat > "$UD/settings.json" <<'JSON'
{ "hotkey": "RightCommand", "sounds": true, "mic": "", "micLabel": "", "keepRecordings": true, "startAtLogin": false,
  "showInDock": false, "share": "on", "sharePaused": false, "flagHotkey": "", "modelVariant": "auto",
  "askBeforeModelDownload": false, "walkthrough": "" }
JSON
echo '{ "keep": "forever", "items": [] }' > "$UD/history.json"
pass existing
[ -z "$opened" ] || bad "an existing install's first start of this version opened the Typd window ($opened in): the walkthrough after an update"
[ -s "$MARK" ] || bad "no marker: Typd did not come up"
w=$(sed -n 's/.*"walkthrough": *"\([a-z]*\)".*/\1/p' "$UD/settings.json" | tr -d '\n')
[ "$w" = done ] || bad "settings.json says walkthrough \"$w\", not \"done\""
echo "existing install: window $( [ -z "$opened" ] && echo 'never opened' || echo "opened after $opened"), walkthrough $w"

# 2. The control: a fresh install.
rm -rf "$UD"
pass fresh
[ -n "$opened" ] && echo "fresh install: the walkthrough's window opened after $opened" || bad "a fresh install showed no walkthrough: the check above proves nothing"

rm -rf "$UD"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "- first launch: existing install opened no window ($( [ $fail = 0 ] && echo ok || echo FAILED)); fresh install showed the walkthrough" >> "$GITHUB_STEP_SUMMARY"
fi
exit $fail
