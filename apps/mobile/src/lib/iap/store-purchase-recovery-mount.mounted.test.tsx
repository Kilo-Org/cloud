import { type Purchase } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from '@/test/renderer';

import {
  completionsNamed,
  createPurchase,
  CREDIT_PRODUCT_ID,
  creditCatalog,
  flushPromises,
  KILO_PASS_PRODUCT_ID,
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
  mockedIap.initConnection.mockResolvedValue(undefined);
  mockedQuery.catalogs = {
    'credits.getMobileStoreProducts': creditCatalog,
    'kiloPass.getMobileStoreProducts': kiloPassCatalog,
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

describe('StorePurchaseRecoveryMount', () => {
  it('grants and finishes an unfinished credit pack the backend never recorded', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([createPurchase()]);

    await mountRecovery();
    await flushPromises();

    expect(completionsNamed('credits.completeAppStorePurchase')).toEqual([
      {
        procedure: 'credits.completeAppStorePurchase',
        input: { signedTransactionJws: 'signed-jws' },
      },
    ]);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: CREDIT_PRODUCT_ID }),
      isConsumable: true,
    });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalled();
  });

  it('grants and finishes an unfinished Kilo Pass subscription', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({ productId: KILO_PASS_PRODUCT_ID, transactionId: 'tx-pass' }),
    ]);

    await mountRecovery();
    await flushPromises();

    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(0);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: KILO_PASS_PRODUCT_ID }),
      isConsumable: false,
    });
  });

  it('recovers an expired paid Pass transaction and finishes it as non-consumable', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({
        productId: KILO_PASS_PRODUCT_ID,
        transactionId: 'tx-expired',
        expirationDateIOS: Date.now() - 60_000,
      }),
    ]);

    await mountRecovery();
    await flushPromises();

    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(0);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ transactionId: 'tx-expired' }),
      isConsumable: false,
    });
  });

  it('recovers an expired paid Pass transaction and a fresh credit pack independently', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({
        productId: KILO_PASS_PRODUCT_ID,
        transactionId: 'tx-expired',
        expirationDateIOS: Date.now() - 60_000,
      }),
      createPurchase({ transactionId: 'tx-credit' }),
    ]);

    await mountRecovery();
    await flushPromises();

    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(2);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ transactionId: 'tx-expired' }),
      isConsumable: false,
    });
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: CREDIT_PRODUCT_ID }),
      isConsumable: true,
    });
  });

  it('recovers a Pass purchase when its catalog loads after the credit catalog', async () => {
    const passPurchase = createPurchase({
      productId: KILO_PASS_PRODUCT_ID,
      transactionId: 'tx-pass',
    });
    delete mockedQuery.catalogs['kiloPass.getMobileStoreProducts'];
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([passPurchase]);

    const renderer = await mountRecovery();
    await flushPromises();
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(0);

    mockedQuery.catalogs['kiloPass.getMobileStoreProducts'] = kiloPassCatalog;
    await rerender(renderer);
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(2);
    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['credits'] });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['kilo-pass-state'],
    });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['kilo-pass-history'],
    });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['kilo-pass-presentation'],
    });

    await rerender(renderer);
    await flushPromises();
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(2);
    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
  });

  it('queues the newly loaded Pass catalog behind an in-flight recovery pass', async () => {
    const pendingLookup = Promise.withResolvers<Purchase[]>();
    const passPurchase = createPurchase({
      productId: KILO_PASS_PRODUCT_ID,
      transactionId: 'tx-pass',
    });
    delete mockedQuery.catalogs['kiloPass.getMobileStoreProducts'];
    mockedIap.getPendingTransactionsIOS
      .mockReturnValueOnce(pendingLookup.promise)
      .mockResolvedValue([passPurchase]);

    const renderer = await mountRecovery();
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);

    mockedQuery.catalogs['kiloPass.getMobileStoreProducts'] = kiloPassCatalog;
    await rerender(renderer);
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);

    act(() => {
      pendingLookup.resolve([createPurchase(), passPurchase]);
    });
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(2);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);
    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(2);
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['credits'] });
  });

  it('does not retry a queued catalog pass after sign-out', async () => {
    const pendingLookup = Promise.withResolvers<Purchase[]>();
    delete mockedQuery.catalogs['kiloPass.getMobileStoreProducts'];
    mockedIap.getPendingTransactionsIOS
      .mockReturnValueOnce(pendingLookup.promise)
      .mockResolvedValue([createPurchase({ productId: KILO_PASS_PRODUCT_ID })]);

    const renderer = await mountRecovery();
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);

    mockedQuery.catalogs['kiloPass.getMobileStoreProducts'] = kiloPassCatalog;
    await rerender(renderer);
    mockedAuth.token = null;
    await rerender(renderer);
    act(() => {
      pendingLookup.resolve([]);
    });
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(0);
  });

  it('drops a queued catalog pass after unmount', async () => {
    const pendingLookup = Promise.withResolvers<Purchase[]>();
    delete mockedQuery.catalogs['kiloPass.getMobileStoreProducts'];
    mockedIap.getPendingTransactionsIOS
      .mockReturnValueOnce(pendingLookup.promise)
      .mockResolvedValue([createPurchase({ productId: KILO_PASS_PRODUCT_ID })]);

    const renderer = await mountRecovery();
    mockedQuery.catalogs['kiloPass.getMobileStoreProducts'] = kiloPassCatalog;
    await rerender(renderer);
    act(() => {
      renderer.unmount();
    });
    act(() => {
      pendingLookup.resolve([]);
    });
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
    expect(completionsNamed('kiloPass.completeAppStorePurchase')).toHaveLength(0);
  });

  it('leaves a pending transaction no catalog sells untouched', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({ productId: 'some.other.product' }),
    ]);

    await mountRecovery();
    await flushPromises();

    expect(mockedQuery.completions).toHaveLength(0);
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
  });

  it('does not disturb the store while signed out', async () => {
    mockedAuth.token = null;

    await mountRecovery();
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).not.toHaveBeenCalled();
    expect(mockedQuery.completions).toHaveLength(0);
  });

  it('recovers again when the app returns to the foreground', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValueOnce([createPurchase()]);
    const renderer = await mountRecovery();
    await flushPromises();

    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(1);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);

    mockedLifecycle.isActive = false;
    await rerender(renderer);
    mockedLifecycle.isActive = true;
    await rerender(renderer);
    await flushPromises();

    // The background -> active edge runs one further pass, and the store now
    // answers with nothing left pending.
    expect(mockedIap.getPendingTransactionsIOS).toHaveBeenCalledTimes(2);
    expect(completionsNamed('credits.completeAppStorePurchase')).toHaveLength(1);
  });

  it('reports nothing on screen when the store cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedIap.getPendingTransactionsIOS.mockRejectedValue(new Error('store unreachable'));

    await mountRecovery();
    await flushPromises();

    expect(mockedQuery.completions).toHaveLength(0);
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    // The message is logged as text on purpose: a device log keeps the reason a
    // charge never credited, where a bare Error object stringifies to nothing.
    expect(warn).toHaveBeenCalledWith(
      '[iap-recovery] unfinished purchase pass failed',
      expect.stringContaining('store unreachable')
    );
  });
});
