'use strict';

/**
 * The public half of the key that signs Typd's app-update manifest (src/main/appUpdate.js).
 * The app installs nothing whose manifest this key does not verify.
 *
 * The private half is on the developer's PC only, outside every repository:
 * dictation-research/.secrets/app_update_ed25519.pem (git-ignored), used by
 * dictation-research/scripts/publish_app_update.py. README.md "App updates" says how to back it up.
 * If it is lost, apps that trust only this key can never update themselves again: a new key means
 * one manual reinstall for everyone.
 *
 * Key ids are names, not secrets. A second key can be added here (rotation) before the old one is
 * retired; a manifest names the key that signed it. The Mac CI's update test replaces this file
 * with a throwaway key of its own before it builds (.github/workflows/mac.yml).
 */

module.exports = {
  keys: {
    'typd-app-d98c5cc3': [
      '-----BEGIN PUBLIC KEY-----',
      'MCowBQYDK2VwAyEAu8Y98eebui6xlhWf1nAfsJfUuCSaFJH7zMUF8l4DYMU=',
      '-----END PUBLIC KEY-----'
    ].join('\n') + '\n'
  }
};
