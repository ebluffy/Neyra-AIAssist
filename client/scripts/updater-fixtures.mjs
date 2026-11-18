// Regenerates src-tauri/updater-test/fixtures with the committed TEST key.
// The "untrusted" key is created in a temp dir and thrown away on every run.
// Usage (from client/): node scripts/updater-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testDir = join(root, 'src-tauri/updater-test');
const out = join(testDir, 'fixtures');
const tauri = join(root, 'node_modules/.bin/tauri');
const work = mkdtempSync(join(tmpdir(), 'neyra-updater-'));
mkdirSync(out, { recursive: true });

const run = (...args) => execFileSync(tauri, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

const header = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);
const payload = Buffer.concat([header, Buffer.from('NEYRA TEST APPIMAGE 0.1.1\n'), Buffer.from(Array.from({ length: 512 }, (_, i) => i % 251))]);
const tampered = Buffer.from(payload);
tampered[100] ^= 0xff;
writeFileSync(join(out, 'payload.bin'), payload);
writeFileSync(join(out, 'payload.tampered.bin'), tampered);

function sign(keyPath, name, version) {
  const file = join(work, 'payload.bin');
  writeFileSync(file, payload);
  const args = ['signer', 'sign', '-f', keyPath, '-p', ''];
  if (version) args.push('--app-version', version);
  run(...args, file);
  renameSync(`${file}.sig`, join(out, name));
}

const attackerKey = join(work, 'untrusted.key');
run('signer', 'generate', '--ci', '-w', attackerKey, '-p', '');
const testKey = join(testDir, 'test.key');
sign(testKey, 'payload.valid.sig', '0.1.1');
sign(testKey, 'payload.version-0.1.0.sig', '0.1.0');
sign(testKey, 'payload.unversioned.sig');
sign(attackerKey, 'payload.untrusted-key.sig', '0.1.1');
writeFileSync(join(out, 'payload.truncated.sig'), readFileSync(join(out, 'payload.valid.sig')).subarray(0, 60));
writeFileSync(join(out, 'payload.garbage.sig'), 'not a signature at all\n');
rmSync(work, { recursive: true, force: true });
console.log('updater fixtures written to', out);
