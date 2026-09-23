import { createElement } from 'react';
import { type Purchase } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type StoreCreditProduct } from '@/lib/credits/store-products';
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
      requestPurchase: mockedIap.requestPurchase,
    };
  },
}));

vi.mock('react-native', () => ({
  Platform: mockedPlatform,
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
});
