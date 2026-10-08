/* eslint-disable max-lines -- Covers legacy completion, account fences, receipt retries, and explicit restoration for both stores. */
import { type Purchase } from 'expo-iap';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppStoreKiloPassPurchaseActionsDeps,
  createAppStoreKiloPassPurchaseActions,
  getKiloPassPurchaseErrorMessage,
  isRecoverableKiloPassPurchase,
  resetTerminalPurchaseRejections,
} from './use-store-kilo-pass-purchase';

vi.mock('expo-iap', () => ({
  ErrorCode: {
    DeferredPayment: 'deferred-payment',
    Pending: 'pending',
    UserCancelled: 'user-cancelled',
  },
}));

const appleProductId = 'kilopass.tier19.monthly.v1';
const googleProductId = 'kilopass_tier19';

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: false,
    productId: appleProductId,
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    transactionId: 'transaction-1',
    ...overrides,
  };
}

function createActions(overrides: Partial<AppStoreKiloPassPurchaseActionsDeps> = {}) {
  const deps = {
    appAccountToken: 'account-a',
    getAvailablePurchases: vi.fn().mockResolvedValue([]),
    restorePurchases: vi.fn(),
    completeAppStorePurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
    completePlayPurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
    finishTransaction: vi.fn().mockResolvedValue(undefined),
    enabledAppleProductIds: [appleProductId],
    enabledGoogleProductIds: [googleProductId],
    invalidateAfterCompletion: vi.fn(),
    isAccountCurrent: () => true,
    showError: vi.fn<(message: string) => void>(),
    ...overrides,
  } satisfies AppStoreKiloPassPurchaseActionsDeps;
  return { deps, actions: createAppStoreKiloPassPurchaseActions(deps) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTerminalPurchaseRejections();
});

