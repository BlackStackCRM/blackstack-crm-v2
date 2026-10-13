#!/usr/bin/env node
/**
 * CODE-SIGNING CONFIGURATION LOADER — BlackStack CRM
 *
 * Part of the electron-builder configuration chain. This module exposes the
 * signing settings used by `npm run electron:build:prod` and documents the
 * credential contract.
 *
 * Certificate source
 * ------------------
 * A single PKCS#12/PFX certificate file, provided OUT-OF-BAND (never in git):
 *   - Locally: a file path kept outside the repository (e.g. on a USB key or
 *     secure network share).
 *   - CI/CD: a base64-encoded secret (e.g. GitHub secret WINDOWS_PFX_BASE64)
 *     decoded to a temp file by the workflow before the build starts.
 *
 * Environment variables
 * ---------------------
 *   CSC_LINK            path or https URL to the .pfx certificate
 *   CSC_KEY_PASSWORD    private key password for the .pfx
 *   BLACKSTACK_TSA_URL  RFC-3161 timestamp authority (default DigiCert)
 *   REQUIRE_SIGNING     when "1", the build FAILS if credentials are missing
 *
 * Local development builds
 * ------------------------
 * With no CSC_LINK, `npm run electron:build:win` produces an UNSIGNED
 * installer. That is expected and allowed; unsigned builds must never be
 * published (see installer/docs/release-checklist.md).
 *
 * Production release builds
 * -------------------------
 * `npm run electron:build:prod` sets REQUIRE_SIGNING=1: if credentials are
 * missing the build fails clearly before packaging, with no fabricated
 * success.
 */
const fs = require('fs');

const REQUIRED_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
const DEFAULT_TSA = 'http://timestamp.digicert.com';

function getSigningConfig() {
  const link = process.env.CSC_LINK;
  const password = process.env.CSC_KEY_PASSWORD;
  const requireSigning = process.env.REQUIRE_SIGNING === '1';
  const tsaUrl = process.env.BLACKSTACK_TSA_URL || DEFAULT_TSA;

  const hasCredentials = Boolean(link && password);

  if (requireSigning && !hasCredentials) {
    // Fail loudly — never produce a "production" installer that is unsigned
    // while pretending signing is configured.
    throw new Error(
      'REQUIRE_SIGNING=1 but signing credentials are missing. Set CSC_LINK and CSC_KEY_PASSWORD ' +
        '(see installer/docs/security.md, section "Code signing configuration"). Build aborted.'
    );
  }

  if (link && !fs.existsSync(link) && !/^https?:\/\//.test(link)) {
    throw new Error(`CSC_LINK points to a non-existent file: ${link}`);
  }

  return {
    enabled: hasCredentials,
    required: requireSigning,
    timestampUrl: tsaUrl,
    // electron-builder picks up CSC_LINK / CSC_KEY_PASSWORD from env
    // automatically; we do not copy secrets into config files.
    envKeys: REQUIRED_ENV,
  };
}

module.exports = { getSigningConfig, DEFAULT_TSA };

// When run directly (node electron/signing-config.js) act as a build-time gate:
// validates the credential contract before electron-builder starts.
if (require.main === module) {
  try {
    const cfg = getSigningConfig();
    if (cfg.enabled) {
      console.log('[signing] Code signing enabled. Timestamp authority:', cfg.timestampUrl);
    } else if (cfg.required) {
      console.error('[signing] ERROR: REQUIRE_SIGNING=1 but no signing credentials found (CSC_LINK / CSC_KEY_PASSWORD).');
      process.exit(1);
    } else {
      console.log('[signing] No signing credentials - building UNSIGNED development installer. Not for release.');
    }
  } catch (e) {
    console.error('[signing] FATAL:', e.message);
    process.exit(1);
  }
}
