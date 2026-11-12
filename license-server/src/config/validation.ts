/**
 * License-server configuration validation.
 *
 * FAIL-CLOSED: any missing, malformed, or insecure value refuses to start.
 * No database connection is established until this passes.
 */
import { z } from 'zod';
import * as fs from 'node:fs';

const JwtSecret = z
  .string()
  .min(64, 'JWT_SECRET must be a hex string of at least 64 characters (32 bytes)')
  .refine((s) => /^[0-9a-f]{64}$/.test(s), 'JWT_SECRET must be a 64-char lowercase hex string from openssl rand -hex 32');

export const configSchema = z.object({
  PORT: z.string().default('8443'),
  DB_PATH: z
    .string()
    .default('./license.db')
    .refine(
      (p) => {
        // Fail-closed: DB_PATH must never resolve back to the CRM database.
        // The CRM is data/blackstack-crm.db; any run that reaches that path is
        // a misconfiguration and must refuse to start.
        const resolved = p.replace(/^\//, '').replace(/^\//, '');
        return !/blackstack-crm\.db$/.test(resolved);
      },
      ({ path }) => `${path} must not point to the CRM database (data/blackstack-crm.db)`,
    ),
  TOKEN_AUDIENCE: z
    .string()
    .min(1, 'TOKEN_AUDIENCE must match the client that signed the token'),
  JWT_SECRET: JwtSecret,
  JWT_EXPIRY: z.string().default('15m'),
  CLOCK_TOLERANCE_MS: z
    .string()
    .regex(/^\d+$/, 'CLOCK_TOLERANCE_MS must be a number of milliseconds')
    .default('60000'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env = process.env) {
  const parsed = configSchema.parse(env);
  return {
    port: Number(parsed.PORT),
    dbPath: parsed.DB_PATH,
    tokenAudience: parsed.TOKEN_AUDIENCE,
    jwtSecret: parsed.JWT_SECRET,
    jwtExpiry: parsed.JWT_EXPIRY,
    clockToleranceMs: Number(parsed.CLOCK_TOLERANCE_MS),
    nodeEnv: parsed.NODE_ENV,
  };
}

export function readConfigFile(path: string) {
  // Read an existing .env file without throwing on missing file (early deploy).
  if (!fs.existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}
