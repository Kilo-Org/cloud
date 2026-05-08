import { describe, expect, it, vi } from 'vitest';

import {
  getDevStoreKitRefundAppleProductId,
  requestDevStoreKitRefund,
} from './dev-storekit-refund';

describe('getDevStoreKitRefundAppleProductId', () => {
  it('returns the App Store product id for active App Store subscriptions in dev', () => {
    expect(
      getDevStoreKitRefundAppleProductId({
        isDev: true,
        subscription: {
          cadence: 'monthly',
          paymentProvider: 'app_store',
          tier: 'tier_19',
        },
      })
    ).toBe('kilopass.tier19.monthly.v1');
  });

  it('is disabled outside dev and for non-App Store subscriptions', () => {
    expect(
      getDevStoreKitRefundAppleProductId({
        isDev: false,
        subscription: {
          cadence: 'monthly',
          paymentProvider: 'app_store',
          tier: 'tier_19',
        },
      })
    ).toBeNull();

    expect(
      getDevStoreKitRefundAppleProductId({
        isDev: true,
        subscription: {
          cadence: 'monthly',
          paymentProvider: 'stripe',
          tier: 'tier_19',
        },
      })
    ).toBeNull();
  });
});

describe('requestDevStoreKitRefund', () => {
  it('opens the StoreKit refund sheet and invalidates local state', async () => {
    const beginRefundRequest = vi.fn().mockResolvedValue('success');
    const invalidateAfterRefund = vi.fn();
    const showError = vi.fn();
    const showSuccess = vi.fn();

    await requestDevStoreKitRefund({
      appleProductId: 'kilopass.tier19.monthly.v1',
      beginRefundRequest,
      invalidateAfterRefund,
      showError: message => {
        showError(message);
      },
      showSuccess: message => {
        showSuccess(message);
      },
    });

    expect(beginRefundRequest).toHaveBeenCalledWith('kilopass.tier19.monthly.v1');
    expect(invalidateAfterRefund).toHaveBeenCalled();
    expect(showSuccess).toHaveBeenCalledWith('Refund request submitted.');
    expect(showError).not.toHaveBeenCalled();
  });

  it('surfaces StoreKit refund request failures', async () => {
    const beginRefundRequest = vi.fn().mockRejectedValue(new Error('Refund unavailable'));
    const invalidateAfterRefund = vi.fn();
    const showError = vi.fn();

    await requestDevStoreKitRefund({
      appleProductId: 'kilopass.tier19.monthly.v1',
      beginRefundRequest,
      invalidateAfterRefund,
      showError: message => {
        showError(message);
      },
      showSuccess: () => undefined,
    });

    expect(invalidateAfterRefund).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('Refund unavailable');
  });
});
