/* eslint-disable max-lines -- The owner's request-generation, delivery and already-owned recovery tests share one IAP-owner harness; splitting them would duplicate its mocks and mount scaffolding. */

import { createElement } from 'react';
import { type Purchase, type RequestPurchaseProps } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadStoreCreditProducts,
  StoreCreditProductsError,
} from '@/lib/credits/store-products-loader';
import { type StoreCreditProduct } from '@/lib/credits/store-products';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { resetCreditPurchaseIntentForTests } from '@/lib/credits/credit-purchase-intent';
import { resetCreditPurchaseAuthorityForTests } from '@/lib/credits/credit-purchase-authority';
import {
  resetInlinePurchaseErrorOwnership,
  resetPurchaseErrorToastDedup,
  resetTerminalPurchaseRejections,
} from '@/lib/credits/use-store-credit-purchase';
import { act, TestRenderer } from '@/test/renderer';
import {
  type CreditNativeIapContextValue,
  CreditNativeIapOwner,
  useCreditNativeIap,
} from './credit-native-iap-owner';

const APPLE_PRODUCT_ID = 'credits.usd10.v1';
const APP_ACCOUNT_TOKEN = '550e8400-e29b-41d4-a716-446655440000';
const nativeRequestCounts = new Map<string, number>();

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
    | {
        appAccountToken: string;
        products: { appleProductId: string; googleProductId: string }[];
        recoveryGoogleProductIds?: string[];
      }
    | undefined,
}));
const mockedToasts = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock('expo-crypto', () => {
  let sequence = 0;
  return {
    randomUUID: () => {
      sequence += 1;
      return `purchase-intent-${String(sequence)}`;
    },
  };
});

vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    BillingUnavailable: 'billing-unavailable',
    DeferredPayment: 'deferred-payment',
    NotPrepared: 'not-prepared',
    Pending: 'pending',
    UserCancelled: 'user-cancelled',
  },
  fetchProducts: mockedIap.fetchProducts,
  // The owner reads unfinished purchases through the SDK's value-returning API,
  // not `useIAP().getAvailablePurchases`, which logs every failure to the dev
  // LogBox (see credit-native-iap-owner.tsx).
  getAvailablePurchases: mockedIap.getAvailablePurchases,
  useIAP: (handlers: {
    onPurchaseError?: (error: unknown) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  }) => {
    mockedIap.useIAP(handlers);
    mockedIap.handlers = { onPurchaseError: vi.fn<(error: unknown) => void>(), ...handlers };
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

vi.mock('sonner-native', () => ({ toast: mockedToasts }));

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
    appAccountToken: APP_ACCOUNT_TOKEN,
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    storeId: 'apple',
    transactionDate: Date.now(),
    transactionId: 'tx-1',
    ...overrides,
  };
}

