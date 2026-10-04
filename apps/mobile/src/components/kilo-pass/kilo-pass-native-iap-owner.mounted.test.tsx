/* eslint-disable max-lines -- the owner's ownership-lookup, failure, and preflight states share one harness. */
import { createElement } from 'react';
import { type Purchase } from 'expo-iap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { type AppStoreKiloPassProduct } from '@/lib/kilo-pass/store-products';
import {
  type KiloPassNativeIapContextValue,
  KiloPassNativeIapOwner,
  useKiloPassNativeIap,
} from './kilo-pass-native-iap-owner';

const KILO_PASS_PRODUCT_ID = 'kilo_pass_monthly_v1';
const OTHER_PASS_PRODUCT_ID = 'kilo_pass_yearly_v1';
const OTHER_ACCOUNT_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function createPassProduct(
  appleProductId: string,
  googleProductId: string
): AppStoreKiloPassProduct {
  return {
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    appleProductId,
    cadence: 'monthly',
    description: 'Kilo Pass',
    displayPrice: '$24.99',
    googleBasePlanId: 'monthly-v1',
    googleProductId,
    storeProduct: {
      id: appleProductId,
      displayPrice: '$24.99',
      title: 'Kilo Pass',
      description: 'Kilo Pass',
    },
    suggestedStoreMonthlyPriceUsd: 24.7,
    tier: 'tier_19',
    title: 'Kilo Pass',
    webMonthlyPriceUsd: 19,
  };
}

const mockedIap = vi.hoisted(() => ({
  connected: false,
  fetchProducts: vi.fn(),
  finishTransaction: vi.fn(),
  // The SDK's value-returning lookup, used by the owner.
  getAvailablePurchases: vi.fn(),
  handlers: null as {
    onPurchaseError: (error: Error) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  } | null,
  // The hook's lookup. It logs every failure to the dev LogBox, so the owner
  // must never call it: a raw library message survived on the Buy credits
  // screen after the Kilo Pass route had used it.
  hookGetAvailablePurchases: vi.fn(),
  requestPurchase: vi.fn(),
  restorePurchases: vi.fn(),
  useIAP: vi.fn(),
}));

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' as string }));

const mockedQuery = vi.hoisted(() => ({
  completePurchase: vi.fn(),
  invalidateQueries: vi.fn(),
  removeQueries: vi.fn(),
  serverProductsData: undefined as
    | { appAccountToken: string; products: { appleProductId: string; googleProductId: string }[] }
    | undefined,
  storeProductsIsLoading: false,
}));

vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    BillingUnavailable: 'billing-unavailable',
    UserCancelled: 'user-cancelled',
  },
  fetchProducts: mockedIap.fetchProducts,
  getAvailablePurchases: mockedIap.getAvailablePurchases,
  useIAP: (handlers: {
    onPurchaseError: (error: Error) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  }) => {
    mockedIap.useIAP(handlers);
    mockedIap.handlers = handlers;
    return {
      availablePurchases: [],
      connected: mockedIap.connected,
      finishTransaction: mockedIap.finishTransaction,
      getAvailablePurchases: mockedIap.hookGetAvailablePurchases,
      requestPurchase: mockedIap.requestPurchase,
      restorePurchases: mockedIap.restorePurchases,
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
  useQueryClient: () => ({
    invalidateQueries: mockedQuery.invalidateQueries,
    removeQueries: mockedQuery.removeQueries,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      completeAppStorePurchase: { mutationOptions: () => ({}) },
      completePlayPurchase: { mutationOptions: () => ({}) },
      getCreditHistory: { pathFilter: () => ({ queryKey: ['credit-history'] }) },
      getMobileStoreProducts: { queryOptions: () => ({ queryKey: ['kp-products'] }) },
      getPurchasePresentation: { pathFilter: () => ({ queryKey: ['presentation'] }) },
      getState: { pathFilter: () => ({ queryKey: ['state'] }) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ authEpoch: 0 }),
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  KILO_PASS_PURCHASE_FAILED_EVENT: 'kilo_pass_purchase_failed',
  KILO_PASS_PURCHASE_STARTED_EVENT: 'kilo_pass_purchase_started',
}));

