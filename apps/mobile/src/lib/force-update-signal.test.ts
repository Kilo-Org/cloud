import { describe, expect, it, vi } from 'vitest';

import { reportTrpcError, subscribeToForceUpdateRecheck } from './force-update-signal';

function makeListener() {
  const listener = vi.fn<() => void>();
  const unsubscribe = subscribeToForceUpdateRecheck(listener);
  return { listener, unsubscribe };
}

describe('force-update-signal', () => {
  it('reportTrpcError notifies a recheck listener on app_update_required via data', () => {
    const { listener } = makeListener();
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reportTrpcError notifies via shape.data', () => {
    const { listener } = makeListener();
    reportTrpcError({ shape: { data: { upstreamCode: 'app_update_required' } } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reportTrpcError ignores other errors', () => {
    const { listener } = makeListener();
    reportTrpcError({ data: { upstreamCode: 'etag_mismatch' } });
    reportTrpcError({ data: { code: 'UNAUTHORIZED' } });
    reportTrpcError({ shape: { data: { code: 'FORBIDDEN' } } });
    reportTrpcError(new Error('network'));
    reportTrpcError(null);
    expect(listener).not.toHaveBeenCalled();
  });

  it('falls through to shape.data when data is not an object', () => {
    const { listener } = makeListener();
    reportTrpcError({ data: 'nope', shape: { data: { upstreamCode: 'app_update_required' } } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reads data before a malformed shape', () => {
    const { listener } = makeListener();
    reportTrpcError({ shape: null, data: { upstreamCode: 'app_update_required' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribeToForceUpdateRecheck notifies and unsubscribes', () => {
    const { listener, unsubscribe } = makeListener();

    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
