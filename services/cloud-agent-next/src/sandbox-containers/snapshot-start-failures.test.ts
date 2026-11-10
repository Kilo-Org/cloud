import { describe, expect, it } from 'vitest';
import {
  classifySnapshotStartFailure,
  snapshotStartFailureIsPermanent,
} from './snapshot-start-failures.js';

describe('snapshot start failure classification', () => {
  it.each([
    ['snapshot expired', 'expired'],
    ['snapshot not found', 'missing'],
    ['no such snapshot', 'missing'],
    ['base image mismatch', 'image_mismatch'],
    ['snapshot provenance check failed', 'provenance'],
    ['checksum mismatch', 'provenance'],
    ['container stopped before the supervisor started', 'transient'],
    ['wrapper exec timed out', 'transient'],
  ] as const)('classifies %s as %s', (message, reason) => {
    expect(classifySnapshotStartFailure(new Error(message))).toBe(reason);
  });

  it('reads the error code from provider errors', () => {
    expect(
      classifySnapshotStartFailure(
        Object.assign(new Error('start failed'), { code: 'SNAPSHOT_EXPIRED' })
      )
    ).toBe('expired');
    expect(
      classifySnapshotStartFailure(
        Object.assign(new Error('start failed'), { code: 'SNAPSHOT_NOT_FOUND' })
      )
    ).toBe('missing');
  });

  it('treats only transient as retryable', () => {
    expect(snapshotStartFailureIsPermanent('transient')).toBe(false);
    expect(snapshotStartFailureIsPermanent('expired')).toBe(true);
    expect(snapshotStartFailureIsPermanent('missing')).toBe(true);
    expect(snapshotStartFailureIsPermanent('image_mismatch')).toBe(true);
    expect(snapshotStartFailureIsPermanent('provenance')).toBe(true);
    expect(snapshotStartFailureIsPermanent('unsupported')).toBe(true);
  });
});
