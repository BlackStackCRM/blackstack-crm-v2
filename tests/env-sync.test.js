import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { syncSupabaseCredentialsIntoEnv } from '../electron/env-sync.js';

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-env-sync-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writePackagedEnv(overrides = {}) {
  const supabaseUrl = overrides.supabaseUrl !== undefined ? overrides.supabaseUrl : 'https://qzxvcxywotqeqvwerofi.supabase.co';
  const supabaseKey = overrides.supabaseKey !== undefined ? overrides.supabaseKey : 'sb_publishable_correct_key';
  const lines = [
    'NODE_ENV=production',
    'PORT=3000',
    `SUPABASE_URL=${supabaseUrl}`,
    `SUPABASE_ANON_KEY=${supabaseKey}`,
  ];
  const file = path.join(tempDir, 'packaged.env');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function runSync(existingEnvText, packagedSource) {
  return syncSupabaseCredentialsIntoEnv(existingEnvText, packagedSource);
}

describe('syncSupabaseCredentialsIntoEnv', () => {
  describe('fresh installation (no existing Supabase values)', () => {
    it('adds packaged URL and key when both are missing', () => {
      const packaged = writePackagedEnv();
      const existing = 'NODE_ENV=production\nPORT=3000\nDB_PATH=/data/db';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(true);
      expect(result.patched).toContain('SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co');
      expect(result.patched).toContain('SUPABASE_ANON_KEY=sb_publishable_correct_key');
      expect(result.patched).toContain('NODE_ENV=production');
      expect(result.patched).toContain('PORT=3000');
      expect(result.patched).toContain('DB_PATH=/data/db');
    });

    it('adds only the missing key when URL matches', () => {
      const packaged = writePackagedEnv();
      const existing = 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nNODE_ENV=production';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(true);
      expect(result.patched).toContain('SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co');
      expect(result.patched).toContain('SUPABASE_ANON_KEY=sb_publishable_correct_key');
    });

    it('does not add key when packaged value is empty and URL matches', () => {
      const packaged = writePackagedEnv({ supabaseKey: '' });
      const existing = 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nNODE_ENV=production';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(false);
      expect(result.patched).not.toContain('SUPABASE_ANON_KEY');
    });
  });

  describe('upgrade with matching values', () => {
    it('does not change when URL and key already match packaged', () => {
      const packaged = writePackagedEnv();
      const existing = 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_correct_key\nNODE_ENV=production';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(false);
      expect(result.patched).toBe(existing);
    });

    it('does not add duplicate entries on repeated sync', () => {
      const packaged = writePackagedEnv();
      let existing = 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_correct_key\nNODE_ENV=production';
      const result1 = runSync(existing, packaged);
      expect(result1.changed).toBe(false);

      const result2 = runSync(result1.patched, packaged);
      expect(result2.changed).toBe(false);
      expect((result2.patched.match(/SUPABASE_URL=/g) || []).length).toBe(1);
      expect((result2.patched.match(/SUPABASE_ANON_KEY=/g) || []).length).toBe(1);
    });
  });

  describe('upgrade with stale/wrong values', () => {
    it('updates stale URL to packaged value', () => {
      const packaged = writePackagedEnv({ supabaseUrl: 'https://correct-project.supabase.co' });
      const existing = 'SUPABASE_URL=https://stale-project.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_correct_key\nNODE_ENV=production';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(true);
      expect(result.patched).toContain('SUPABASE_URL=https://correct-project.supabase.co');
      expect(result.patched).not.toContain('SUPABASE_URL=https://stale-project.supabase.co');
      expect(result.patched).toContain('SUPABASE_ANON_KEY=sb_publishable_correct_key');
    });

    it('updates stale key to packaged value', () => {
      const packaged = writePackagedEnv({ supabaseKey: 'sb_publishable_new_key' });
      const existing = 'SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_old_key\nNODE_ENV=production';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(true);
      expect(result.patched).toContain('SUPABASE_ANON_KEY=sb_publishable_new_key');
      expect(result.patched).not.toContain('SUPABASE_ANON_KEY=sb_publishable_old_key');
      expect(result.patched).toContain('SUPABASE_URL=https://qzxvcxywotqeqvwerofi.supabase.co');
    });

    it('updates both stale URL and key', () => {
      const packaged = writePackagedEnv({
        supabaseUrl: 'https://correct-project.supabase.co',
        supabaseKey: 'sb_publishable_new_key',
      });
      const existing = 'SUPABASE_URL=https://stale-project.supabase.co\nSUPABASE_ANON_KEY=sb_publishable_old_key\nNODE_ENV=production';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(true);
      expect(result.patched).toContain('SUPABASE_URL=https://correct-project.supabase.co');
      expect(result.patched).toContain('SUPABASE_ANON_KEY=sb_publishable_new_key');
      expect(result.patched).not.toContain('SUPABASE_URL=https://stale-project.supabase.co');
      expect(result.patched).not.toContain('SUPABASE_ANON_KEY=sb_publishable_old_key');
    });
  });

  describe('preserves unrelated runtime variables', () => {
    it('keeps DB_PATH, PORT, NODE_ENV and other variables', () => {
      const packaged = writePackagedEnv();
      const existing = 'NODE_ENV=production\nPORT=34567\nDB_PATH=/custom/data/blackstack-crm.db\nJWT_EXPIRY=7d\nCUSTOM_VAR=hello';
      const result = runSync(existing, packaged);

      expect(result.changed).toBe(true);
      expect(result.patched).toContain('NODE_ENV=production');
      expect(result.patched).toContain('PORT=34567');
      expect(result.patched).toContain('DB_PATH=/custom/data/blackstack-crm.db');
      expect(result.patched).toContain('JWT_EXPIRY=7d');
      expect(result.patched).toContain('CUSTOM_VAR=hello');
    });
  });

  describe('no packaged source available', () => {
    it('returns unchanged when no packaged env exists', () => {
      const existing = 'SUPABASE_URL=https://stale-project.supabase.co\nNODE_ENV=production';
      const result = runSync(existing, null);

      expect(result.changed).toBe(false);
      expect(result.patched).toBe(existing);
    });
  });
});
