'use strict';

/**
 * The public half of the key that signs the model manifest (src/main/modelUpdate.js). Typd follows a
 * model manifest only if one of these keys signed its exact text (typd-collect serves the signature
 * beside it, in X-Typd-Manifest-Key and X-Typd-Manifest-Sig), so a changed Worker or bucket cannot
 * hand every install a different model.
 *
 * The private half is on the developer's PC only, outside every repository:
 * dictation-research/.secrets/model_manifest_ed25519.pem (git-ignored), used by
 * dictation-research/scripts/publish_model.py. It is its own key, apart from the app-update key
 * (appUpdateKey.js): models are published far more often, and a leak could at worst offer a bad model
 * (the start-up self-test and revert still guard that), never code. If it is lost or leaks, an app
 * update that trusts a new key here fixes it; until then a new model cannot be published.
 *
 * Key ids are names, not secrets. A second key can be added here (rotation) and shipped before it
 * signs anything; the manifest's headers name the key that signed it.
 */

module.exports = {
  keys: {
    'typd-model-2146b023': [
      '-----BEGIN PUBLIC KEY-----',
      'MCowBQYDK2VwAyEACNpVVcB7Fyi8LjjHZAp93qpnKqZ3n7+zHUEL4wq+r9I=',
      '-----END PUBLIC KEY-----'
    ].join('\n') + '\n'
  }
};
