import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// AR-41: --uses разбирается строго до подключения к БД, поэтому неверные
// значения можно проверять без DATABASE_URL.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'invite-create.mjs');

function runWithUses(value: string): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [script, '--uses', value], {
      env: { ...process.env, DATABASE_URL: '' },
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { status: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status ?? -1, stderr: String(failure.stderr ?? '') };
  }
}

describe('invite-create --uses (AR-41)', () => {
  for (const invalid of ['', '5abc', '1.9', '0', '10001']) {
    it(`rejects ${JSON.stringify(invalid)} before touching the database`, () => {
      const result = runWithUses(invalid);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('--uses');
    });
  }
});
