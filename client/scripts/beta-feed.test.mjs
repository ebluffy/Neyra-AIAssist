import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, decide } from './beta-feed.mjs';

test('prerelease identifiers follow SemVer ordering', () => {
  assert.equal(compareVersions('0.2.0-beta.10', '0.2.0-beta.2'), 1);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0-beta.1.1'), -1);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0-beta.alpha'), -1);
});

test('stable wins over its prerelease, but not a newer version', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0-beta.10'), 1);
  assert.equal(compareVersions('0.1.9', '0.2.0-beta.1'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
});

test('core versions compare numerically without losing precision; build metadata is ignored', () => {
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.99'), 1);
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  assert.equal(compareVersions('0.2.0+build.2', '0.2.0+build.1'), 0);
});

test('initializes an absent feed and advances an older feed, including beta to stable', () => {
  assert.equal(decide('client-v0.2.0-beta.1', { version: '0.2.0-beta.1' }), 'update');
  assert.equal(decide('client-v0.2.0-beta.10', { version: '0.2.0-beta.10' }, { version: '0.2.0-beta.2' }), 'update');
  assert.equal(decide('client-v0.2.0', { version: '0.2.0' }, { version: '0.2.0-beta.10' }), 'update');
});

test('skips equal or newer feeds, including stable to beta and build-only changes', () => {
  const candidate = { version: '0.2.0-beta.2' };
  for (const version of ['0.2.0-beta.2', '0.2.0-beta.10', '0.2.0', '0.3.0-beta.1']) {
    assert.equal(decide('client-v0.2.0-beta.2', candidate, { version }), 'skip');
  }
  assert.equal(decide('client-v0.2.0+two', { version: '0.2.0+two' }, { version: '0.2.0+one' }), 'skip');
});

test('rejects a tag that does not match the candidate manifest', () => {
  assert.throws(() => decide('client-v0.2.1', { version: '0.2.0' }), /does not match/);
  assert.throws(() => decide('v0.2.0', { version: '0.2.0' }), /does not match/);
});

test('rejects malformed candidate and current versions, even when initializing a feed', () => {
  for (const version of [undefined, null, 2, ['0.2.0'], {}, '', 'v0.2.0', '0.2', '01.2.0', '0.2.0-beta.01', '0.2.0-beta..1', '0.2.0+build..1', '0.2.0\n']) {
    assert.throws(() => decide(`client-v${version}`, { version }), /Invalid release version/);
    assert.throws(() => decide('client-v0.2.0', { version: '0.2.0' }, { version }), /Invalid release version/);
  }
  assert.throws(() => decide('client-v0.2.0', null), /Invalid release version/);
  assert.throws(() => decide('client-v0.2.0', { version: '0.2.0' }, null), /Invalid release version/);
});
