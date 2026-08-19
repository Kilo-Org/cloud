import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearForceUpdateSignal,
  getForceUpdateSignalSnapshot,
  markClientUpdateRequired,
  markClientUpToDate,
  reportTrpcError,
  subscribeToForceUpdateSignal,
} from './force-update-signal';

describe('force-update-signal', () => {
  beforeEach(() => {
    clearForceUpdateSignal();
    markClientUpdateRequired();
  });

  it('starts false', () => {
    expect(getForceUpdateSignalSnapshot()).toBe(false);
  });

  it('reportTrpcError flips on app_update_required via data', () => {
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(getForceUpdateSignalSnapshot()).toBe(true);
  });

  it('reportTrpcError flips on app_update_required via shape.data', () => {
    reportTrpcError({ shape: { data: { upstreamCode: 'app_update_required' } } });
    expect(getForceUpdateSignalSnapshot()).toBe(true);
  });

  it('reportTrpcError ignores other errors', () => {
    reportTrpcError({ data: { upstreamCode: 'etag_mismatch' } });
    reportTrpcError({ data: { code: 'UNAUTHORIZED' } });
    reportTrpcError({ shape: { data: { code: 'FORBIDDEN' } } });
    reportTrpcError(new Error('network'));
    reportTrpcError(null);
    expect(getForceUpdateSignalSnapshot()).toBe(false);
  });

  it('falls through to shape.data when data is not an object', () => {
    reportTrpcError({ data: 'nope', shape: { data: { upstreamCode: 'app_update_required' } } });
    expect(getForceUpdateSignalSnapshot()).toBe(true);
  });

  it('reads data before a malformed shape', () => {
    reportTrpcError({ shape: null, data: { upstreamCode: 'app_update_required' } });
    expect(getForceUpdateSignalSnapshot()).toBe(true);
  });

  it('subscribeToForceUpdateSignal notifies and unsubscribes', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeToForceUpdateSignal(listener);

    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(listener).toHaveBeenCalledTimes(1);

    // A second identical error is a no-op (already true).
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    clearForceUpdateSignal();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clearForceUpdateSignal resets', () => {
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(getForceUpdateSignalSnapshot()).toBe(true);

    clearForceUpdateSignal();
    expect(getForceUpdateSignalSnapshot()).toBe(false);
  });

  it('markClientUpToDate suppresses a subsequent reportTrpcError', () => {
    markClientUpToDate();
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(getForceUpdateSignalSnapshot()).toBe(false);
  });

  it('markClientUpdateRequired re-arms reportTrpcError', () => {
    markClientUpToDate();
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(getForceUpdateSignalSnapshot()).toBe(false);

    markClientUpdateRequired();
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(getForceUpdateSignalSnapshot()).toBe(true);
  });
});
