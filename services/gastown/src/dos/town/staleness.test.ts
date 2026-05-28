import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_STALE_MS, heartbeatStale } from './staleness';

describe('heartbeatStale', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a fresh heartbeat as live', () => {
    vi.useFakeTimers();
    const now = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(now);

    expect(heartbeatStale(new Date(now.getTime() - 1_000).toISOString())).toBe(false);
  });

  it('treats a heartbeat past the threshold as stale', () => {
    vi.useFakeTimers();
    const now = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(now);

    expect(heartbeatStale(new Date(now.getTime() - HEARTBEAT_STALE_MS - 1).toISOString())).toBe(
      true
    );
  });

  it('treats a missing heartbeat as stale', () => {
    expect(heartbeatStale(null)).toBe(true);
  });
});
