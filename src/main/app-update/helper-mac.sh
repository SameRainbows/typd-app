#!/bin/sh
# Typd app-update helper, macOS. src/main/appUpdate.js copies this file into
# <userData>/app-update/, writes helper.vars beside it (sh-quoted, so sourcing it runs nothing)
# and starts it detached just before Typd quits for an update:
#
#   /bin/sh helper.sh <dir>
#
# 1. Wait for Typd (OLD_PID) to exit, then for anything still running from inside the bundle
#    (llama-server): a server left on the port would be reused by the new version untested.
# 2. Move the staged Typd.app next to the installed one (NEWIN), carry over what the manifest names
#    (CARRY), clear quarantine, and if anything was carried sign it ad hoc again, so its seal covers
#    what is now inside. From 0.2.2 a macOS manifest carries NOTHING: the package's app is signed in
#    CI with Typd's own certificate and is installed exactly as signed (nothing carried, so it is
#    not signed again here and keeps its designated requirement, and with it the user's privacy
#    switches); the new version copies the model and tester.json out of OLD itself
#    (src/main/carried.js). 0.2.0 and 0.2.1 run this same script with that empty list.
# 3. Swap: the installed bundle becomes OLD and NEWIN takes its name. Start it with `open`, which
#    makes it its own app to macOS (permissions, the menu bar), passing on the TYPD_* variables.
# 4. Wait for its verdict.json: "started", then "ok" or "failed". On "ok" delete OLD. On "failed",
#    a crash or silence: stop it, put OLD back with what was carried, start it.
# result.json says what happened: ok | bad (the new version failed; not retried until the manifest
# changes) | aborted (nothing was changed; tried again later). Everything is logged to helper.log.

DIR=$1
[ -n "$DIR" ] && [ -f "$DIR/helper.vars" ] || exit 2
# shellcheck disable=SC1091
. "$DIR/helper.vars"
echo $$ > "$DIR/helper.started"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s helper: %s\n' "$(now)" "$*"; }
esc() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
rx() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

result() {
  printf '{"version":"%s","from":"%s","outcome":"%s","why":"%s","at":"%s"}\n' \
    "$VERSION" "$FROM" "$1" "$(esc "$2")" "$(now)" > "$DIR/result.json.tmp" && mv -f "$DIR/result.json.tmp" "$DIR/result.json"
  log "result: $1 ($2)"
}

# Is pid $1 gone within $2 seconds?
wait_gone() {
  n=0
  while kill -0 "$1" 2>/dev/null; do
    n=$((n + 1))
    [ "$n" -ge $(($2 * 10)) ] && return 1
    sleep 0.1
  done
  return 0
}

# Processes running from inside the bundle $1 (the app, its helpers, llama-server).
inside() { pgrep -f "^$(rx "$1")/" 2>/dev/null; }

stop_inside() {
  n=0
  while [ -n "$(inside "$1")" ]; do
    n=$((n + 1))
    if [ "$n" -eq 100 ]; then log "still running from $1: $(inside "$1" | tr '\n' ' ')- asking them to stop"; pkill -f "^$(rx "$1")/" 2>/dev/null; fi
    if [ "$n" -ge 200 ]; then log "stopping them"; pkill -9 -f "^$(rx "$1")/" 2>/dev/null; sleep 1; return; fi
    sleep 0.1
  done
}

launch() {
  a=$1
  set -- -g -a "$a"
  while IFS= read -r kv; do
    [ -n "$kv" ] && set -- "$@" --env "$kv"
  done <<EOF
$LAUNCH_ENV
EOF
  # A debugging aid (the Mac CI's update test): where the relaunched app's output goes.
  out=$(printf '%s\n' "$LAUNCH_ENV" | sed -n 's/^TYPD_APP_UPDATE_STDOUT=//p' | head -n 1)
  [ -n "$out" ] && set -- "$@" --stdout "$out" --stderr "$out"
  if open "$@" 2>&1; then log "started $a"; return 0; fi
  exe=$(plutil -extract CFBundleExecutable raw -o - "$a/Contents/Info.plist" 2>/dev/null || echo Typd)
  log "open failed; starting $a/Contents/MacOS/$exe directly"
  nohup "$a/Contents/MacOS/$exe" >/dev/null 2>&1 &
}

CARRIED=""
# Move every CARRY path that is in $1 and not in $2 from $1 to $2, and remember it.
carry() {
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -e "$1/$p" ] && [ ! -e "$2/$p" ]; then
      mkdir -p "$(dirname "$2/$p")" && mv "$1/$p" "$2/$p" || return 1
      CARRIED="$CARRIED$p
