import { describe, expect, it } from 'vitest';
import { environmentSnapshotName } from './environment-snapshot-name.js';

describe('environmentSnapshotName', () => {
  it('keeps names in UTC across date boundaries and distinguishes same-minute builds', () => {
    expect(environmentSnapshotName(Date.parse('2026-10-25T00:01:02+02:00'))).toBe(
      '24 Oct 2026, 22:01:02 UTC'
    );
    expect(environmentSnapshotName(Date.parse('2026-10-24T22:01:03Z'))).toBe(
      '24 Oct 2026, 22:01:03 UTC'
    );
  });
});
