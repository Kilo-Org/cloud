/* eslint-disable max-lines -- The owner's request-generation, delivery and already-owned recovery tests share one IAP-owner harness; splitting them would duplicate its mocks and mount scaffolding. */

import { createElement } from 'react';
import { type Purchase } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type StoreCreditProduct } from '@/lib/credits/store-products';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { act, TestRenderer } from '@/test/renderer';
import {
  type CreditNativeIapContextValue,
  CreditNativeIapOwner,
  useCreditNativeIap,
} from './credit-native-iap-owner';

const APPLE_PRODUCT_ID = 'credits.usd10.v1';
const APP_ACCOUNT_TOKEN = '550e8400-e29b-41d4-a716-446655440000';

const mockedIap = vi.hoisted(() => ({
  connected: false,
  fetchProducts: vi.fn(),
  finishTransaction: vi.fn(),
  getAvailablePurchases: vi.fn(),
  handlers: null as {
    onPurchaseError: (error: unknown) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  } | null,
  reconnect: vi.fn(),
  requestPurchase: vi.fn(),
  useIAP: vi.fn(),
}));

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' }));

const mockedQuery = vi.hoisted(() => ({
  completePurchase: vi.fn(),
  invalidateQueries: vi.fn(),
  serverProductsData: undefined as
    | { appAccountToken: string; products: { appleProductId: string; googleProductId: string }[] }
    | undefined,
}));

vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    BillingUnavailable: 'billing-unavailable',
    UserCancelled: 'user-cancelled',
  },
  fetchProducts: mockedIap.fetchProducts,
  // The owner reads unfinished purchases through the SDK's value-returning API,
  // not `useIAP().getAvailablePurchases`, which logs every failure to the dev
  // LogBox (see credit-native-iap-owner.tsx).
  getAvailablePurchases: mockedIap.getAvailablePurchases,
  useIAP: (handlers: {
    onPurchaseError: (error: unknown) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  }) => {
    mockedIap.useIAP(handlers);
    mockedIap.handlers = handlers;
    return {
      connected: mockedIap.connected,
      finishTransaction: mockedIap.finishTransaction,
      reconnect: mockedIap.reconnect,
      requestPurchase: mockedIap.requestPurchase,
    };
  },
}));

vi.mock('react-native', () => ({
  Platform: mockedPlatform,
}));

