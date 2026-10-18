#!/bin/bash
# The Mac CI's microphone check: Typd's first launch asks macOS for the microphone as a new user's
# does, and macOS's privacy service (TCC) prompts for it as Typd.
#
#   scripts/mac-mic-check.sh <Typd.app> [label]
#
# Needs $RUNNER_TEMP/mac-alert (swiftc -O scripts/mac-alert.swift) and sudo (log stream, TCC.db).
# Typd starts the way Finder starts it (open), on a fresh profile with the microphone reset, the
# walkthrough on, and TYPD_MIC_WAIT_MS=20000 (a launch check waits 20 s on macOS's prompt, not 90).
#
# Gates (any one failing fails the check):
#   1. tccd prompts: AUTHREQ_PROMPTING for kTCCServiceMicrophone with subject ai.typd.app -- the request
#      is Typd's own, not a helper's or the shell's, and macOS does not refuse it by policy (the way it
#      refuses a hardened-runtime app without com.apple.security.device.audio-input);
#   2. Typd's life log says it asked ("microphone: asking macOS");
#   3. with nobody answering, Typd does not wait forever (0.2.6 did: nothing asked again, nothing
#      said): "no answer from macOS after 20 s" in the life log, and no modal dialog of Typd's over
#      macOS's prompt (a modal holds Typd itself up, macOS's answer included: seen here, 22 s);
#   4. Allow pressed in macOS's alert (Accessibility; skipped with a note where the runner has none):
#      "macOS answered: allowed" in the life log at once, TCC holds the answer -- the row that puts
#      Typd in Privacy & Security > Microphone (its location moved in macOS 27; both read) -- and the
#      check runs again for the other switches;
#   5. the reporter's macOS 27 sequence: first run from ~/Downloads (the move offer comes before any
#      macOS prompt), Don't Allow, that copy deleted, Typd installed in /Applications: its dialog offers
#      "Ask macOS Again", which unregisters the gone copy, resets Typd's answer and prompts; Allow.
# Informational: the alert's own text, and whether a stale alert was there before the launch.
set -u
APP=$1
LABEL=${2:-mic}
BIN="$APP/Contents/MacOS/Typd"
UD="$HOME/Library/Application Support/typd"
ALERT="$RUNNER_TEMP/mac-alert"
OUT="$RUNNER_TEMP/mic-$LABEL.out"
TLOG="$RUNNER_TEMP/mic-$LABEL.tcc"
LIFE="$UD/logs/life.log"
fail=0
say() { echo "[$LABEL] $*"; }
bad() { echo "[$LABEL] FAIL $*"; fail=1; }
life() { grep -a "$1" "$LIFE" 2>/dev/null | tail -n 1; }
rows() {
  { echo "$HOME/Library/Application Support/com.apple.TCC/TCC.db"
    sudo find /private/var/containers/Data/ProtectedSystem -name 'TCC.db' -path '*com.apple.TCC*' 2>/dev/null; } |
  while IFS= read -r db; do
    sudo test -f "$db" || continue
    sudo sqlite3 "$db" "SELECT service||' '||auth_value FROM access WHERE client = 'ai.typd.app' AND service = 'kTCCServiceMicrophone';" 2>/dev/null
  done
}

pkill -f "$BIN" 2>/dev/null; sleep 2
"$ALERT" windows | grep -q UserNotificationCenter && say "a macOS alert was already on screen; restarting UserNotificationCenter"
killall UserNotificationCenter 2>/dev/null; sleep 1
tccutil reset Microphone ai.typd.app >/dev/null 2>&1
rm -rf "$UD"
sudo log stream --level debug --style compact --predicate 'subsystem == "com.apple.TCC" OR process == "tccd"' > "$TLOG" 2>&1 &
lp=$!
sleep 2
say "starting $APP as Finder does, fresh profile, microphone never answered"
open "$APP" --env TYPD_DEBUG=1 --env TYPD_NO_MODEL_UPDATE=1 --env TYPD_NO_APP_UPDATE=1 --env TYPD_NO_SHARE=1 --env TYPD_MIC_WAIT_MS=20000 \
  ${TYPD_MODEL_DIR:+--env "TYPD_MODEL_DIR=$TYPD_MODEL_DIR"} --stdout "$OUT" --stderr "$OUT.err"

# 1. macOS prompts, as Typd
ok=0
for _ in $(seq 1 20); do
  if grep -aqE 'AUTHREQ_PROMPTING: .*service=kTCCServiceMicrophone, subject=Sub:\{ai\.typd\.app\}' "$TLOG"; then ok=1; break; fi
  sleep 1
