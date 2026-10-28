import { getDeliveryBadge } from './delivery-badge';

describe('getDeliveryBadge', () => {
  it('returns null when there is no delivery state', () => {
    expect(getDeliveryBadge(undefined)).toBeNull();
  });

  it('returns a Sending spinner while the send request is pending', () => {
    expect(getDeliveryBadge(undefined, { sending: true })).toEqual({
      label: 'Sending',
      tone: 'info',
      spinner: true,
    });
  });

  it('prefers an authoritative delivery state over the request-pending cue', () => {
    expect(getDeliveryBadge({ status: 'queued' }, { sending: true })).toEqual({
      label: 'Queued',
      tone: 'info',
    });
    expect(
      getDeliveryBadge(
        { status: 'failed', error: 'flush failed', reason: 'exhausted' },
        { sending: true }
      )
    ).toEqual({ label: 'Failed to deliver', tone: 'error', title: 'flush failed' });
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
