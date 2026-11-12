#!/usr/bin/env node
/**
 * Generate the HS256 signing key for the license-server service-token JWT.
 *
 * Never committed to the repository and never stored in environment
 * variables in plaintext. Recommended:
 *   - production: KMS / vault (operator injects JWT_SECRET)
 *   - local dev:  openssl rand -hex 32
 *
 * Usage: npm run keygen
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
const ROOT = path.resolve(__dirname, '..', '..', '..');

const outFile = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : false;
const secret = crypto.randomBytes(32).toString('hex');

if (outFile) {
  fs.writeFileSync(outFile, `JWT_SECRET=${secret}\n`, { mode: 0o600 });
  console.log(`[keygen] wrote JWT_SECRET to ${outFile} (mode 600, do not commit)`);
} else {
  console.log(`[keygen] generated 64-char hex secret (32 bytes).\n[!] Do NOT commit this to git. Inject via env or KMS.`);
  console.log('--- secret ---');
  console.log(secret);
  console.log('--- end secret ---');
}
