import { getDeliveryBadge } from './delivery-badge';

describe('getDeliveryBadge', () => {
  it('returns null when there is no delivery state', () => {
    expect(getDeliveryBadge(undefined)).toBeNull();
  });

  it('returns a Queued badge for queued messages', () => {
    expect(getDeliveryBadge({ status: 'queued' })).toEqual({ label: 'Queued', tone: 'info' });
  });

  it('returns a Failed badge with error title for failed messages', () => {
    expect(
      getDeliveryBadge({
        status: 'failed',
        error: 'flush failed',
        reason: 'exhausted',
        attempts: 5,
      })
    ).toEqual({ label: 'Failed to deliver', tone: 'error', title: 'flush failed' });
  });

  it('returns a Failed badge for interrupted queued messages', () => {
    expect(
      getDeliveryBadge({
        status: 'failed',
        error: 'Pending queued message interrupted by user',
        reason: 'interrupted',
      })
    ).toEqual({
      label: 'Failed to deliver',
      tone: 'error',
      title: 'Pending queued message interrupted by user',
    });
  });
});