describe('retired Kilo Pass transaction completion', () => {
  it.each(['apple', 'google'] as const)(
    'submits verified %s receipts before finishing',
    async store => {
      const p = purchase({
        store,
        productId: store === 'apple' ? appleProductId : googleProductId,
      });
      const { deps, actions } = createActions();
      const backend = store === 'apple' ? deps.completeAppStorePurchase : deps.completePlayPurchase;
      await actions.recoverPurchases([p]);
      expect(backend).toHaveBeenCalledWith(
        store === 'apple'
          ? {
              signedTransactionJws: 'signed-jws',
              platform: 'ios',
              storefront: 'app_store',
              product: 'kilo_pass',
            }
          : {
              purchaseToken: 'signed-jws',
              platform: 'android',
              storefront: 'play',
              product: 'kilo_pass',
            }
      );
      expect(deps.finishTransaction).toHaveBeenCalledWith({ purchase: p, isConsumable: false });
      expect(vi.mocked(backend).mock.invocationCallOrder[0]).toBeLessThan(
        Number(vi.mocked(deps.finishTransaction).mock.invocationCallOrder[0])
      );
      expect(deps.invalidateAfterCompletion).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['apple', 'google'] as const)(
    'leaves failed %s completions unfinished and retries',
    async store => {
      const backend = vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValue({});
      const { deps, actions } = createActions(
        store === 'apple'
          ? { completeAppStorePurchase: backend }
          : { completePlayPurchase: backend }
      );
      const p = purchase({
        store,
        productId: store === 'apple' ? appleProductId : googleProductId,
      });
      expect(await actions.recoverPurchases([p])).toEqual([]);
      expect(deps.finishTransaction).not.toHaveBeenCalled();
      expect(deps.showError).not.toHaveBeenCalled();
      expect(await actions.recoverPurchases([p])).toEqual([p]);
      expect(backend).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['apple', 'google'] as const)(
    'skips pending %s receipts then coalesces approved deliveries',
    async store => {
      const gate = Promise.withResolvers();
      const backend = vi.fn().mockReturnValue(gate.promise);
      const { deps, actions } = createActions(
        store === 'apple'
          ? { completeAppStorePurchase: backend }
          : { completePlayPurchase: backend }
      );
      const pending = purchase({
        store,
        productId: store === 'apple' ? appleProductId : googleProductId,
        purchaseState: 'pending',
      });
      expect(await actions.recoverPurchases([pending])).toEqual([]);
      expect(backend).not.toHaveBeenCalled();
      expect(deps.finishTransaction).not.toHaveBeenCalled();
      const approved = { ...pending, purchaseState: 'purchased' as const };
      const first = actions.recoverPurchases([approved]);
      const second = actions.recoverPurchases([approved]);
      gate.resolve({});
      await Promise.all([first, second]);
      expect(backend).toHaveBeenCalledTimes(1);
      expect(deps.finishTransaction).toHaveBeenCalledTimes(1);
    }
  );

  it('matches historical IDs but not unrelated credit products', () => {
    expect(isRecoverableKiloPassPurchase(purchase(), [appleProductId], [])).toBe(true);
    expect(
      isRecoverableKiloPassPurchase(
        purchase({ productId: 'credits.usd10.v1' }),
        [appleProductId],
        []
      )
    ).toBe(false);
    expect(
      isRecoverableKiloPassPurchase(
        purchase({ store: 'google', productId: googleProductId }),
        [],
        [googleProductId]
      )
    ).toBe(true);
  });

  it('recovers already-paid Apple receipts after their subscription period expires', async () => {
    const { deps, actions } = createActions();
    const p = { ...purchase(), expirationDateIOS: Date.now() - 1 };
    expect(await actions.recoverPurchases([p])).toEqual([p]);
    expect(deps.completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(deps.finishTransaction).toHaveBeenCalledWith({ purchase: p, isConsumable: false });
  });

  it('retains Apple receipts without an expiry', async () => {
    const { actions } = createActions();
    const p = purchase();
    expect(await actions.recoverPurchases([p])).toEqual([p]);
  });

  it('invalidates once for distinct paid receipts without conflating their periods', async () => {
    const { deps, actions } = createActions();
    const first = purchase();
    const second = purchase({ transactionId: 'transaction-2' });
    expect(await actions.recoverPurchases([first, second])).toEqual([first, second]);
    expect(deps.completeAppStorePurchase).toHaveBeenCalledTimes(2);
    expect(deps.finishTransaction).toHaveBeenCalledTimes(2);
    expect(deps.invalidateAfterCompletion).toHaveBeenCalledTimes(1);
  });

  it.each(['apple', 'google'] as const)(
    'remembers only explicit terminal %s receipt defects',
    async store => {
      const message = `We could not verify this ${store === 'apple' ? 'App Store' : 'Google Play'} purchase. Please try again.`;
      const backend = vi.fn().mockRejectedValue({ data: { code: 'BAD_REQUEST', message } });
      const { deps, actions } = createActions(
        store === 'apple'
          ? { completeAppStorePurchase: backend }
          : { completePlayPurchase: backend }
      );
      const p = purchase({
        store,
        productId: store === 'apple' ? appleProductId : googleProductId,
      });
      await actions.recoverPurchases([p]);
      await actions.recoverPurchases([p]);
      expect(backend).toHaveBeenCalledTimes(1);
      expect(deps.finishTransaction).not.toHaveBeenCalled();
    }
  );

  it.each([
    { code: 'UNAUTHORIZED', message: 'Not signed in' },
    {
      code: 'BAD_REQUEST',
      message: 'App Store purchase account token does not match the signed-in user.',
    },
    {
      code: 'BAD_REQUEST',
      message: 'Google Play purchase account token does not match the signed-in user.',
    },
    { code: 'BAD_REQUEST', message: 'Account state refused' },
    { code: 'INTERNAL_SERVER_ERROR', message: 'insert into credit_transactions failed' },
  ])('retries account/session/database refusals: $message', async data => {
    const backend = vi.fn().mockRejectedValueOnce({ data }).mockResolvedValue({});
    const { actions } = createActions({ completeAppStorePurchase: backend });
    const p = purchase();
    await actions.recoverPurchases([p]);
    expect(await actions.recoverPurchases([p])).toEqual([p]);
    expect(backend).toHaveBeenCalledTimes(2);
  });

  it('does not submit receipts after signout', async () => {
    const { deps, actions } = createActions({ isAccountCurrent: () => false });
    await actions.recoverPurchases([purchase()]);
    expect(deps.completeAppStorePurchase).not.toHaveBeenCalled();
    expect(deps.finishTransaction).not.toHaveBeenCalled();
    expect(deps.invalidateAfterCompletion).not.toHaveBeenCalled();
  });

  it.each([true, false])('fences account changes during backend success=%s', async success => {
    let current = true;
    const gate = Promise.withResolvers();
    const { deps, actions } = createActions({
      completeAppStorePurchase: vi.fn().mockReturnValue(gate.promise),
      isAccountCurrent: () => current,
    });
    const recovery = actions.recoverPurchases([purchase()], { notifyErrors: true });
    current = false;
    if (success) {
      gate.resolve({});
    } else {
      gate.reject(new Error('old-account failure'));
    }
    expect(await recovery).toEqual([]);
    expect(deps.invalidateAfterCompletion).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.finishTransaction).toHaveBeenCalledTimes(success ? 1 : 0);
  });

  it('keeps unresolved completion registries scoped to the owning account', async () => {
    const gate = Promise.withResolvers();
    const accountA = createActions({
      completeAppStorePurchase: vi.fn().mockReturnValue(gate.promise),
    });
    const accountB = createActions({ appAccountToken: 'account-b' });
    const p = purchase();
    const first = accountA.actions.recoverPurchases([p]);
    await accountB.actions.recoverPurchases([p]);
    expect(accountB.deps.completeAppStorePurchase).toHaveBeenCalledTimes(1);
    gate.resolve({});
    await first;
  });

  it('coalesces automatic recovery and explicit restore for the same account', async () => {
    const gate = Promise.withResolvers();
    const backend = vi.fn().mockReturnValue(gate.promise);
    const p = purchase();
    const first = createActions({ completeAppStorePurchase: backend });
    const second = createActions({
      getAvailablePurchases: vi.fn().mockResolvedValue([p]),
      completeAppStorePurchase: backend,
    });
    const recovering = first.actions.recoverPurchases([p]);
    const restoring = second.actions.restorePurchases();
    await vi.waitFor(() => {
      expect(second.deps.getAvailablePurchases).toHaveBeenCalled();
    });
    gate.resolve({});
    await Promise.all([recovering, restoring]);
    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('retries store finish failures after idempotent backend completion', async () => {
    const finish = vi
      .fn()
      .mockRejectedValueOnce(new Error('store disconnected'))
      .mockResolvedValue(undefined);
    const { deps, actions } = createActions({ finishTransaction: finish });
    const p = purchase();
    expect(await actions.recoverPurchases([p])).toEqual([]);
    expect(await actions.recoverPurchases([p])).toEqual([p]);
    expect(deps.completeAppStorePurchase).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(2);
  });

  it('never waits for UI invalidation before acknowledging a verified Play receipt', async () => {
    const gate = Promise.withResolvers();
    const invalidate = vi.fn().mockReturnValue(gate.promise);
    const { deps, actions } = createActions({ invalidateAfterCompletion: invalidate });
    const p = purchase({ store: 'google', productId: googleProductId });
    const restoring = actions.recoverPurchases([p]);
    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
    expect(deps.finishTransaction).toHaveBeenCalledWith({ purchase: p, isConsumable: false });
    gate.resolve(undefined);
    await restoring;
  });

  it('reports missing receipt tokens without finishing', async () => {
    const { deps, actions } = createActions();
    await actions.recoverPurchases([purchase({ purchaseToken: null })], { notifyErrors: true });
    expect(deps.showError).toHaveBeenCalled();
    expect(deps.finishTransaction).not.toHaveBeenCalled();
  });
});

describe('explicit subscription restoration', () => {
  it.each(['apple', 'google'] as const)('restores charged historical %s purchases', async store => {
    const p = purchase({ store, productId: store === 'apple' ? appleProductId : googleProductId });
    const { deps, actions } = createActions({
      getAvailablePurchases: vi.fn().mockResolvedValue([p]),
    });
    expect(await actions.restorePurchases()).toBe('restored');
    expect(deps.restorePurchases).toHaveBeenCalledTimes(1);
    expect(deps.finishTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns empty for no eligible transactions', async () => {
    const { actions } = createActions();
    expect(await actions.restorePurchases()).toBe('empty');
  });

  it('does not report a wrong-account refusal as empty', async () => {
    const p = purchase();
    const { deps, actions } = createActions({
      getAvailablePurchases: vi.fn().mockResolvedValue([p]),
      completeAppStorePurchase: vi
        .fn()
        .mockRejectedValue(
          new Error('App Store purchase account token does not match the signed-in user.')
        ),
    });
    expect(await actions.restorePurchases()).toBe('failed');
    expect(deps.showError).toHaveBeenCalled();
    expect(deps.finishTransaction).not.toHaveBeenCalled();
  });

  it('explicit restore resurfaces remembered terminal rejections', async () => {
    const p = purchase();
    const backend = vi.fn().mockRejectedValue({
      data: {
        code: 'BAD_REQUEST',
        message: 'We could not verify this App Store purchase. Please try again.',
      },
    });
    const { deps, actions } = createActions({
      getAvailablePurchases: vi.fn().mockResolvedValue([p]),
      completeAppStorePurchase: backend,
    });
    await actions.recoverPurchases([p]);
    expect(await actions.restorePurchases()).toBe('failed');
    expect(backend).toHaveBeenCalledTimes(2);
    expect(deps.showError).toHaveBeenCalledTimes(1);
  });

  it('surfaces a shared automatic completion refusal to an explicit restore', async () => {
    const gate = Promise.withResolvers();
    const p = purchase();
    const { deps, actions } = createActions({
      getAvailablePurchases: vi.fn().mockResolvedValue([p]),
      completeAppStorePurchase: vi.fn().mockReturnValue(gate.promise),
    });
    const background = actions.recoverPurchases([p]);
    const explicit = actions.restorePurchases();
    await vi.waitFor(() => {
      expect(deps.getAvailablePurchases).toHaveBeenCalled();
    });
    gate.reject(new Error('App Store purchase account token does not match the signed-in user.'));
    await background;
    expect(await explicit).toBe('failed');
    expect(deps.showError).toHaveBeenCalledTimes(1);
  });

  it('reports retryable restore errors', async () => {
    const { deps, actions } = createActions({
      restorePurchases: vi.fn().mockRejectedValue(new Error('offline')),
    });
    expect(await actions.restorePurchases()).toBe('failed');
    expect(deps.showError).toHaveBeenCalledWith('Failed to restore purchases. Try again.');
  });

  it.each(['pending', 'deferred-payment'])(
    'does not label store %s approval delays as defects',
    code => {
      expect(getKiloPassPurchaseErrorMessage({ code }, 'fallback')).toBe(null);
    }
  );
});