done
if [ $ok = 1 ]; then say "1. tccd prompts for the microphone as ai.typd.app"; else bad "1. no AUTHREQ_PROMPTING for kTCCServiceMicrophone, subject ai.typd.app"; fi
if grep -aqiE 'Policy disallows prompt.*ai\.typd\.app' "$TLOG"; then bad "1. tccd: policy disallows the prompt"; grep -aiE 'disallow' "$TLOG" | head -3; fi
grep -aE 'Handling access request to kTCCServiceMicrophone' "$TLOG" | head -1 | sed -E 's/.*(from Sub:\{[^}]*\}Resp:\{TCCDProcess: identifier=[^,]*).*/  request: \1/'
"$ALERT" texts UserNotificationCenter | head -6 | sed 's/^/  alert /'

# 2. Typd says it asked
sleep 2
l=$(life 'microphone: asking macOS')
if [ -n "$l" ]; then say "2. life log: ${l#*] }"; else bad "2. no 'microphone: asking macOS' in the life log"; fi

# 3. nobody answers: Typd stops waiting after 20 s and explains (its own dialog)
ok=0
for _ in $(seq 1 30); do
  if [ -n "$(life 'no answer from macOS after 20 s')" ]; then ok=1; break; fi
  sleep 1
done
if [ $ok = 1 ]; then say "3. life log: $(life 'no answer from macOS' | sed 's/^.*\] //')"; else bad "3. Typd never stopped waiting on macOS's prompt"; fi
sleep 3
"$ALERT" windows | sed 's/^/  /' | head -8
l=$(life 'still unanswered: no dialog')
[ -n "$l" ] && say "3. life log: ${l#*] }" || bad "3. no word from Typd about the unanswered prompt"
if "$ALERT" windows | grep -qE '^window: Typd layer (8|[1-9][0-9])'; then bad "3. a modal dialog of Typd's is over macOS's prompt"; else say "3. no modal dialog of Typd's over macOS's prompt"; fi
"$ALERT" windows | grep -qE '^window: UserNotificationCenter' && say "3. macOS's prompt is still on screen" || say "3. (macOS's prompt is not on screen)"
grep -aE '^\[typd:permissions\]' "$OUT" | tail -3 | sed 's/^/  /'

# 4. Allow: Typd hears the answer, and TCC holds it (Typd in the Microphone list)
p=$("$ALERT" press UserNotificationCenter Allow)
say "4. $p"
if [ "$p" = "AX not trusted" ]; then
  say "4. skipped: this runner may not use Accessibility to press Allow"
else
  ok=0
  for _ in $(seq 1 15); do
    if [ -n "$(life 'macOS answered: allowed')" ]; then ok=1; break; fi
    sleep 1
  done
  if [ $ok = 1 ]; then say "4. life log: $(life 'macOS answered' | sed 's/^.*\] //')"; else bad "4. Typd did not hear macOS's answer"; life microphone; life 'main thread late'; fi
  ok=0
  for _ in $(seq 1 10); do grep -aq 'checked for the microphone answer' "$OUT" && { ok=1; break; }; sleep 1; done
  [ $ok = 1 ] && say "4. the check ran again after the answer: $(grep -a 'checked for the microphone answer' "$OUT" | tail -1)" || bad "4. no check after macOS's answer (the other switches unexplained)"
  r=$(rows | tr '\n' ' ')
  if echo "$r" | grep -q 'kTCCServiceMicrophone 2'; then say "4. TCC: kTCCServiceMicrophone allowed for ai.typd.app (Typd is in the Microphone list)"; else bad "4. no TCC row for ai.typd.app's microphone ($r)"; fi
fi

pkill -f "$BIN" 2>/dev/null; sleep 2

# 5. The reporter's macOS 27 (0.2.6): Typd first run from ~/Downloads, "Don't Allow", that copy deleted and
#    Typd installed in /Applications. LaunchServices still pointed ai.typd.app at the deleted copy, macOS
#    said "denied", and System Settings listed no Typd to switch on. Now: the Downloads copy offers the
#    move to Applications before macOS is asked anything; and the /Applications copy's dialog offers
#    "Ask macOS Again", which forgets the gone copy in LaunchServices, resets Typd's own answer and asks.
#    Gates: the move offer comes first, with no macOS prompt behind it; "Ask macOS Again" unregisters the
#    gone copy and macOS prompts again (AUTHREQ_PROMPTING); Allow is heard and recorded.
if [ "$p" = "AX not trusted" ]; then
  say "5. skipped: needs Accessibility to press buttons"
