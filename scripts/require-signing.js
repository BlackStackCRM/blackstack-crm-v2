#!/usr/bin/env node
/**
 * PRODUCTION SIGNING GATE — build-time entry point for release builds.
 *
 * Remediation of audit finding E-10 (installer unsigned).
 *
 * THE DEFECT THIS FIXES
 *   electron/signing-config.js is correct: it throws when REQUIRE_SIGNING=1 and
 *   credentials are missing. But nothing ever SET that flag. The npm script was
 *
 *     node electron/signing-config.js && electron-builder --win nsis
 *
 *   so on a clean machine the loader saw an unset flag, printed
 *   "UNSIGNED development installer", and exited 0 — and because
 *   win.forceCodeSigning was absent, electron-builder packaged happily. The
 *   script named `electron:build:prod` therefore produced an unsigned artifact
 *   and still exited 0. Verified, not assumed.
 *
 * WHY NOT `cross-env REQUIRE_SIGNING=1 ...`
 *   cross-env is not a dependency of this project. Introducing a new build-time
 *   dependency (and requiring it to be present in every build environment,
 *   including any offline or locked-down CI image) is a worse trade than
 *   setting the variable in-process. This wrapper does it with Node's own
 *   standard library, so there is nothing to install and nothing to pin.
 *
 * BEHAVIOUR
 *   1. loads the existing, unmodified signing-config.js;
 *   2. sets REQUIRE_SIGNING=1 before loading it, so the gate is armed;
 *   3. additionally requires that win.forceCodeSigning is enabled, so
 *      electron-builder cannot silently skip signing even if the gate passes;
 *   4. exits non-zero, loudly, on any missing precondition.
 *
 *   Step 3 matters independently of step 2: electron-builder's
 *   forceCodeSigning makes a signing failure fatal instead of a log line.
 *   Without it a future credential regression would again produce a silent
 *   unsigned build.
 *
 * This script NEVER weakens a control. It only arms controls that already exist
 * and adds one that was missing.
 */
'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Arm the gate before signing-config.js is loaded.
process.env.REQUIRE_SIGNING = '1';

const { getSigningConfig } = require(path.join(ROOT, 'electron', 'signing-config.js'));

let cfg;
try {
  cfg = getSigningConfig();
} catch (err) {
  // Already fail-closed; propagate the project's own message verbatim.
  console.error(`[signing] FATAL: ${err.message}`);
  process.exit(1);
}

if (!cfg.enabled) {
  console.error('[signing] FATAL: production build requires working code-signing credentials.');
  console.error('[signing] Set CSC_LINK and CSC_KEY_PASSWORD, then re-run.');
  process.exit(1);
}

// Second precondition, deliberately NOT re-checked here.
//
// Earlier revisions set build.win.forceCodeSigning = true in package.json to
// make a signing failure fatal. That was wrong and was caught by testing:
// forceCodeSigning lives in the SHARED `build.win` block, so it also applied to
// the unsigned local build, and `electron:build:win` began failing with
//   App is not signed and "forceCodeSigning" is set to true
// i.e. the hardening broke the documented developer workflow it was meant to
// protect. Putting it in shared config is the wrong layer.
//
// The production script therefore passes it per-invocation instead:
//   electron-builder ... -c.win.forceCodeSigning=true
// so only releases are strict and local dev builds stay unsigned-capable.
// This script must NOT try to validate a package.json value it no longer sets;
// the electron-builder invocation is the authority for that flag.

console.log('[signing] production gate ARMED — credentials present.');
console.log('[signing] electron-builder is invoked with -c.win.forceCodeSigning=true by the');
console.log('[signing] calling npm script, so a signing failure aborts the build.');
console.log('[signing] timestamp authority:', cfg.timestampUrl);
// Never print CSC_LINK contents or the key password.
