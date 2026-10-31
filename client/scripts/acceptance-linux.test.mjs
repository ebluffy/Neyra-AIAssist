import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'acceptance-linux.sh');
const doc = join(import.meta.dirname, '../docs/ACCEPTANCE-LINUX.md');

function bashBin() {
  const candidates = process.platform === 'win32'
    ? ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe']
    : ['bash'];
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
}

const bash = bashBin();

function run(args) {
  const result = spawnSync(bash, [script, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `bash exited ${result.status}`);
  }
  return result.stdout;
}

describe('acceptance-linux.sh', () => {
  it.skipIf(!bash)('parses monitor scales and a wakeword manifest', () => {
    expect(run(['--self-test'])).toContain('self-test ok');
  });

  it.skipIf(!bash)('names the owner command and the local updater flag', () => {
    const help = run(['--help']);
    expect(help).toContain('bash client/scripts/acceptance-linux.sh');
    expect(help).toContain('--check-only');
    expect(help).toContain('--updater');
  });

  it('keeps the Russian doc pointed at the same command', () => {
    const text = readFileSync(doc, 'utf8');
    expect(text).toContain('bash client/scripts/acceptance-linux.sh');
    expect(text).toContain('--check-only');
    expect(text).toContain('client-beta');
    expect(text).not.toContain('TAURI_SIGNING_PRIVATE_KEY=');
  });
});
