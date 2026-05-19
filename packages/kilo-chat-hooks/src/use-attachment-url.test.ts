import { describe, expect, it } from 'vitest';

import { computeAttachmentUrlStaleMs } from './use-attachment-url';

describe('computeAttachmentUrlStaleMs', () => {
  it('returns the lifetime minus the refresh buffer in ms', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) + 3600;
    const stale = computeAttachmentUrlStaleMs(expiresAt, now);
    expect(stale).toBe(3_300_000);
  });

  it('returns 0 when the URL is already within the refresh buffer', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) + 60;
    expect(computeAttachmentUrlStaleMs(expiresAt, now)).toBe(0);
  });

  it('returns 0 when the URL is already expired', () => {
    const now = 1_000_000_000_000;
    const expiresAt = Math.floor(now / 1000) - 10;
    expect(computeAttachmentUrlStaleMs(expiresAt, now)).toBe(0);
  });
});
