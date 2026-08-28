import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactName, assertToolchainMatches, pickDispatchedRun } from './mobile-remote-native';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('ignores runs that already existed before the dispatch', () => {
  const before = new Set([10, 9]);
  const runs = [
    { databaseId: 10, headSha: HEAD },
    { databaseId: 9, headSha: HEAD },
  ];
  assert.equal(pickDispatchedRun(runs, before, HEAD), undefined);
});

test('takes the newest new run on this commit', () => {
  const before = new Set([9]);
  const runs = [
    { databaseId: 12, headSha: OTHER },
    { databaseId: 11, headSha: HEAD },
    { databaseId: 10, headSha: HEAD },
    { databaseId: 9, headSha: HEAD },
  ];
  assert.equal(pickDispatchedRun(runs, before, HEAD), 11);
});

test('artifact names stay hash-keyed per platform', () => {
  assert.equal(artifactName('ios', 'deadbeef'), 'mobile-native-ios-deadbeef');
  assert.equal(artifactName('android', 'deadbeef'), 'mobile-native-android-deadbeef');
});

const TOOLCHAIN = { xcodeBuildVersion: '17A324', simulatorSdkVersion: '26.0' };

test('accepts an artifact built by the same toolchain', () => {
  assertToolchainMatches({ ...TOOLCHAIN }, TOOLCHAIN);
});

test('rejects an artifact built by a different simulator SDK', () => {
  assert.throws(
    () => assertToolchainMatches({ ...TOOLCHAIN, simulatorSdkVersion: '18.4' }, TOOLCHAIN),
    /does not match local/
  );
});

test('rejects an artifact with no recorded toolchain', () => {
  assert.throws(() => assertToolchainMatches(null, TOOLCHAIN), /does not match local/);
});
