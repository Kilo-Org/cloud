import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchPendingStorePurchases } from './pending-store-purchases';

const mockedIap = vi.hoisted(() => ({
  getAvailablePurchases: vi.fn(),
  getPendingTransactionsIOS: vi.fn(),
}));

vi.mock('expo-iap', () => ({
  getAvailablePurchases: mockedIap.getAvailablePurchases,
  getPendingTransactionsIOS: mockedIap.getPendingTransactionsIOS,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchPendingStorePurchases', () => {
  it('reads the StoreKit payment queue for the App Store storefront', async () => {
    const queued = [{ id: 'unfinished-transaction' }];
    mockedIap.getPendingTransactionsIOS.mockResolvedValue(queued);

    await expect(fetchPendingStorePurchases('app_store')).resolves.toBe(queued);

    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
    // The entitlement query is not the queue: an unfinished consumable is absent
    // from it, which is why a charged purchase read as nothing to recover.
    expect(mockedIap.getAvailablePurchases).not.toHaveBeenCalled();
  });

  it('reads the Play query for the Play storefront', async () => {
    const pending = [{ id: 'play-pending-purchase' }];
    mockedIap.getAvailablePurchases.mockResolvedValue(pending);

    await expect(fetchPendingStorePurchases('play')).resolves.toBe(pending);

    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(mockedIap.getPendingTransactionsIOS).not.toHaveBeenCalled();
  });

  it('rejects when the store cannot answer, so the caller retries on a later pass', async () => {
    mockedIap.getPendingTransactionsIOS.mockRejectedValue(new Error('store unreachable'));

    await expect(fetchPendingStorePurchases('app_store')).rejects.toThrow('store unreachable');
  });
});