"
      log "carried $p"
    fi
  done <<EOF
$CARRY
EOF
  return 0
}
# Move what carry() moved from $1 back to $2.
carry_back() {
  printf '%s' "$CARRIED" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -e "$1/$p" ] && [ ! -e "$2/$p" ]; then
      mkdir -p "$(dirname "$2/$p")" && mv "$1/$p" "$2/$p" || log "could not put back $p"
    fi
  done
}

# Nothing changed (or all of it undone): say so, start the installed version again, stop.
abort() {
  log "aborted: $1"
  result aborted "$1"
  [ -d "$APP" ] && launch "$APP"
  exit 1
}

log "installing Typd $VERSION over $FROM at $APP"
if ! wait_gone "$OLD_PID" 60; then log "Typd ($OLD_PID) did not quit within 60 s; stopping it"; kill -9 "$OLD_PID" 2>/dev/null; sleep 1; fi
stop_inside "$APP"

PARENT=$(dirname "$APP")
[ -d "$APP/Contents" ] || abort "the installed app is not at $APP"
[ -d "$NEW/Contents" ] || abort "the staged app is missing at $NEW"
if [ ! -w "$PARENT" ] || [ ! -w "$APP/Contents/Resources" ]; then abort "no permission to write $PARENT"; fi
rm -rf "$NEWIN" "$OLD" "$FAILED"
mv "$NEW" "$NEWIN" || abort "could not move the new version next to the installed one"

undo_new() { carry_back "$NEWIN" "$APP"; rm -rf "$NEWIN"; abort "$1"; }
carry "$APP" "$NEWIN" || undo_new "could not carry the installed files over"
xattr -dr com.apple.quarantine "$NEWIN" 2>/dev/null
if [ -n "$CARRIED" ]; then
  codesign --force --sign - "$NEWIN" 2>&1 || undo_new "could not sign the new version"
fi
codesign --verify --strict "$NEWIN" 2>&1 || undo_new "the new version's signature does not verify"

mv "$APP" "$OLD" || undo_new "could not move the installed version aside"
if ! mv "$NEWIN" "$APP"; then
  mv "$OLD" "$APP"
  undo_new "could not move the new version into place"
fi
log "swapped: $APP is Typd $VERSION; $FROM waits at $OLD"
[ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1

launch "$APP"
t=0; NPID=""; VSTATE=""
while :; do
  if [ -f "$DIR/verdict.json" ]; then
    v=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$DIR/verdict.json" 2>/dev/null)
    if [ "$v" = "$VERSION" ]; then
      VSTATE=$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$DIR/verdict.json" 2>/dev/null)
      NPID=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$DIR/verdict.json" 2>/dev/null)
      case "$VSTATE" in ok|failed) break ;; esac
    fi
  fi
  t=$((t + 1))
  if [ -z "$NPID" ] && [ "$t" -ge $((STARTED_TIMEOUT_S * 4)) ]; then VSTATE=silent; break; fi
  if [ "$t" -ge $((VERDICT_TIMEOUT_S * 4)) ]; then VSTATE=timeout; break; fi
  if [ -n "$NPID" ] && ! kill -0 "$NPID" 2>/dev/null; then VSTATE=crashed; break; fi
  sleep 0.25
done

if [ "$VSTATE" = ok ]; then
  rm -rf "$OLD"
  result ok "Typd $VERSION passed its start-up self-test"
  exit 0
fi

case "$VSTATE" in
  failed) why="Typd $VERSION failed its start-up self-test" ;;
  crashed) why="Typd $VERSION quit before its self-test finished" ;;
  silent) why="Typd $VERSION did not start within $STARTED_TIMEOUT_S s" ;;
  *) why="Typd $VERSION did not pass its self-test within $VERDICT_TIMEOUT_S s" ;;
esac
log "$why; putting $FROM back"
if [ -n "$NPID" ] && kill -0 "$NPID" 2>/dev/null; then
  kill "$NPID" 2>/dev/null
  wait_gone "$NPID" 10 || kill -9 "$NPID" 2>/dev/null
fi
stop_inside "$APP"
if mv "$APP" "$FAILED"; then
  carry_back "$FAILED" "$OLD"
  if mv "$OLD" "$APP"; then rm -rf "$FAILED"; else log "could not put $FROM back; it is at $OLD"; fi
else
  log "could not move the failed version aside"
fi
[ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1
result bad "$why"
launch "$APP"
exit 1
