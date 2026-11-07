#!/bin/bash
# Mac CI: Typd's code-signing certificate into a keychain of its own, so scripts/after-pack.js and
# scripts/app-update-package.js sign with it (docs/MAC.md "Code signing").
#
#   MAC_CODESIGN_P12            base64 PKCS#12 (the repository secret; made by
#                               dictation-research/scripts/make_mac_codesign_cert.sh)
#   MAC_CODESIGN_P12_PASSWORD   its password (the repository secret)
#
# Writes to $GITHUB_ENV: TYPD_MAC_SIGN_IDENTITY (the certificate's SHA-1, which must be the one in
# scripts/mac-signing.json) and TYPD_MAC_SIGN_KEYCHAIN. Prints only public facts. Without the
# secrets it fails: an ad-hoc release would cost every Mac its privacy switches.
# `bash scripts/mac-signing-import.sh --delete` removes the keychain again (the job's last step).
set -euo pipefail

KC="$RUNNER_TEMP/typd-signing.keychain-db"
if [ "${1:-}" = "--delete" ]; then
  security delete-keychain "$KC" 2>/dev/null && echo "deleted $KC" || echo "no keychain to delete"
  exit 0
fi

# Developer ID (0.2.13): when the MAC_DEVID_P12 secrets are there, Typd is signed with Apple's Developer ID
# Application certificate instead, with the hardened runtime and Apple's timestamp, so it can be notarized
# and a downloaded copy opens without Gatekeeper's warning. Writes TYPD_MAC_SIGN_DEVID=1 and
# TYPD_MAC_TEAM_ID too. The designated requirement becomes Apple's (anchor apple generic + the Team ID).
if [ -n "${MAC_DEVID_P12:-}" ]; then
  : "${MAC_DEVID_P12_PASSWORD:?the MAC_DEVID_P12_PASSWORD secret is missing}"
  P12="$RUNNER_TEMP/typd-devid.p12"
  trap 'rm -f "$P12"' EXIT
  (umask 077; printf '%s' "$MAC_DEVID_P12" | base64 --decode > "$P12")
  KCPASS=$(openssl rand -hex 24)
  security create-keychain -p "$KCPASS" "$KC"
  security set-keychain-settings -lut 21600 "$KC"
  security unlock-keychain -p "$KCPASS" "$KC"
  security import "$P12" -k "$KC" -f pkcs12 -P "$MAC_DEVID_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC" >/dev/null
  # Apple's Developer ID intermediates (G2 and the previous one), so codesign can build the chain.
  for ca in DeveloperIDG2CA DeveloperIDCA; do
    if curl -fsSL "https://www.apple.com/certificateauthority/$ca.cer" -o "$RUNNER_TEMP/$ca.cer"; then
      security import "$RUNNER_TEMP/$ca.cer" -k "$KC" >/dev/null 2>&1 || true
    fi
  done
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
  line=$(security find-identity -v -p codesigning "$KC" | grep 'Developer ID Application' | head -n 1 || true)
  HAVE=$(echo "$line" | awk '{print $2}')
  TEAM=$(echo "$line" | sed -n 's/.*(\([A-Z0-9]\{10\}\))".*/\1/p')
  if [ -z "$HAVE" ] || [ -z "$TEAM" ]; then echo "MAC_DEVID_P12 holds no valid Developer ID Application identity"; security find-identity -p codesigning "$KC"; exit 1; fi
  if [ -n "${APPLE_TEAM_ID:-}" ] && [ "$TEAM" != "$APPLE_TEAM_ID" ]; then echo "the certificate's Team ID is not APPLE_TEAM_ID"; exit 1; fi
  echo "imported a Developer ID Application certificate, SHA-1 $HAVE"
  probe="$RUNNER_TEMP/typd-sign-probe"
  cp /usr/bin/true "$probe"
  codesign --force --sign "$HAVE" --keychain "$KC" --timestamp --options runtime "$probe"
  codesign --verify --strict "$probe"
  echo "a probe signed with it: $(codesign -d -r- "$probe" 2>&1 | grep designated)"
  rm -f "$probe"
  {
    echo "TYPD_MAC_SIGN_IDENTITY=$HAVE"
    echo "TYPD_MAC_SIGN_KEYCHAIN=$KC"
    echo "TYPD_MAC_SIGN_DEVID=1"
    echo "TYPD_MAC_TEAM_ID=$TEAM"
  } >> "$GITHUB_ENV"
  exit 0
fi

: "${MAC_CODESIGN_P12:?the MAC_CODESIGN_P12 secret is missing (dictation-research/scripts/make_mac_codesign_cert.sh --reupload)}"
: "${MAC_CODESIGN_P12_PASSWORD:?the MAC_CODESIGN_P12_PASSWORD secret is missing}"

P12="$RUNNER_TEMP/typd-signing.p12"
trap 'rm -f "$P12"' EXIT
(umask 077; printf '%s' "$MAC_CODESIGN_P12" | base64 --decode > "$P12")
KCPASS=$(openssl rand -hex 24)
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security import "$P12" -k "$KC" -f pkcs12 -P "$MAC_CODESIGN_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')

WANT=$(node -p "require('./scripts/mac-signing.json').sha1.toUpperCase()")
HAVE=$(security find-certificate -a -c "Typd Code Signing" -Z "$KC" | awk '/SHA-1 hash:/ {print $3}' | head -n 1)
if [ "$HAVE" != "$WANT" ]; then echo "the imported certificate is ${HAVE:-none}; scripts/mac-signing.json says $WANT"; exit 1; fi
echo "imported Typd Code Signing, SHA-1 $HAVE (as scripts/mac-signing.json)"

# A self-signed certificate is not trusted on this Mac. If codesign will not sign with it as it is,
# trust it for code signing on this runner only (trust is not part of a signature: the designated
# requirement names the certificate's hash either way, and a user's Mac never needs to trust it).
probe="$RUNNER_TEMP/typd-sign-probe"
cp /usr/bin/true "$probe"
if codesign --force --sign "$HAVE" --keychain "$KC" --timestamp=none "$probe" 2>"$RUNNER_TEMP/typd-sign-probe.err"; then
  echo "codesign signs with it as it is (untrusted)"
else
  echo "codesign refused it untrusted: $(tr '\n' ' ' < "$RUNNER_TEMP/typd-sign-probe.err")- trusting it for code signing on this runner"
  security find-certificate -c "Typd Code Signing" -p "$KC" > "$RUNNER_TEMP/typd-signing.cer"
  sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$RUNNER_TEMP/typd-signing.cer"
  codesign --force --sign "$HAVE" --keychain "$KC" --timestamp=none "$probe"
fi
codesign --verify --strict "$probe"
echo "a probe signed with it: $(codesign -d -r- "$probe" 2>&1 | grep designated)"
rm -f "$probe" "$RUNNER_TEMP/typd-sign-probe.err"

echo "TYPD_MAC_SIGN_IDENTITY=$HAVE" >> "$GITHUB_ENV"
echo "TYPD_MAC_SIGN_KEYCHAIN=$KC" >> "$GITHUB_ENV"
