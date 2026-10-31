import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { invokedDirectly, readVersions, versionProblems } from './check-versions.mjs';
import { signedVersion } from './check-updater-signature.mjs';

const root = join(import.meta.dirname, '..');
const fixture = (name) => readFileSync(join(root, 'src-tauri/updater-test/fixtures', name), 'utf8');

describe('version sync', () => {
  it('package, tauri config, Cargo.toml and Cargo.lock agree', () => {
    expect(versionProblems(readVersions(root))).toEqual([]);
  });
  it('reports a mismatch, a missing version and a bad tag', () => {
    const ok = { a: '0.1.0', b: '0.1.0' };
    expect(versionProblems({ a: '0.1.0', b: '0.1.1' }).length).toBe(1);
    expect(versionProblems({ a: '0.1.0', b: undefined }).length).toBeGreaterThan(0);
    expect(versionProblems({ a: 'v1' }).length).toBe(1);
    expect(versionProblems(ok, 'client-v0.1.0')).toEqual([]);
    expect(versionProblems(ok, 'client-v0.2.0').length).toBe(1);
    expect(versionProblems(ok, 'v0.1.0').length).toBe(1);
  });
  it('accepts beta pre-release versions', () => {
    expect(versionProblems({ a: '0.1.0-beta.1' }, 'client-v0.1.0-beta.1')).toEqual([]);
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
      expect(readVersions(dir)['Cargo.lock']).toBe('0.1.0');
      expect(versionProblems(readVersions(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('recognizes a direct run from the script path, not from file:// plus the raw text', () => {
    const script = join(root, 'scripts/check-versions.mjs');
    expect(invokedDirectly(pathToFileURL(script).href, script)).toBe(true);
    expect(invokedDirectly(pathToFileURL(script).href, join(root, 'scripts/other.mjs'))).toBe(false);
    const windowsArgv = 'D:\\a\\neyra\\client\\scripts\\check-versions.mjs';
    expect(`file://${windowsArgv}`).not.toBe(pathToFileURL(windowsArgv).href);
  });
  it('keeps the beta channel and the release overlay wired', () => {
    const overlay = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.release.conf.json'), 'utf8'));
    expect(overlay.bundle.createUpdaterArtifacts).toBe(true);
    const base = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    expect(base.bundle.createUpdaterArtifacts).toBe(false);
  });
});

describe('overlay content security policy', () => {
  it('lets the VRM loader read embedded textures and nothing remote', () => {
    const csp = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
    expect(csp).toMatch(/img-src [^;]*blob:/);
    expect(csp).toMatch(/connect-src [^;]*blob:/);
    expect(csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('signature version binding', () => {
  it('reads the signed version from the trusted comment', () => {
    expect(signedVersion(fixture('payload.valid.sig'))).toBe('0.1.1');
    expect(signedVersion(fixture('payload.version-0.1.0.sig'))).toBe('0.1.0');
  });
  it('reports unversioned and broken signatures as missing', () => {
    expect(signedVersion(fixture('payload.unversioned.sig'))).toBeUndefined();
    expect(signedVersion(fixture('payload.garbage.sig'))).toBeUndefined();
    expect(signedVersion(fixture('payload.truncated.sig'))).toBeUndefined();
  });
});
