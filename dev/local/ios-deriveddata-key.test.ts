import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDerivedDataKey, type DerivedDataDimensions } from './ios-deriveddata-key';

const dimensions: DerivedDataDimensions = {
  buildMode: 'release-simulator',
  hostArch: 'arm64',
  nativeHash: 'a'.repeat(64),
  simulatorSdkVersion: '26.0',
  workflowDigest: 'b'.repeat(64),
  xcodeBuildVersion: '17A324',
};

// A restored tree is only usable against the inputs that produced it, so every
// dimension of it keys the tree. Dropping one would serve objects compiled by
// another toolchain or another native project.
test('the Release derived-data key covers every build dimension', () => {
  const key = buildDerivedDataKey(dimensions);
  assert.equal(buildDerivedDataKey({ ...dimensions }), key, 'the same inputs key the same tree');
  const changes: [string, DerivedDataDimensions][] = [
    ['hostArch', { ...dimensions, hostArch: 'x64' }],
    ['nativeHash', { ...dimensions, nativeHash: 'c'.repeat(64) }],
    ['simulatorSdkVersion', { ...dimensions, simulatorSdkVersion: '26.1' }],
    ['workflowDigest', { ...dimensions, workflowDigest: 'd'.repeat(64) }],
    ['xcodeBuildVersion', { ...dimensions, xcodeBuildVersion: '17B100' }],
  ];
  for (const [name, changed] of changes) {
    assert.notEqual(buildDerivedDataKey(changed), key, `${name} must key the tree`);
  }
});
