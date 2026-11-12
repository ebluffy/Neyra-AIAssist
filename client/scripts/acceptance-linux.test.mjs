import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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
  it('parses monitor scales and a wakeword manifest', { skip: !bash }, () => {
    assert.match(run(['--self-test']), /self-test ok/);
  });

  it('names the owner command and the local updater flag', { skip: !bash }, () => {
    const help = run(['--help']);
    assert.ok(help.includes('bash client/scripts/acceptance-linux.sh'));
    assert.ok(help.includes('--check-only'));
    assert.ok(help.includes('--updater'));
  });

  it('keeps the Russian doc pointed at the same command', () => {
    const text = readFileSync(doc, 'utf8');
    assert.ok(text.includes('bash client/scripts/acceptance-linux.sh'));
    assert.ok(text.includes('--check-only'));
    assert.ok(text.includes('client-beta'));
    assert.ok(!text.includes('TAURI_SIGNING_PRIVATE_KEY='));
  });
});