async function pendingRequestedPurchase(args: RequestPurchaseProps): Promise<Purchase> {
  const productId = args.request.apple?.sku ?? args.request.google?.skus[0];
  if (!productId) {
    throw new Error('the fake native request has no product');
  }
  const count = (nativeRequestCounts.get(productId) ?? 0) + 1;
  nativeRequestCounts.set(productId, count);
  const baseId = productId === CREDIT_PACK_50 ? 'tx-50' : 'tx-1';
  await Promise.resolve();
  return createPurchase({
    productId,
    transactionId: count === 1 ? baseId : `${baseId}-${String(count)}`,
    purchaseState: 'pending',
  });
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
  mockedIap.requestPurchase.mockReset();
  mockedIap.getAvailablePurchases.mockReset();
  mockedQuery.completePurchase.mockReset();
  resetCreditPurchaseIntentForTests();
  resetCreditPurchaseAuthorityForTests();
  resetInlinePurchaseErrorOwnership();
  resetPurchaseErrorToastDedup();
  resetTerminalPurchaseRejections();
  nativeRequestCounts.clear();
  mockedPlatform.OS = 'ios';
  mockedIap.connected = false;
  mockedIap.finishTransaction.mockResolvedValue(undefined);
  mockedIap.getAvailablePurchases.mockResolvedValue([]);
  mockedIap.handlers = null;
  mockedIap.reconnect.mockResolvedValue(true);
  mockedIap.requestPurchase.mockImplementation(pendingRequestedPurchase);
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
  it('bounds reconciliation through a hung finish and keeps its late completion off a successor', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const transaction = createPurchase({ transactionId: 'reconciliation-hung-finish' });
    mockedIap.requestPurchase.mockResolvedValueOnce({ ...transaction, purchaseState: 'pending' });
    const first = await mountOwner();
    await first.handle.value?.purchase(creditPack);
    await act(async () => {
      first.renderer.unmount();
      await Promise.resolve();
    });
    const finish = Promise.withResolvers<undefined>();
    mockedIap.finishTransaction.mockReturnValueOnce(finish.promise);
    mockedIap.getAvailablePurchases.mockResolvedValue([transaction]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reopened = await mountOwner();
    const reconciliation = reopened.handle.value?.purchase(creditPack);
    try {
      await flushPromises();
      expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(16_000);
      await flushPromises();
      expect(reopened.handle.value?.completingProductId).toBeNull();
      expect(reopened.handle.value?.buyAgainProductId).toBe(APPLE_PRODUCT_ID);
      mockedIap.requestPurchase.mockResolvedValueOnce(
        createPurchase({ purchaseState: 'pending', transactionId: 'after-reconciliation-deadline' })
      );
      await reopened.handle.value?.buyAgain(creditPack);
      finish.resolve(undefined);
      await flushPromises();
      expect(reopened.handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
    } finally {
      finish.resolve(undefined);
      await flushPromises();
      await reconciliation;
      vi.useRealTimers();
    }
  });

  it('does not settle a successor reconciliation when the earlier finish finally completes', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const transaction = createPurchase({ transactionId: 'reconciliation-successor-query' });
    mockedIap.requestPurchase.mockResolvedValueOnce({ ...transaction, purchaseState: 'pending' });
    const first = await mountOwner();
    await first.handle.value?.purchase(creditPack);
    await act(async () => {
      first.renderer.unmount();
      await Promise.resolve();
    });
    const finish = Promise.withResolvers<undefined>();
    const secondLookup = Promise.withResolvers<Purchase[]>();
    mockedIap.finishTransaction.mockReturnValueOnce(finish.promise);
    mockedIap.getAvailablePurchases.mockResolvedValue([transaction]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reopened = await mountOwner();
    const initial = reopened.handle.value?.purchase(creditPack);
    const successor: { promise?: Promise<boolean> } = {};
    try {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(16_000);
      await flushPromises();
      expect(reopened.handle.value?.completingProductId).toBeNull();
      await initial;
      mockedIap.getAvailablePurchases.mockReturnValueOnce(secondLookup.promise);
      successor.promise = reopened.handle.value?.purchase(creditPack);
      await flushPromises();
      expect(reopened.handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
      finish.resolve(undefined);
      await flushPromises();
      expect(reopened.handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
      secondLookup.resolve([]);
      await successor.promise;
      await flushPromises();
      expect(reopened.handle.value?.completingProductId).toBeNull();
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve(undefined);
      secondLookup.resolve([]);
      await flushPromises();
      await initial;
      await successor.promise;
      vi.useRealTimers();
    }
  });

  it('offers consent for a terminally refused transaction that stays in the store queue', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const transaction = createPurchase({ transactionId: 'queued-refunded-receipt' });
    mockedIap.requestPurchase.mockResolvedValueOnce({ ...transaction, purchaseState: 'pending' });
    const first = await mountOwner();
    await first.handle.value?.purchase(creditPack);
    await act(async () => {
      first.renderer.unmount();
      await Promise.resolve();
    });
    mockedQuery.completePurchase.mockRejectedValue({
      data: {
        code: 'BAD_REQUEST',
        message: 'This store purchase has been refunded, so Kilo cannot credit it.',
      },
    });
    mockedIap.getAvailablePurchases.mockResolvedValue([transaction]);
    const reopened = await mountOwner();
    await reopened.handle.value?.purchase(creditPack);
    expect(reopened.handle.value?.completingProductId).toBeNull();
    expect(reopened.handle.value?.buyAgainProductId).toBe(APPLE_PRODUCT_ID);
    expect(reopened.handle.value?.purchaseResolution).toBe('terminal-refusal');
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
  });

  it('does not publish a completion refusal after same-account unmount', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const backend = Promise.withResolvers<{ alreadyProcessed: boolean }>();
    mockedQuery.completePurchase.mockReturnValueOnce(backend.promise);
    const owner = await mountOwner();
    await owner.handle.value?.purchase(creditPack);
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    await act(async () => {
      owner.renderer.unmount();
      await Promise.resolve();
    });
    backend.reject(new Error('the receipt could not be completed'));
    await flushPromises();
    expect(mockedToasts.error).not.toHaveBeenCalled();
  });

  it('requires explicit Buy again consent after an empty iOS reconciliation', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const first = await mountOwner();
    await first.handle.value?.purchase(creditPack);
    await act(async () => {
      first.renderer.unmount();
      await Promise.resolve();
    });
    const reopened = await mountOwner();
    await reopened.handle.value?.purchase(creditPack);
    expect(reopened.handle.value?.buyAgainProductId).toBe(APPLE_PRODUCT_ID);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
    const consented = reopened.handle.value?.buyAgain(creditPack);
    expect(await reopened.handle.value?.buyAgain(creditPack)).toBe(false);
    await consented;
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
  });

  it('never starts a charge from reconciliation after the retained intent disappeared', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();
    await handle.value?.reconcilePurchase();
    expect(mockedIap.requestPurchase).not.toHaveBeenCalled();
    expect(handle.value?.hasUnresolvedPurchase).toBe(false);
  });

  it('does not start a consented purchase if the auth epoch changes during retirement', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const first = await mountOwner();
    await first.handle.value?.purchase(creditPack);
    await act(async () => {
      first.renderer.unmount();
      await Promise.resolve();
    });
    const reopened = await mountOwner();
    await reopened.handle.value?.reconcilePurchase();
    const consented = reopened.handle.value?.buyAgain(creditPack);
    bumpAuthEpoch();
    expect(await consented).toBe(false);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
  });

  it('credits a late old delivery once without settling the new consented request', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const first = await mountOwner();
    await first.handle.value?.purchase(creditPack);
    await act(async () => {
      first.renderer.unmount();
      await Promise.resolve();
    });
    const reopened = await mountOwner();
    await reopened.handle.value?.purchase(creditPack);
    await reopened.handle.value?.buyAgain(creditPack);
    mockedIap.handlers?.onPurchaseSuccess(createPurchase({ transactionDate: Date.now() + 1000 }));
    await flushPromises();
    mockedIap.handlers?.onPurchaseSuccess(createPurchase({ transactionDate: Date.now() + 1000 }));
    await flushPromises();
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(reopened.handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
    expect(reopened.handle.value?.completedPurchaseCount).toBe(1);
  });

  it('does not auto-release a dispatched Play intent after empty reconciliation', async () => {
    mockedPlatform.OS = 'android';
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const first = await mountOwner();
    await first.handle.value?.purchase(creditPack);
    await act(async () => {
      first.renderer.unmount();
      await Promise.resolve();
    });
    const reopened = await mountOwner();
    await reopened.handle.value?.purchase(creditPack);
    await reopened.handle.value?.purchase(creditPack);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
    expect(reopened.handle.value?.buyAgainProductId).toBe(APPLE_PRODUCT_ID);
  });

  it('allows another purchase after the captured native call throws before dispatch', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedIap.requestPurchase.mockImplementationOnce(() => {
      throw new Error('native dispatch rejected');
    });
    const { handle } = await mountOwner();
    expect(await handle.value?.purchase(creditPack)).toBe(false);
    expect(await handle.value?.purchase(creditPack)).toBe(true);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
  });

  it('retains an unresolved charge across empty reconciliation and route remount', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const native = Promise.withResolvers<null>();
    mockedIap.requestPurchase.mockReturnValueOnce(native.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = await mountOwner();
      const result = first.handle.value?.purchase(creditPack);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await result).toBe(false);
      await first.handle.value?.purchase(creditPack);
      await first.handle.value?.purchase(creditPack);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
      await act(async () => {
        first.renderer.unmount();
        await Promise.resolve();
      });
      const second = await mountOwner();
      await second.handle.value?.purchase(creditPack50);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds the native returned transaction to the captured request', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedIap.requestPurchase.mockResolvedValueOnce(
      createPurchase({ appAccountToken: null, transactionDate: 1 })
    );
    const { handle } = await mountOwner();
    await handle.value?.purchase(creditPack);
    await flushPromises();
    expect(handle.value?.completedPurchaseCount).toBe(1);
    await handle.value?.purchase(creditPack);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
  });

  it('keeps an identified but uncompleted transaction admitted through empty retries', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedQuery.completePurchase.mockRejectedValue(new Error('receipt transport dropped'));
    const { handle } = await mountOwner();
    await handle.value?.purchase(creditPack);
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();
    expect(handle.value?.completingProductId).toBeNull();
    expect(handle.value?.errorMessageKey).toBe('kiloPass.purchaseFailed');
    await handle.value?.purchase(creditPack);
    await handle.value?.purchase(creditPack);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
  });

  it('does not let uncorrelated old same-product delivery or error settle a request', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();
    await handle.value?.purchase(creditPack);
    mockedIap.handlers?.onPurchaseSuccess(
      createPurchase({
        transactionId: 'old-unrelated-transaction',
        transactionDate: Date.now() + 1000,
      })
    );
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
    mockedIap.handlers?.onPurchaseError({ code: 'user-cancelled', productId: APPLE_PRODUCT_ID });
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
  });

  it('leaves a newer different-product request pending after an old listener error', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [
        { appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' },
        { appleProductId: CREDIT_PACK_50, googleProductId: 'credits_usd50' },
      ],
    };
    const { handle } = await mountOwner();
    await handle.value?.purchase(creditPack);
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();
    await handle.value?.purchase(creditPack50);
    mockedIap.handlers?.onPurchaseError({
      code: 'user-cancelled',
      productId: APPLE_PRODUCT_ID,
    });
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(CREDIT_PACK_50);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
  });

  it('admits reconciliation visibly and renders its timeout failure inline', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedIap.requestPurchase.mockReturnValueOnce(Promise.withResolvers<null>().promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { handle } = await mountOwner();
      const initial = handle.value?.purchase(creditPack);
      await vi.advanceTimersByTimeAsync(16_000);
      await initial;
      mockedIap.getAvailablePurchases.mockReturnValue(Promise.withResolvers<Purchase[]>().promise);
      handle.value?.clearError();
      const retry = handle.value?.purchase(creditPack);
      await flushPromises();
      expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
      await handle.value?.purchase(creditPack);
      expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(16_000);
      await retry;
      await flushPromises();
      expect(handle.value?.errorMessageKey).toBe('credits.storeTimedOut');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a dispatched request whose native outcome never arrives', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { handle } = await mountOwner();
      expect(await handle.value?.purchase(creditPack)).toBe(true);
      await vi.advanceTimersByTimeAsync(16_000);
      await flushPromises();
      expect(handle.value?.completingProductId).toBeNull();
      // The sheet can still be open, so the row waits instead of failing.
      expect(handle.value?.errorMessageKey).toBeNull();
      expect(handle.value?.purchaseWait).toEqual({
        productId: APPLE_PRODUCT_ID,
        kind: 'store',
      });
      await handle.value?.purchase(creditPack);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a sheet that outlives the deadline, then credits it once', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const native = Promise.withResolvers<Purchase | null>();
    mockedIap.requestPurchase.mockReturnValueOnce(native.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { handle } = await mountOwner();
      const initial = handle.value?.purchase(creditPack);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await initial).toBe(false);
      await flushPromises();

      // The sheet may still be open: the screen says so and nothing failed.
      expect(handle.value?.completingProductId).toBeNull();
      expect(handle.value?.purchaseWait).toEqual({
        productId: APPLE_PRODUCT_ID,
        kind: 'store',
      });
      expect(handle.value?.errorMessageKey).toBeNull();

      native.resolve(createPurchase());
      await flushPromises();
      expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
      expect(handle.value?.completedPurchaseCount).toBe(1);
      expect(handle.value?.completingProductId).toBeNull();
      expect(handle.value?.purchaseWait).toBeNull();
      expect(handle.value?.errorMessageKey).toBeNull();
    } finally {
      native.resolve(null);
      await flushPromises();
      vi.useRealTimers();
    }
  });

  it('releases a request the store cancels after the deadline without leaving an error', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const native = Promise.withResolvers<Purchase | null>();
    mockedIap.requestPurchase.mockReturnValueOnce(native.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { handle } = await mountOwner();
      const initial = handle.value?.purchase(creditPack);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await initial).toBe(false);
      await flushPromises();
      expect(handle.value?.purchaseWait).toEqual({
        productId: APPLE_PRODUCT_ID,
        kind: 'store',
      });

      native.reject({ code: 'user-cancelled', message: 'the sheet was cancelled late' });
      await flushPromises();
      expect(handle.value?.completingProductId).toBeNull();
      expect(handle.value?.purchaseWait).toBeNull();
      expect(handle.value?.errorMessageKey).toBeNull();
      expect(handle.value?.hasUnresolvedPurchase).toBe(false);
    } finally {
      native.resolve(null);
      await flushPromises();
      vi.useRealTimers();
    }
  });

  it('ignores a request timeout after its account epoch has ended', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedIap.requestPurchase.mockReturnValueOnce(Promise.withResolvers<null>().promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { handle } = await mountOwner();
      const initial = handle.value?.purchase(creditPack);
      await flushPromises();
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
      bumpAuthEpoch();
      await vi.advanceTimersByTimeAsync(16_000);
      await initial;
      await flushPromises();
      expect(handle.value?.errorMessageKey).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the outcome deadline after an identified native completion', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const native = Promise.withResolvers<Purchase | null>();
    mockedIap.requestPurchase.mockReturnValueOnce(native.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { handle } = await mountOwner();
      const initial = handle.value?.purchase(creditPack);
      await flushPromises();
      native.resolve(createPurchase());
      await flushPromises();
      expect(handle.value?.completedPurchaseCount).toBe(1);
      await vi.advanceTimersByTimeAsync(16_000);
      await initial;
      mockedIap.requestPurchase.mockResolvedValueOnce(
        createPurchase({ purchaseState: 'pending', transactionId: 'tx-next-after-deadline' })
      );
      expect(await handle.value?.purchase(creditPack)).toBe(true);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
      expect(mockedIap.getAvailablePurchases).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is the single useIAP call site and renders its children with a purchase callback', async () => {
    const { handle } = await mountOwner();

    // The provider owns the call site; it renders once per state update, and
    // the admission read adds one after mount, so the count is not a mount count.
    expect(mockedIap.useIAP).toHaveBeenCalled();
    expect(mockedIap.handlers).not.toBeNull();
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

  it('keeps a pending delivery queued and completes the later approval once', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);

    // A pending charge retains admission until its approved transaction completes.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase({ purchaseState: 'pending' }));
    await flushPromises();

    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
    expect(handle.value?.errorMessageKey).toBeNull();
    expect(handle.value?.completedPurchaseCount).toBe(0);

    // The store approves the same transaction and re-delivers it as purchased:
    // exactly one grant and one announcement.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase({ purchaseState: 'purchased' }));
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(handle.value?.completedPurchaseCount).toBe(1);
    expect(handle.value?.errorMessageKey).toBeNull();
  });

  it('does not report a pending store error as a purchase failure', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedIap.requestPurchase.mockRejectedValueOnce({
      code: 'pending',
      message: 'Purchase is pending',
    });
    const { handle } = await mountOwner();
    expect(await handle.value?.purchase(creditPack)).toBe(false);
    await flushPromises();

    expect(handle.value?.errorMessageKey).toBeNull();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
  });

  it('a store call that never settles releases the row after the deadline and waits instead of failing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockedQuery.serverProductsData = {
        appAccountToken: APP_ACCOUNT_TOKEN,
        products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
      };
      const { handle } = await mountOwner();
      // A store that never answers is what the deadline bounds.
      mockedIap.requestPurchase.mockReturnValue(new Promise(() => undefined));

      const started = handle.value?.purchase(creditPack);
      await flushPromises();
      expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.resolve();
      });
      expect(await started).toBe(false);

      // The row is released, and the screen says the store has not answered:
      // no failure, because the sheet can still be open.
      expect(handle.value?.completingProductId).toBeNull();
      expect(handle.value?.errorMessageKey).toBeNull();
      expect(handle.value?.purchaseWait).toEqual({
        productId: APPLE_PRODUCT_ID,
        kind: 'store',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('buying a timed-out pack again reconciles first and never charges a second time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockedQuery.serverProductsData = {
        appAccountToken: APP_ACCOUNT_TOKEN,
        products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
      };
      const { handle } = await mountOwner();
      mockedIap.requestPurchase.mockReturnValueOnce(new Promise(() => undefined));

      const first = handle.value?.purchase(creditPack);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.resolve();
      });
      expect(await first).toBe(false);
      expect(mockedIap.getAvailablePurchases).not.toHaveBeenCalled();

      // The person taps the same pack again. The store cannot be told to cancel
      // the earlier request, so the owner looks for what it still holds instead
      // of charging again.
      await flushPromises();
      expect(await handle.value?.purchase(creditPack)).toBe(false);
      await flushPromises();

      expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
      expect(handle.value?.completingProductId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('credits a late unidentified success but still requires consent before another charge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mockedQuery.serverProductsData = {
        appAccountToken: APP_ACCOUNT_TOKEN,
        products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
      };
      const { handle } = await mountOwner();
      mockedIap.requestPurchase.mockReturnValueOnce(new Promise(() => undefined));

      const first = handle.value?.purchase(creditPack);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.resolve();
      });
      expect(await first).toBe(false);
      expect(handle.value?.completingProductId).toBeNull();

      vi.useRealTimers();
      // The store lands the charge after the row was released: the delivery is
      // not the owner's request any more, so recovery completes it.
      mockedIap.handlers?.onPurchaseSuccess(createPurchase());
      await flushPromises();

      expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
      expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
      expect(handle.value?.completingProductId).toBeNull();
      expect(handle.value?.completedPurchaseCount).toBe(1);

      expect(await handle.value?.purchase(creditPack)).toBe(false);
      expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
      expect(handle.value?.buyAgainProductId).toBe(APPLE_PRODUCT_ID);
      mockedIap.requestPurchase.mockResolvedValueOnce(
        createPurchase({ purchaseState: 'pending', transactionId: 'tx-consented-retry' })
      );
      expect(await handle.value?.buyAgain(creditPack)).toBe(true);
      expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a delivery for another product does not release the pending request', async () => {
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [
        { appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' },
        { appleProductId: CREDIT_PACK_50, googleProductId: 'credits_usd50' },
      ],
    };
    const { handle } = await mountOwner();

    expect(await handle.value?.purchase(creditPack)).toBe(true);
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);

    // A transaction for the other pack arrives while this one is pending.
    mockedIap.handlers?.onPurchaseSuccess(
      createPurchase({ productId: CREDIT_PACK_50, transactionId: 'tx-other-pack' })
    );
    await flushPromises();

    // It is completed as recovery, and the pending row stays pending.
    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);

    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();
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

    // The store reconnects and its lookup still returns the same transaction:
    // it must not be completed again, because the recovered transaction id is
    // remembered. A render alone does not re-run the pass.
    mockedIap.connected = false;
    await act(async () => {
      renderer.update(ownerElement(handle));
      await Promise.resolve();
    });
    mockedIap.connected = true;
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
    mockedIap.requestPurchase.mockRejectedValueOnce({
      code: 'billing-unavailable',
      message: 'Play Store service is not connected',
    });
    const { handle } = await mountOwner();
    expect(await handle.value?.purchase(creditPack)).toBe(false);
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

    // An unrelated listener error cannot release a charge still completing.
    mockedIap.handlers?.onPurchaseError({
      code: 'billing-unavailable',
      message: 'Play Store service is not connected',
    });
    await flushPromises();
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
    expect(await handle.value?.purchase(creditPack50)).toBe(false);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);
    staleCompletion.resolve({ alreadyProcessed: false });
    await flushPromises();
    expect(handle.value?.completingProductId).toBeNull();
    expect(await handle.value?.purchase(creditPack50)).toBe(true);
    expect(handle.value?.completingProductId).toBe(CREDIT_PACK_50);
  });

  it('recovers the outstanding purchase when the store reports it as already owned', async () => {
    mockedIap.getAvailablePurchases.mockResolvedValue([createPurchase()]);
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    mockedIap.requestPurchase.mockRejectedValueOnce({
      code: 'already-owned',
      message: 'Item already owned',
    });
    const { handle } = await mountOwner();
    expect(await handle.value?.purchase(creditPack)).toBe(false);
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

  it('ignores an already-owned listener while the captured request rejection recovers', async () => {
    // Only the captured rejection owns recovery; an uncorrelated duplicate is ignored.
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

  it('recovers once when an uncorrelated listener follows the captured request rejection', async () => {
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

  it('gives up on a lookup that never answers and retries the next already-owned attempt', async () => {
    // The store accepts the first `AlreadyOwned` lookup and never answers it.
    // The pass must time out and let the next attempt run a fresh lookup.
    const hungLookup = Promise.withResolvers<Purchase[]>();
    mockedIap.getAvailablePurchases.mockReturnValueOnce(hungLookup.promise);
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const alreadyOwned = { code: 'already-owned', message: 'Item already owned' };
    mockedIap.requestPurchase.mockRejectedValue(alreadyOwned);

    // Only the deadline is faked: the mount helpers await real microtasks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { handle } = await mountOwner();

      const firstAttempt = handle.value?.purchase(creditPack);
      await flushPromises();
      expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(16_000);
      await flushPromises();

      // The deadline gives up on the hung lookup: the attempt falls back to the
      // existing purchase-failure copy and completes nothing.
      expect(await firstAttempt).toBe(false);
      expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
      expect(handle.value?.errorMessageKey).toBe('kiloPass.purchaseFailed');

      // The slot is free, so the next attempt runs a fresh lookup, which answers.
      mockedIap.getAvailablePurchases.mockResolvedValue([createPurchase()]);
      const secondAttempt = handle.value?.purchase(creditPack);
      await flushPromises();

      expect(await secondAttempt).toBe(false);
      expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(2);
      expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
      expect(handle.value?.completedPurchaseCount).toBe(1);
      expect(handle.value?.errorMessageKey).toBeNull();

      // The timed-out lookup answers late: a settled pass must ignore it, so no
      // completion lands for the transaction it carried.
      hungLookup.resolve([createPurchase({ transactionId: 'tx-late' })]);
      await flushPromises();
      expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
      expect(handle.value?.completedPurchaseCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the backend ownership refusal when an uncorrelated listener repeats the rejection', async () => {
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

  it('recovers a legacy Play receipt after the purchasable catalog switches to expiring SKUs', async () => {
    mockedPlatform.OS = 'android';
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10_1year_v2' }],
      recoveryGoogleProductIds: ['credits_usd10', 'credits_usd10_1year_v2'],
    };
    const legacyPurchase = createPurchase({
      store: 'google',
      productId: 'credits_usd10',
      purchaseToken: 'legacy-play-token',
    });
    mockedIap.getAvailablePurchases.mockResolvedValue([legacyPurchase]);
    const { handle } = await mountOwner();
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledWith({
      productId: 'credits_usd10',
      purchaseToken: 'legacy-play-token',
    });
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: legacyPurchase,
      isConsumable: true,
    });
    expect(mockedQuery.invalidateQueries).toHaveBeenCalled();
    // The background recovery pass is silent: it refreshes the balance but
    // announces nothing.
    expect(handle.value?.completedPurchaseCount).toBe(0);
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
    expect(handle.value?.completingProductId).toBe(APPLE_PRODUCT_ID);
  });

  describe('when Play dropped its billing client after connecting', () => {
    const notReady = { code: 'not-prepared', message: 'Billing client not ready' };
    const playListing = { type: 'in-app', id: 'credits_usd10', displayPrice: '$10.99' };

    async function loadPlayCatalog(handle: ProbeHandle) {
      const fetchStoreProducts = handle.value?.fetchStoreProducts;
      if (!fetchStoreProducts) {
        throw new Error('CreditNativeIapOwner exposed no product fetch');
      }
      const products = await loadStoreCreditProducts({
        fetchStoreProducts,
        loadBackendProducts: vi.fn().mockResolvedValue({
          appAccountToken: APP_ACCOUNT_TOKEN,
          products: [creditPack.backend],
        }),
        storefront: 'play',
      });
      return products;
    }

    it('reconnects and prices the packs on the second ask', async () => {
      mockedIap.connected = true;
      mockedIap.fetchProducts.mockRejectedValueOnce(notReady).mockResolvedValueOnce([playListing]);
      const { handle } = await mountOwner();

      await expect(loadPlayCatalog(handle)).resolves.toEqual([
        { backend: creditPack.backend, storeProductId: 'credits_usd10', displayPrice: '$10.99' },
      ]);
      expect(mockedIap.reconnect).toHaveBeenCalledTimes(1);
      expect(mockedIap.fetchProducts).toHaveBeenCalledTimes(2);
    });

    it('shows the connection copy when the second ask also fails', async () => {
      mockedIap.connected = true;
      mockedIap.fetchProducts.mockRejectedValue(notReady);
      const { handle } = await mountOwner();

      const failure = await loadPlayCatalog(handle).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoreCreditProductsError);
      expect(failure).toMatchObject({ key: 'kiloPass.couldNotConnectToPlay' });
      expect(mockedIap.reconnect).toHaveBeenCalledTimes(1);
      expect(mockedIap.fetchProducts).toHaveBeenCalledTimes(2);
    });

    it('does not ask again once the caller has given up on the store', async () => {
      mockedIap.connected = true;
      mockedIap.fetchProducts.mockRejectedValue(notReady);
      const { handle } = await mountOwner();
      const controller = new AbortController();
      controller.abort();

      await expect(
        handle.value?.fetchStoreProducts(['credits_usd10'], { signal: controller.signal })
      ).rejects.toBe(notReady);
      expect(mockedIap.reconnect).not.toHaveBeenCalled();
      expect(mockedIap.fetchProducts).toHaveBeenCalledTimes(1);
    });

    it('does not ask again when the caller gives up during the reconnect', async () => {
      mockedIap.connected = true;
      mockedIap.fetchProducts.mockRejectedValue(notReady);
      const { handle } = await mountOwner();
      const controller = new AbortController();
      // eslint-disable-next-line eslint/require-await -- the abort is the behavior under test; reconnect answers at once
      mockedIap.reconnect.mockImplementation(async () => {
        controller.abort();
        return true;
      });

      await expect(
        handle.value?.fetchStoreProducts(['credits_usd10'], { signal: controller.signal })
      ).rejects.toBe(notReady);
      expect(mockedIap.fetchProducts).toHaveBeenCalledTimes(1);
    });

    it('does not ask again when the reconnect fails', async () => {
      mockedIap.connected = true;
      mockedIap.reconnect.mockResolvedValue(false);
      mockedIap.fetchProducts.mockRejectedValue(notReady);
      const { handle } = await mountOwner();

      await expect(handle.value?.fetchStoreProducts(['credits_usd10'])).rejects.toBe(notReady);
      expect(mockedIap.fetchProducts).toHaveBeenCalledTimes(1);
    });

    it('does not reconnect for a store failure that is not a lost connection', async () => {
      mockedIap.connected = true;
      const queryFailed = { code: 'query-product', message: 'Failed to query product' };
      mockedIap.fetchProducts.mockRejectedValue(queryFailed);
      const { handle } = await mountOwner();

      await expect(handle.value?.fetchStoreProducts(['credits_usd10'])).rejects.toBe(queryFailed);
      expect(mockedIap.reconnect).not.toHaveBeenCalled();
      expect(mockedIap.fetchProducts).toHaveBeenCalledTimes(1);
    });

    it('reconnects after a purchase the store rejected as not ready', async () => {
      mockedPlatform.OS = 'android';
      mockedIap.connected = true;
      mockedQuery.serverProductsData = {
        appAccountToken: APP_ACCOUNT_TOKEN,
        products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
      };
      mockedIap.requestPurchase.mockRejectedValueOnce(notReady);
      const { handle } = await mountOwner();
      expect(await handle.value?.purchase(creditPack)).toBe(false);
      await flushPromises();

      // The request never reached the store: it is released with the generic
      // copy, and the connection is restored so the next tap can buy.
      expect(mockedIap.reconnect).toHaveBeenCalledTimes(1);
      expect(handle.value?.completingProductId).toBeNull();
      expect(handle.value?.errorMessageKey).toBe('kiloPass.purchaseFailed');
    });
  });
});
