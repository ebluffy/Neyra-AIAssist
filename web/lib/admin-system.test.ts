import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDeployCommit } from './admin-system';

describe('readDeployCommit', () => {
  it('reads the sha written by deploy and shortens it for display', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neyra-deploy-'));
    const file = join(dir, '.deploy-sha');
    await writeFile(file, '10d876282c81e168535c5441378087616c3d2e63\n');
    expect(await readDeployCommit(file)).toBe('10d876282c81');
  });

  it('returns null instead of throwing when the file is missing', async () => {
    expect(await readDeployCommit('/nonexistent/.deploy-sha')).toBeNull();
  });
});