vi.mock('@/lib/iap/pending-store-purchases', () => ({
  fetchPendingStorePurchases: mockedIap.getAvailablePurchases,
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync: mockedQuery.completePurchase }),
  useQuery: () => ({ data: mockedQuery.serverProductsData }),
  useQueryClient: () => ({ invalidateQueries: mockedQuery.invalidateQueries }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    credits: {
      completeAppStorePurchase: { mutationOptions: () => ({}) },
      completePlayPurchase: { mutationOptions: () => ({}) },
      getMobileStoreProducts: { queryOptions: () => ({ queryKey: ['mobile-products'] }) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

type ProbeHandle = { value: CreditNativeIapContextValue | null };

function Probe({ handle }: { handle: ProbeHandle }) {
  handle.value = useCreditNativeIap();
  return null;
}

function ownerElement(handle: ProbeHandle) {
  return createElement(CreditNativeIapOwner, null, createElement(Probe, { handle }));
}

const creditPack: StoreCreditProduct = {
  backend: {
    amountUsd: 10,
    appleProductId: APPLE_PRODUCT_ID,
    googleProductId: 'credits_usd10',
  },
  storeProductId: APPLE_PRODUCT_ID,
  displayPrice: '$10.99',
};

const CREDIT_PACK_50 = 'credits.usd50.v1';

const creditPack50: StoreCreditProduct = {
  backend: {
    amountUsd: 50,
    appleProductId: CREDIT_PACK_50,
    googleProductId: 'credits_usd50',
  },
  storeProductId: CREDIT_PACK_50,
  displayPrice: '$54.99',
};

function createPurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: false,
    productId: APPLE_PRODUCT_ID,
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    transactionId: 'tx-1',
    ...overrides,
  };
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

type OwnerMount = { handle: ProbeHandle; renderer: TestRenderer.ReactTestRenderer };

async function mountOwner(): Promise<OwnerMount> {
  const handle: ProbeHandle = { value: null };
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(ownerElement(handle));
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('CreditNativeIapOwner did not mount');
  }
  mounted.push(renderer);
  return { handle, renderer };
}

async function flushPromises() {
  await act(async () => {
    await new Promise(resolve => {
      setImmediate(resolve);
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlatform.OS = 'ios';
  mockedIap.connected = false;
  mockedIap.finishTransaction.mockResolvedValue(undefined);
  mockedIap.getAvailablePurchases.mockResolvedValue([]);
  mockedIap.handlers = null;
  mockedIap.reconnect.mockResolvedValue(true);
  mockedIap.requestPurchase.mockResolvedValue(null);
  mockedQuery.completePurchase.mockResolvedValue({ alreadyProcessed: false });
  mockedQuery.invalidateQueries.mockResolvedValue(undefined);
  mockedQuery.serverProductsData = undefined;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('CreditNativeIapOwner', () => {
  it('is the single useIAP call site and renders its children with a purchase callback', async () => {
    const { handle } = await mountOwner();

    expect(mockedIap.useIAP).toHaveBeenCalledTimes(1);
    expect(handle.value).not.toBeNull();
    expect(typeof handle.value?.purchase).toBe('function');
    expect(typeof handle.value?.fetchStoreProducts).toBe('function');
    expect(typeof handle.value?.reconnectStore).toBe('function');
    expect(handle.value?.completingProductId).toBeNull();
    expect(handle.value?.errorMessageKey).toBeNull();
  });

  it('reports the completing product id while a purchase is in flight', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);

    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledWith({
      signedTransactionJws: 'signed-jws',
    });
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: APPLE_PRODUCT_ID }),
      isConsumable: true,
    });
    expect(handle.value?.completingProductId).toBeNull();
  });

  it('recovers an unfinished purchase once per transaction', async () => {
    mockedIap.getAvailablePurchases.mockResolvedValue([createPurchase()]);
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle, renderer } = await mountOwner();
    await flushPromises();

    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(mockedQuery.invalidateQueries).toHaveBeenCalled();

    // A second store lookup returning the same transaction must not complete it
    // again: the recovered transaction id is remembered.
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    await act(async () => {
      renderer.update(ownerElement(handle));
      await Promise.resolve();
    });
    await flushPromises();

    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(2);
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completingProductId).toBeNull();
  });

  it('a failed store lookup adds no second error affordance', async () => {
    mockedIap.connected = true;
    mockedIap.getAvailablePurchases.mockRejectedValue(
      new Error('Play Store service is not connected')
    );
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };

    const { handle } = await mountOwner();
    await flushPromises();

    // The screen's store-unavailable banner owns this state; the owner must not
    // add its own error key or attempt a completion.
    expect(handle.value?.errorMessageKey).toBeNull();
    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
  });

  it('a store error with no purchase in flight adds no purchase-failure affordance', async () => {
    const { handle } = await mountOwner();

    // The store emits a connection error on its own; the user started no
    // purchase. The store-unavailable banner reports it, so the owner must not
    // also claim a purchase failed.
    mockedIap.handlers?.onPurchaseError({
      code: 'billing-unavailable',
      message: 'Play Store service is not connected',
    });
    await flushPromises();

    expect(handle.value?.errorMessageKey).toBeNull();
  });

  it('completes a store transaction delivered outside a purchase request in-session', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();

    // The store re-delivers an unfinished transaction with no request in
    // flight. The recovery effect only runs when the store connects, so the
    // owner must complete it here instead of waiting for a remount.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledWith({
      signedTransactionJws: 'signed-jws',
    });
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: APPLE_PRODUCT_ID }),
      isConsumable: true,
    });
    expect(handle.value?.completingProductId).toBeNull();
    expect(handle.value?.completedPurchaseCount).toBe(1);
  });

  it('does not complete or announce a transaction the purchase request already completed', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();

    // The request's own transaction completes and announces once.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completedPurchaseCount).toBe(1);

    // `finishTransaction` failed and its error was swallowed, so the store
    // re-delivers the same transaction. The request already completed it, so
    // the re-delivery must not complete or announce it a second time.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completedPurchaseCount).toBe(1);
  });

  it('ignores a delivered transaction that is not a credit pack', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    await mountOwner();

    mockedIap.handlers?.onPurchaseSuccess(createPurchase({ productId: 'other.product' }));
    await flushPromises();

    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
  });

  it('a store error during a purchase reports the purchase failure', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();

    mockedIap.handlers?.onPurchaseError({
      code: 'billing-unavailable',
      message: 'Play Store service is not connected',
    });
    await flushPromises();

    expect(handle.value?.errorMessageKey).toBe('kiloPass.purchaseFailed');
    expect(handle.value?.completingProductId).toBeNull();
  });

  it('does not release the in-flight request when the store replays another product', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [
        { appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' },
        { appleProductId: CREDIT_PACK_50, googleProductId: 'credits_usd50' },
      ],
    };
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack50)).toBe(true);
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(CREDIT_PACK_50);

    // The store re-delivers an unfinished transaction for another product while
    // the $50 request is still in flight. Completing the replay must not release
    // the request the user is waiting on.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledWith({
      signedTransactionJws: 'signed-jws',
    });
    expect(handle.value?.completingProductId).toBe(CREDIT_PACK_50);

    // The request's own transaction still completes and releases it.
    mockedIap.handlers?.onPurchaseSuccess(
      createPurchase({
        productId: CREDIT_PACK_50,
        purchaseToken: 'jws-50',
        transactionId: 'tx-50',
      })
    );
    await flushPromises();

    expect(handle.value?.completingProductId).toBeNull();
    expect(handle.value?.completedPurchaseCount).toBe(2);
  });

  it('does not clear a newer request when a stale completion resolves', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [
        { appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' },
        { appleProductId: CREDIT_PACK_50, googleProductId: 'credits_usd50' },
      ],
    };
    const staleCompletion = Promise.withResolvers<{ alreadyProcessed: boolean }>();
    mockedQuery.completePurchase.mockReturnValueOnce(staleCompletion.promise);
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();

    // The $10 request's transaction arrives and its backend completion starts.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);

    // A store error releases that request while its completion is still in
    // flight, and the user starts a different pack.
    mockedIap.handlers?.onPurchaseError({
      code: 'billing-unavailable',
      message: 'Play Store service is not connected',
    });
    await flushPromises();
    expect(handle.value?.completingProductId).toBeNull();

    expect(await handle.value?.purchase(creditPack50)).toBe(true);
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(CREDIT_PACK_50);

    // The stale completion resolves: its finalizer owns the released request and
    // must not clear the newer one.
    staleCompletion.resolve({ alreadyProcessed: false });
    await flushPromises();

    expect(handle.value?.completingProductId).toBe(CREDIT_PACK_50);
  });

  it('recovers the outstanding purchase when the store reports it as already owned', async () => {
    mockedIap.getAvailablePurchases.mockResolvedValue([createPurchase()]);
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();

    mockedIap.handlers?.onPurchaseError({ code: 'already-owned', message: 'Item already owned' });
    await flushPromises();

    // "Already owned" is not proof of another account: the outstanding
    // consumable is completed, so no account-mismatch message is shown.
    expect(mockedQuery.completePurchase).toHaveBeenCalledWith({
      signedTransactionJws: 'signed-jws',
    });
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: APPLE_PRODUCT_ID }),
      isConsumable: true,
    });
    expect(handle.value?.errorMessageKey).toBeNull();
    expect(handle.value?.completedPurchaseCount).toBe(1);
  });

  it('shares one already-owned recovery between the error listener and the request rejection', async () => {
    // The store reports one `AlreadyOwned` failure through both channels: the
    // error listener fires and the purchase request rejects. Both call
    // `recoverOwnedCreditPurchase`, which must run one pass and give both the
    // same result — otherwise the rejection path sees the listener's deduped
    // `false` and shows the generic failure after the success was announced.
    mockedIap.getAvailablePurchases.mockResolvedValue([createPurchase()]);
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const alreadyOwned = { code: 'already-owned', message: 'Item already owned' };
    mockedIap.requestPurchase.mockRejectedValueOnce(alreadyOwned);
    const { handle } = await mountOwner();

    const purchaseResult = handle.value?.purchase(creditPack);
    mockedIap.handlers?.onPurchaseError(alreadyOwned);
    await flushPromises();

    expect(await purchaseResult).toBe(false);
    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completedPurchaseCount).toBe(1);
    expect(handle.value?.errorMessageKey).toBeNull();
  });

  it('shares one already-owned recovery when the request rejection starts it first', async () => {
    // The reverse order: the rejection starts the recovery, which is still
    // waiting on the store when the listener delivers the same failure. The
    // listener must join that in-flight pass instead of opening a second one.
    const pendingLookup = Promise.withResolvers<Purchase[]>();
    mockedIap.getAvailablePurchases.mockReturnValueOnce(pendingLookup.promise);
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const alreadyOwned = { code: 'already-owned', message: 'Item already owned' };
    mockedIap.requestPurchase.mockRejectedValueOnce(alreadyOwned);
    const { handle } = await mountOwner();

    const purchaseResult = handle.value?.purchase(creditPack);
    await flushPromises();
    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);

    mockedIap.handlers?.onPurchaseError(alreadyOwned);
    await flushPromises();

    pendingLookup.resolve([createPurchase()]);
    await flushPromises();

    expect(await purchaseResult).toBe(false);
    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completedPurchaseCount).toBe(1);
    expect(handle.value?.errorMessageKey).toBeNull();
  });

  it('keeps the backend ownership refusal when both triggers recover one already-owned failure', async () => {
    mockedIap.getAvailablePurchases.mockResolvedValue([createPurchase()]);
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    // The backend refuses the receipt as another account's. The recovery pass
    // reports that through `notifyErrors` and returns "handled", so the purchase
    // path must not overwrite the account copy with the generic failure.
    mockedQuery.completePurchase.mockRejectedValue({
      message: 'This purchase is already linked to another Kilo account.',
    });
    const alreadyOwned = { code: 'already-owned', message: 'Item already owned' };
    mockedIap.requestPurchase.mockRejectedValueOnce(alreadyOwned);
    const { handle } = await mountOwner();

    const purchaseResult = handle.value?.purchase(creditPack);
    mockedIap.handlers?.onPurchaseError(alreadyOwned);
    await flushPromises();

    expect(await purchaseResult).toBe(false);
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completedPurchaseCount).toBe(0);
    expect(handle.value?.errorMessageKey).toBe('credits.purchaseOwnedByAnotherAccount');
  });

  it('still reports the generic failure when the recovery finds no outstanding purchase', async () => {
    mockedIap.getAvailablePurchases.mockResolvedValue([]);
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedIap.requestPurchase.mockRejectedValueOnce({
      code: 'already-owned',
      message: 'Item already owned',
    });
    const { handle } = await mountOwner();

    // Nothing in the store queue to recover, so the store error still owes its
    // own failure copy.
    expect(await handle.value?.purchase(creditPack)).toBe(false);
    await flushPromises();
    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
    expect(handle.value?.errorMessageKey).toBe('kiloPass.purchaseFailed');
  });

  it('does not submit a recovery pass that outlived an account change', async () => {
    const pendingLookup = Promise.withResolvers<Purchase[]>();
    mockedIap.getAvailablePurchases.mockReturnValueOnce(pendingLookup.promise);
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();
    await flushPromises();
    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);

    // Sign-out (and the next sign-in) advance the auth epoch while the store is
    // still answering this pass.
    bumpAuthEpoch();
    pendingLookup.resolve([createPurchase()]);
    await flushPromises();

    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
    expect(handle.value?.completedPurchaseCount).toBe(0);
  });

  it('does not announce a completion that outlived an account change', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const backendGate = Promise.withResolvers<{ alreadyProcessed: boolean }>();
    mockedQuery.completePurchase.mockReturnValueOnce(backendGate.promise);
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();

    // The account changes while the backend answers the request's completion.
    bumpAuthEpoch();
    backendGate.resolve({ alreadyProcessed: false });
    await flushPromises();

    // The grant belongs to the old session: the new one is neither announced nor
    // refreshed, and the store transaction is still finished for this device.
    expect(handle.value?.completedPurchaseCount).toBe(0);
    expect(mockedQuery.invalidateQueries).not.toHaveBeenCalled();
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: APPLE_PRODUCT_ID }),
      isConsumable: true,
    });
    expect(handle.value?.completingProductId).toBeNull();
  });
});
