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
  availablePurchases: [] as Purchase[],
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
  useIAP: (handlers: {
    onPurchaseError: (error: unknown) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  }) => {
    mockedIap.useIAP(handlers);
    mockedIap.handlers = handlers;
    return {
      availablePurchases: mockedIap.availablePurchases,
      connected: mockedIap.connected,
      finishTransaction: mockedIap.finishTransaction,
      getAvailablePurchases: mockedIap.getAvailablePurchases,
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
  mockedIap.availablePurchases = [];
  mockedIap.connected = false;
  mockedIap.finishTransaction.mockResolvedValue(undefined);
  mockedIap.getAvailablePurchases.mockResolvedValue(undefined);
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
    mockedIap.availablePurchases = [createPurchase()];
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: APP_ACCOUNT_TOKEN,
      products: [{ appleProductId: APPLE_PRODUCT_ID, googleProductId: 'credits_usd10' }],
    };
    const { handle, renderer } = await mountOwner();
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(mockedQuery.invalidateQueries).toHaveBeenCalled();

    // A new store snapshot with the same transaction must not complete it again.
    mockedIap.availablePurchases = [createPurchase()];
    await act(async () => {
      renderer.update(ownerElement(handle));
      await Promise.resolve();
    });
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(handle.value?.completingProductId).toBeNull();
  });
});
