import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@/test/renderer';
import {
  completionsNamed,
  createPurchase,
  creditCatalog,
  flushPromises,
  kiloPassCatalog,
  mockedAuth,
  mockedIap,
  mockedLifecycle,
  mockedPlatform,
  mockedQuery,
  mounted,
  mountRecovery,
  rerender,
} from './store-purchase-recovery-mount.test-helpers';

beforeEach(() => {
  vi.resetAllMocks();
  mockedPlatform.OS = 'ios';
  mockedAuth.token = 'session-token';
  mockedLifecycle.isActive = true;
  mockedIap.finishTransaction.mockResolvedValue(undefined);
  mockedIap.getPendingTransactionsIOS.mockResolvedValue([]);
  mockedIap.getAvailablePurchases.mockResolvedValue([]);
  mockedIap.initConnection.mockResolvedValue(true);
  mockedQuery.catalogs = {
    'credits.getMobileStoreProducts': creditCatalog,
    'kiloPass.getMobileStoreProducts': kiloPassCatalog,
  };
  mockedQuery.completions = [];
  mockedQuery.invalidateQueries.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount();
    }
  });
});

describe('forced sales-free build subscription recovery', () => {
  it.each(['ios', 'android'])(
    'recovers a retired %s subscription with an empty sale catalog',
    async platform => {
      mockedPlatform.OS = platform;
      mockedQuery.catalogs['kiloPass.getMobileStoreProducts'] = {
        appAccountToken: kiloPassCatalog.appAccountToken,
        products: [],
      };
      const purchase = createPurchase({
        productId: platform === 'ios' ? 'kilopass.tier49.monthly.v1' : 'kilopass_tier49',
        store: platform === 'ios' ? 'apple' : 'google',
        transactionId: 'legacy-charged-period',
      });
      const lookup =
        platform === 'ios' ? mockedIap.getPendingTransactionsIOS : mockedIap.getAvailablePurchases;
      lookup.mockResolvedValue([purchase]);
      await mountRecovery();
      await flushPromises();
      expect(
        completionsNamed(
          platform === 'ios' ? 'kiloPass.completeAppStorePurchase' : 'kiloPass.completePlayPurchase'
        )
      ).toHaveLength(1);
      expect(mockedIap.finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
      expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(0);
      expect(completionsNamed('credits.completePlayPurchase')).toHaveLength(0);
    }
  );

  it('recognizes charged legacy subscriptions even while the backend catalog is unavailable', async () => {
    delete mockedQuery.catalogs['kiloPass.getMobileStoreProducts'];
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({
        productId: 'kilopass.tier199.monthly.v1',
        transactionId: 'legacy-static-id',
      }),
    ]);
    await mountRecovery();
    await flushPromises();
    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending retired Play subscription queued until approval', async () => {
    mockedPlatform.OS = 'android';
    mockedQuery.catalogs['kiloPass.getMobileStoreProducts'] = {
      appAccountToken: kiloPassCatalog.appAccountToken,
      products: [],
    };
    const pending = createPurchase({
      productId: 'kilopass_tier19',
      store: 'google',
      purchaseState: 'pending',
    });
    mockedIap.getAvailablePurchases.mockResolvedValue([pending]);
    const renderer = await mountRecovery();
    await flushPromises();
    expect(completionsNamed('kiloPass.completePlayPurchase')).toHaveLength(0);
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    mockedIap.getAvailablePurchases.mockResolvedValue([{ ...pending, purchaseState: 'purchased' }]);
    mockedLifecycle.isActive = false;
    await rerender(renderer);
    mockedLifecycle.isActive = true;
    await rerender(renderer);
    await flushPromises();
    expect(completionsNamed('kiloPass.completePlayPurchase')).toHaveLength(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
  });
});
