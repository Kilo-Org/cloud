import { describe, expect, it, vi } from 'vitest';

import {
  MAX_ATTEMPTS,
  POLL_INTERVAL_MS,
  pollReadinessUntilReady,
} from './local-session-create-polling';

const SESSION_ID = 'sess-abc';

describe('pollReadinessUntilReady', () => {
  it('returns true on the first ready probe without sleeping', async () => {
    const pollReadiness = vi.fn().mockResolvedValue({ status: 'ready', organizationId: null });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await pollReadinessUntilReady({ sessionId: SESSION_ID, pollReadiness, sleep });
    expect(result).toBe(true);
    expect(pollReadiness).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns false after exhausting the bounded attempt count', async () => {
    const pollReadiness = vi.fn().mockResolvedValue({ status: 'pending' });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await pollReadinessUntilReady({
      sessionId: SESSION_ID,
      pollReadiness,
      sleep,
      maxAttempts: 3,
      intervalMs: 100,
    });
    expect(result).toBe(false);
    expect(pollReadiness).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('exposes a constant attempt count of 30 for the 15s budget at 500ms intervals', () => {
    expect(POLL_INTERVAL_MS).toBe(500);
    expect(MAX_ATTEMPTS).toBe(30);
  });

  it('returns true after one pending probe followed by a ready probe', async () => {
    const pollReadiness = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'ready', organizationId: null });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await pollReadinessUntilReady({
      sessionId: SESSION_ID,
      pollReadiness,
      sleep,
      maxAttempts: 5,
      intervalMs: 50,
    });
    expect(result).toBe(true);
    expect(pollReadiness).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
