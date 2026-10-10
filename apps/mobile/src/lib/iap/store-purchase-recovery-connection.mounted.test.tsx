import { type Purchase } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';

import {
  completionsNamed,
  createPurchase,
  creditCatalog,
  flushPromises,
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
  mockedIap.initConnection.mockResolvedValue(undefined);
  mockedQuery.catalogs = {
    'credits.getMobileStoreProducts': creditCatalog,
  };
  mockedQuery.completions = [];
  mockedQuery.invalidateQueries.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('StorePurchaseRecoveryMount connection lifecycle', () => {
  it('gives up on a store call that never answers, and does not stay stuck', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const neverSettles = Promise.withResolvers();
    mockedIap.initConnection.mockReturnValue(neverSettles.promise);
    // Only the deadline is faked: the mount helpers await real microtasks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const renderer = await mountRecovery();
      await flushPromises();
      await vi.advanceTimersByTimeAsync(16_000);

      expect(warn).toHaveBeenCalledWith(
        '[iap-recovery] unfinished purchase pass failed',
        expect.stringContaining('did not answer')
      );
      expect(mockedQuery.completions).toHaveLength(0);

      // The in-flight guard must be released, or recovery is dead for the rest
      // of the process: the next foreground pass has to try again.
      mockedIap.initConnection.mockResolvedValue(undefined);
      mockedIap.getPendingTransactionsIOS.mockResolvedValue([createPurchase()]);
      mockedLifecycle.isActive = false;
      await rerender(renderer);
      mockedLifecycle.isActive = true;
      await rerender(renderer);
      await flushPromises();

      expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
      expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries when the pending store lookup never answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const neverSettles = Promise.withResolvers<Purchase[]>();
    mockedIap.getPendingTransactionsIOS.mockReturnValue(neverSettles.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const renderer = await mountRecovery();
      await flushPromises();
      await vi.advanceTimersByTimeAsync(16_000);

      expect(warn).toHaveBeenCalledWith(
        '[iap-recovery] unfinished purchase pass failed',
        expect.stringContaining('pending purchase lookup did not answer')
      );

      mockedIap.getPendingTransactionsIOS.mockResolvedValue([createPurchase()]);
      mockedLifecycle.isActive = false;
      await rerender(renderer);
      mockedLifecycle.isActive = true;
      await rerender(renderer);
      await flushPromises();

      expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(2);
      expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not submit a pass whose account changed while the store answered', async () => {
    const pendingLookup = Promise.withResolvers<Purchase[]>();
    mockedIap.getPendingTransactionsIOS.mockReturnValueOnce(pendingLookup.promise);

    const renderer = await mountRecovery();
    await flushPromises();
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);

    // Sign-out and the next sign-in advance the auth epoch while the store is
    // still answering. This pass belongs to the old session, so it must not
    // submit its completions under the new account.
    bumpAuthEpoch();
    pendingLookup.resolve([createPurchase()]);
    await flushPromises();

    expect(mockedQuery.completions).toHaveLength(0);
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    expect(renderer).toBeDefined();
  });

  it('recovers a Play purchase after a purchase screen closes the global connection', async () => {
    mockedPlatform.OS = 'android';
    let connected = false;
    mockedIap.initConnection.mockImplementation(async () => {
      await Promise.resolve();
      connected = true;
      return true;
    });
    const purchase = createPurchase({
      productId: 'credits_usd10',
      store: 'google',
      purchaseToken: 'play-token',
    });
    mockedIap.getAvailablePurchases.mockImplementation(async () => {
      await Promise.resolve();
      if (!connected) {
        throw new Error('NotPrepared');
      }
      return [];
    });
    const renderer = await mountRecovery();
    await flushPromises();

    // useIAP closes the shared native billing connection when its owner unmounts.
    connected = false;
    mockedIap.getAvailablePurchases.mockImplementation(async () => {
      await Promise.resolve();
      if (!connected) {
        throw new Error('NotPrepared');
      }
      return [purchase];
    });
    mockedLifecycle.isActive = false;
    await rerender(renderer);
    mockedLifecycle.isActive = true;
    await rerender(renderer);
    await flushPromises();

    expect(completionsNamed('credits.completePlayPurchase')).toEqual([
      {
        procedure: 'credits.completePlayPurchase',
        input: { productId: 'credits_usd10', purchaseToken: 'play-token' },
      },
    ]);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: true });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
  });
});
