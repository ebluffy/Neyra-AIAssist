import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions } from './beta-feed.mjs';

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
