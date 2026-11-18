import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { invokedDirectly, readVersions, versionProblems } from './check-versions.mjs';
import { publicKeyId, signatureKeyId, signedVersion } from './check-updater-signature.mjs';

const root = join(import.meta.dirname, '..');
const fixture = (name) => readFileSync(join(root, 'src-tauri/updater-test/fixtures', name), 'utf8');

describe('version sync', () => {
  it('package, tauri config, Cargo.toml and Cargo.lock agree', () => {
    assert.deepEqual(versionProblems(readVersions(root)), []);
  });
  it('reports a mismatch, a missing version and a bad tag', () => {
    const ok = { a: '0.1.0', b: '0.1.0' };
    assert.equal(versionProblems({ a: '0.1.0', b: '0.1.1' }).length, 1);
    assert.ok(versionProblems({ a: '0.1.0', b: undefined }).length > 0);
    assert.equal(versionProblems({ a: 'v1' }).length, 1);
    assert.deepEqual(versionProblems(ok, 'client-v0.1.0'), []);
    assert.equal(versionProblems(ok, 'client-v0.2.0').length, 1);
    assert.equal(versionProblems(ok, 'v0.1.0').length, 1);
  });
  it('accepts beta pre-release versions', () => {
    assert.deepEqual(versionProblems({ a: '0.1.0-beta.1' }, 'client-v0.1.0-beta.1'), []);
  });
  it('reads Cargo.lock when the checkout uses CRLF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neyra-ver-'));
    const tauri = join(dir, 'src-tauri');
    mkdirSync(tauri);
    const crlf = (text) => text.replace(/\n/g, '\r\n');
    writeFileSync(join(dir, 'package.json'), '{"version":"0.1.0"}\n');
    writeFileSync(join(tauri, 'tauri.conf.json'), '{"version":"0.1.0"}\n');
    writeFileSync(join(tauri, 'Cargo.toml'), crlf('[package]\nname = "neyra-client"\nversion = "0.1.0"\n'));
    writeFileSync(join(tauri, 'Cargo.lock'), crlf('[[package]]\nname = "neyra-client"\nversion = "0.1.0"\n'));
    try {
      assert.equal(readVersions(dir)['Cargo.lock'], '0.1.0');
      assert.deepEqual(versionProblems(readVersions(dir)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('recognizes a direct run from the script path, not from file:// plus the raw text', () => {
    const script = join(root, 'scripts/check-versions.mjs');
    assert.equal(invokedDirectly(pathToFileURL(script).href, script), true);
    assert.equal(invokedDirectly(pathToFileURL(script).href, join(root, 'scripts/other.mjs')), false);
    const windowsArgv = 'D:\\a\\neyra\\client\\scripts\\check-versions.mjs';
    assert.notEqual(`file://${windowsArgv}`, pathToFileURL(windowsArgv).href);
  });
  it('keeps the beta channel and the release overlay wired', () => {
    const overlay = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.release.conf.json'), 'utf8'));
    assert.equal(overlay.bundle.createUpdaterArtifacts, true);
    const base = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(base.bundle.createUpdaterArtifacts, false);
  });
});

describe('overlay content security policy', () => {
  it('lets the VRM loader read embedded textures and nothing remote', () => {
    const csp = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
    assert.match(csp, /img-src [^;]*blob:/);
    assert.match(csp, /connect-src [^;]*blob:/);
    assert.doesNotMatch(csp, /https?:\/\/(?!ipc\.localhost)/);
    assert.ok(!csp.includes('unsafe-eval'));
  });
});

describe('signature version binding', () => {
  it('reads the signed version from the trusted comment', () => {
    assert.equal(signedVersion(fixture('payload.valid.sig')), '0.1.1');
    assert.equal(signedVersion(fixture('payload.version-0.1.0.sig')), '0.1.0');
  });
  it('reports unversioned and broken signatures as missing', () => {
    assert.equal(signedVersion(fixture('payload.unversioned.sig')), undefined);
    assert.equal(signedVersion(fixture('payload.garbage.sig')), undefined);
    assert.equal(signedVersion(fixture('payload.truncated.sig')), undefined);
  });
  it('rejects a signature made with a different key even when its version matches', () => {
    const testKey = readFileSync(join(root, 'src-tauri/updater-test/test.key.pub'), 'utf8');
    assert.equal(signatureKeyId(fixture('payload.valid.sig')), publicKeyId(testKey));
    assert.equal(signedVersion(fixture('payload.untrusted-key.sig')), '0.1.1');
    assert.notEqual(signatureKeyId(fixture('payload.untrusted-key.sig')), publicKeyId(testKey));
    assert.equal(signatureKeyId(fixture('payload.truncated.sig')), undefined);
  });
});
