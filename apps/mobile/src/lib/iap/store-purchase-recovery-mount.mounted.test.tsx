import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  completionsNamed,
  createPurchase,
  CREDIT_PRODUCT_ID,
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

  it('skips unrelated transactions and still grants the fresh credit pack', async () => {
    mockedIap.getPendingTransactionsIOS.mockResolvedValue([
      createPurchase({
        productId: 'some.other.product',
        transactionId: 'tx-expired',
        expirationDateIOS: Date.now() - 60_000,
      }),
      createPurchase({ transactionId: 'tx-credit' }),
    ]);

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
