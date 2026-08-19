import { describe, expect, it, vi } from 'vitest';

import { type MessageDeliveryState } from '@kilocode/cloud-agent-sdk';
import { countInFlightMessages, retryMessageAndClear } from './session-detail-content-helpers';

describe('countInFlightMessages', () => {
  it('excludes a failed pending row from the in-flight count', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'queued' }],
      ['m2', { status: 'failed', error: 'nope', reason: 'exhausted' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(1);
  });

  it('returns zero when every pending row failed', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'failed', error: 'nope', reason: 'interrupted' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(0);
  });

  it('counts every queued row', () => {
    const pending = new Map<string, MessageDeliveryState>([
      ['m1', { status: 'queued' }],
      ['m2', { status: 'queued' }],
    ]);
    expect(countInFlightMessages(pending)).toBe(2);
  });
});

describe('retryMessageAndClear', () => {
  it('clears the failed row when the retry send succeeds', async () => {
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const clearFailed = vi.fn<() => void>();
    await retryMessageAndClear(send, clearFailed);
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailed).toHaveBeenCalledTimes(1);
  });

  it('does not clear the failed row when the retry send fails', async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Failed to send message'));
    const clearFailed = vi.fn<() => void>();
    await retryMessageAndClear(send, clearFailed);
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearFailed).not.toHaveBeenCalled();
  });
});