vi.mock('@/lib/kilo-pass/use-store-kilo-pass-products', () => ({
  // The owner reads the backend catalog through this shared query-options
  // helper; the mock must expose it or every render throws "No export".
  backendStoreKiloPassProductsQueryOptions: () => ({ queryKey: ['kp-products'] }),
  useStoreKiloPassProducts: () => ({
    products: [],
    isLoading: mockedQuery.storeProductsIsLoading,
    isRefetching: false,
    errorMessage: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/i18n', () => ({
  i18n: { language: 'en', t: (key: string) => key },
}));

vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
}));

vi.mock('@/lib/format', () => ({
  formatDate: () => '2026-01-01',
  formatUsd: (value: number) => `$${value}`,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(arg => typeof arg === 'string').join(' '),
  parseTimestamp: (value: string) => new Date(value),
}));

vi.mock('@kilocode/app-shared/commerce', () => ({
  KILO_PASS_TITLE: 'Kilo Pass',
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

type ProbeHandle = { value: KiloPassNativeIapContextValue | null };

function Probe({ handle }: { handle: ProbeHandle }) {
  handle.value = useKiloPassNativeIap();
  return null;
}

function ownerElement(handle: ProbeHandle) {
  return createElement(KiloPassNativeIapOwner, null, createElement(Probe, { handle }));
}

function createPurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: true,
    productId: KILO_PASS_PRODUCT_ID,
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
    throw new Error('KiloPassNativeIapOwner did not mount');
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
  mockedIap.hookGetAvailablePurchases.mockResolvedValue([]);
  mockedIap.requestPurchase.mockResolvedValue(null);
  mockedIap.restorePurchases.mockResolvedValue(undefined);
  mockedQuery.completePurchase.mockResolvedValue({ alreadyProcessed: false });
  mockedQuery.invalidateQueries.mockResolvedValue(undefined);
  mockedQuery.serverProductsData = undefined;
  mockedQuery.storeProductsIsLoading = false;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('KiloPassNativeIapOwner', () => {
  it('checks ownership with the SDK lookup, never the hook method that logs', async () => {
    mockedIap.connected = true;

    const { handle } = await mountOwner();
    await flushPromises();

    expect(mockedIap.getAvailablePurchases).toHaveBeenCalledTimes(1);
    // The hook's lookup is the only caller of expo-iap's
    // `console.error('Error fetching available purchases:', …)`, which a dev
    // build renders as a LogBox toast on this and every later screen.
    expect(mockedIap.hookGetAvailablePurchases).not.toHaveBeenCalled();
    expect(handle.value?.ownershipChecked).toBe(true);
    expect(handle.value?.ownershipCheckFailed).toBe(false);
    expect(handle.value?.errorMessage).toBeNull();
  });

  it('a failed ownership lookup blocks purchasing with the inline copy and no raw log', async () => {
    mockedIap.connected = true;
    mockedIap.getAvailablePurchases.mockRejectedValue(
      new Error('Play Store service is not connected')
    );

    const { handle } = await mountOwner();
    await flushPromises();

    expect(mockedIap.hookGetAvailablePurchases).not.toHaveBeenCalled();
    expect(handle.value?.ownershipChecked).toBe(false);
    expect(handle.value?.ownershipCheckFailed).toBe(true);
    expect(handle.value?.errorMessage).toBe('kiloPass.couldNotConnectToAppStore');
  });

  it('completes the later approval of a pending pass in-session', async () => {
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [{ appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilo_pass_monthly' }],
    };
    const { handle } = await mountOwner();
    await flushPromises();

    // Play delivers a slow test card's subscription as `pending` first. It must
    // release the request without a failure or a completion, leaving the store
    // transaction for the later approval.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase({ purchaseState: 'pending' }));
    await flushPromises();

    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    expect(handle.value?.errorMessage).toBeNull();

    // The store approves the same transaction and re-delivers it as purchased.
    // The recovery effect only runs when the store connects, so the owner must
    // complete it here: one grant, one acknowledgement.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase({ purchaseState: 'purchased' }));
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: expect.objectContaining({ productId: KILO_PASS_PRODUCT_ID }),
      isConsumable: false,
    });
    expect(handle.value?.errorMessage).toBeNull();
  });

  it('does not clear a newer request when an older approval is delivered', async () => {
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [
        { appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilo_pass_monthly' },
        { appleProductId: OTHER_PASS_PRODUCT_ID, googleProductId: 'kilo_pass_yearly' },
      ],
    };
    const { handle } = await mountOwner();
    await flushPromises();

    const onCompleted = vi.fn();
    await act(async () => {
      await handle.value?.purchase(createPassProduct(KILO_PASS_PRODUCT_ID, 'kilo_pass_monthly'), {
        onCompleted: () => {
          onCompleted();
        },
      });
    });
    await flushPromises();
    expect(handle.value?.isPending).toBe(true);

    // The later approval of an older, different-tier purchase arrives while the
    // new request is still in flight. It must be completed, but it must not
    // release the newer request, drop its completion callback, or announce into
    // it — that would strand the purchase the user is actually waiting on.
    mockedIap.handlers?.onPurchaseSuccess(
      createPurchase({ productId: OTHER_PASS_PRODUCT_ID, transactionId: 'tx-old' })
    );
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(handle.value?.isPending).toBe(true);

    // The newer request's own delivery still completes and fires its callback.
    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(2);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(handle.value?.isPending).toBe(false);
  });

  it('recovers an owned pass before showing the different-account copy', async () => {
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [{ appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilo_pass_monthly' }],
    };
    const { handle } = await mountOwner();
    await flushPromises();
    // This user was charged and the backend completion failed: the transaction
    // is still pending, so the store refuses a new purchase as AlreadyOwned.
    // Both store channels report that one refusal.
    const alreadyOwned = Object.assign(new Error('Item already owned'), {
      code: 'already-owned',
    });
    mockedIap.getAvailablePurchases.mockResolvedValue([createPurchase()]);
    mockedIap.requestPurchase.mockRejectedValueOnce(alreadyOwned);

    await act(async () => {
      await handle.value?.purchase(createPassProduct(KILO_PASS_PRODUCT_ID, 'kilo_pass_monthly'));
    });
    mockedIap.handlers?.onPurchaseError(alreadyOwned);
    await flushPromises();

    expect(mockedQuery.completePurchase).toHaveBeenCalledTimes(1);
    expect(mockedIap.finishTransaction).toHaveBeenCalledTimes(1);
    expect(handle.value?.errorMessage).toBeNull();
  });

  it('shows the different-account copy when no outstanding pass explains AlreadyOwned', async () => {
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [{ appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilo_pass_monthly' }],
    };
    const { handle } = await mountOwner();
    await flushPromises();
    mockedIap.requestPurchase.mockRejectedValueOnce(
      Object.assign(new Error('Item already owned'), { code: 'already-owned' })
    );

    await act(async () => {
      await handle.value?.purchase(createPassProduct(KILO_PASS_PRODUCT_ID, 'kilo_pass_monthly'));
    });
    await flushPromises();

    expect(mockedQuery.completePurchase).not.toHaveBeenCalled();
    expect(handle.value?.errorMessage).toBe('kiloPass.purchaseOwnedByAnotherAccount');
  });

  it('feeds the store answer into the ownership preflight and the owned ids', async () => {
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [{ appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilo_pass_monthly' }],
    };
    mockedIap.getAvailablePurchases.mockResolvedValue([
      createPurchase({ appAccountToken: OTHER_ACCOUNT_TOKEN, transactionId: 'tx-other-owner' }),
    ]);

    const { handle } = await mountOwner();
    await flushPromises();

    expect(handle.value?.ownedAppleProductId).toBe(KILO_PASS_PRODUCT_ID);
    expect(handle.value?.ownedByAnotherAccount).toBe(true);
    expect(handle.value?.ownershipChecked).toBe(true);
  });

  it('refreshes the ownership snapshot after a manual restore', async () => {
    mockedIap.connected = true;
    mockedQuery.serverProductsData = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [{ appleProductId: KILO_PASS_PRODUCT_ID, googleProductId: 'kilo_pass_monthly' }],
    };
    // The connect-time lookup answers nothing; the restore finds the pass.
    mockedIap.getAvailablePurchases.mockResolvedValueOnce([]).mockResolvedValue([createPurchase()]);

    const { handle } = await mountOwner();
    await flushPromises();
    expect(handle.value?.ownedAppleProductId).toBeNull();

    await act(async () => {
      await handle.value?.restorePurchases();
    });
    await flushPromises();

    // The snapshot is otherwise written only on connect, so without a refresh
    // the owned tile and the preflight stay stale for the rest of the session.
    expect(handle.value?.ownedAppleProductId).toBe(KILO_PASS_PRODUCT_ID);
    expect(handle.value?.ownershipChecked).toBe(true);
    expect(handle.value?.ownershipCheckFailed).toBe(false);
  });
});