else
  LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  to() { perl -e 'alarm shift; exec @ARGV' "$@"; }
  DL="$HOME/Downloads/Typd.app"; AP=/Applications/Typd.app
  openapp() { to 20 open "$1" --env TYPD_DEBUG=1 --env TYPD_NO_MODEL_UPDATE=1 --env TYPD_NO_APP_UPDATE=1 --env TYPD_NO_SHARE=1 --env TYPD_NO_WALKTHROUGH=1 --env TYPD_MIC_WAIT_MS=20000 --stdout "$2" --stderr "$2.err"; }
  waitfor() { for _ in $(seq 1 "$2"); do "$ALERT" texts "$3" | grep -qE "$1" && return 0; sleep 1; done; return 1; }
  killall UserNotificationCenter 2>/dev/null; sleep 1
  tccutil reset Microphone ai.typd.app >/dev/null 2>&1
  rm -rf "$UD" "$DL" "$AP"
  ditto "$APP" "$DL"
  : > "$TLOG"
  openapp "$DL" "$OUT.dl"
  if waitfor 'Move Typd to your Applications folder' 20 Typd; then say "5. from ~/Downloads: Typd offers the move to Applications first"; else bad "5. no move offer from a Typd in ~/Downloads"; fi
  if grep -aq 'AUTHREQ_PROMPTING: .*service=kTCCServiceMicrophone' "$TLOG"; then bad "5. macOS was asked for the microphone while the move offer was up"; else say "5. ...and macOS was not asked anything before it"; fi
  "$ALERT" click Typd "Not Now" | sed 's/^/  /'
  sleep 2
  [ -n "$(life 'kept this copy where it is')" ] && say "5. Not Now heard" || bad "5. the move offer's Not Now was not heard"
  if waitfor 'access your microphone|would like to access the microphone' 45 UserNotificationCenter; then "$ALERT" press UserNotificationCenter "Don't Allow" | sed 's/^/  /'; else bad "5. no microphone prompt after Not Now"; fi
  sleep 3
  l=$(life 'macOS answered: not allowed'); [ -n "$l" ] && say "5. the Downloads copy: ${l#*] }" || bad "5. Don't Allow not heard"
  pkill -f "$DL/Contents/MacOS/Typd" 2>/dev/null; sleep 3
  rm -rf "$DL"
  ditto "$APP" "$AP"
  say "5. LaunchServices now holds Typd at: $(to 60 "$LSREG" -dump 2>/dev/null | grep -aE '^(path|identifier):' | grep -aB1 'ai\.typd\.app$' | grep -a '^path' | sed -E 's/^path: +//; s/ \(0x[0-9a-f]+\)$//' | sort -u | tr '\n' ' ')"
  killall UserNotificationCenter 2>/dev/null; sleep 1
  : > "$TLOG"
  openapp "$AP" "$OUT.ap"
  if waitfor 'Ask macOS Again' 40 Typd; then say "5. /Applications copy: the dialog offers Ask macOS Again"; else bad "5. no Ask macOS Again in the /Applications copy's dialog"; "$ALERT" texts Typd | head -8; fi
  "$ALERT" click Typd "Ask macOS Again" | sed 's/^/  /'
  ok=0
  for _ in $(seq 1 25); do
    if grep -aqE 'AUTHREQ_PROMPTING: .*service=kTCCServiceMicrophone, subject=Sub:\{ai\.typd\.app\}' "$TLOG"; then ok=1; break; fi
    sleep 1
  done
  [ $ok = 1 ] && say "5. Ask macOS Again: macOS prompts again" || bad "5. no new prompt after Ask macOS Again"
  grep -a 'location: unregistered\|tccutil reset' "$LIFE" | tail -3 | sed 's/^.*\] /  life: /'
  [ -n "$(life 'unregistered a copy of Typd that is gone')" ] && say "5. the gone ~/Downloads copy was unregistered from LaunchServices" || say "5. (no gone copy left in LaunchServices to unregister)"
  "$ALERT" press UserNotificationCenter Allow | sed 's/^/  /'
  ok=0
  for _ in $(seq 1 15); do [ -n "$(life 'macOS answered: allowed')" ] && { ok=1; break; }; sleep 1; done
  [ $ok = 1 ] && say "5. Allow heard: $(life 'macOS answered: allowed' | sed 's/^.*\] //')" || bad "5. Allow not heard after Ask macOS Again"
  r=$(rows | tr '\n' ' ')
  echo "$r" | grep -q 'kTCCServiceMicrophone 2' && say "5. TCC: allowed (Typd in the Microphone list)" || bad "5. no allowed TCC row after Ask macOS Again ($r)"
  pkill -f "$AP/Contents/MacOS/Typd" 2>/dev/null; sleep 2
  rm -rf "$AP"
  # Leave LaunchServices as the next steps expect: the build folder's Typd, not the copies made here.
  to 30 "$LSREG" -u "$AP" >/dev/null 2>&1; to 30 "$LSREG" -u "$DL" >/dev/null 2>&1; to 30 "$LSREG" -f "$APP" >/dev/null 2>&1
fi

sudo kill "$lp" 2>/dev/null
killall UserNotificationCenter 2>/dev/null
echo "--- [$LABEL] life log"; tail -25 "$LIFE" 2>/dev/null
[ $fail = 0 ] && say "PASS" || say "FAILED"
exit $fail
