import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactName,
  assertSimulatorRuntimeSupports,
  pickDispatchedRun,
} from './mobile-remote-native';

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

test('accepts an artifact on a simulator runtime at least as new as its SDK', () => {
  assertSimulatorRuntimeSupports(
    { xcodeBuildVersion: '17F113', simulatorSdkVersion: '26.5' },
    '26.5'
  );
  assertSimulatorRuntimeSupports(
    { xcodeBuildVersion: '17F113', simulatorSdkVersion: '26.5' },
    '27.1'
  );
  assertSimulatorRuntimeSupports({ simulatorSdkVersion: '26' }, '26.0.1');
});

test('rejects an artifact whose SDK is newer than the simulator runtime', () => {
  assert.throws(
    () => assertSimulatorRuntimeSupports({ simulatorSdkVersion: '27.1' }, '26.5'),
    /cannot run on simulator runtime 26.5/
  );
  assert.throws(
    () => assertSimulatorRuntimeSupports({ simulatorSdkVersion: '26.10' }, '26.9'),
    /cannot run/
  );
});

test('rejects an artifact with no readable simulator SDK', () => {
  for (const toolchain of [
    null,
    {},
    { simulatorSdkVersion: 26.5 },
    { simulatorSdkVersion: 'beta' },
  ]) {
    assert.throws(() => assertSimulatorRuntimeSupports(toolchain, '27.1'), /cannot run/);
  }
});
