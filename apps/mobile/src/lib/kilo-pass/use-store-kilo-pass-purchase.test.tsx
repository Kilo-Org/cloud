/* eslint-disable max-lines */

import * as React from 'react';
import { type Purchase } from 'expo-iap';
import { toast } from 'sonner-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAppStoreKiloPassPurchaseActions,
  resetInlinePurchaseErrorOwnership,
  resetPurchaseErrorToastDedup,
  StoreKiloPassPurchaseProvider,
  useInlinePurchaseErrorOwnership,
} from './use-store-kilo-pass-purchase';
import { type AppStoreKiloPassProduct } from './store-products';

const mockedIap = vi.hoisted(() => ({
  availablePurchases: [] as Purchase[],
  connected: false,
  finishTransaction: vi.fn(),
  getAvailablePurchases: vi.fn(),
  handlers: null as {
    onPurchaseError: (error: Error) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  } | null,
  requestPurchase: vi.fn(),
  restorePurchases: vi.fn(),
}));

const mockedReactQuery = vi.hoisted(() => ({
  completeAppStorePurchase: vi.fn(),
  completeAppStorePurchaseIsPending: false,
  invalidateQueries: vi.fn(),
  mobileStoreProductsData: {
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    products: [{ appleProductId: 'com.kilo.pass.tier19.monthly' }],
  },
}));

vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    UserCancelled: 'user-cancelled',
  },
  getAvailablePurchases: mockedIap.getAvailablePurchases,
  useIAP: (handlers: {
    onPurchaseError: (error: Error) => void;
    onPurchaseSuccess: (purchase: Purchase) => void;
  }) => ({
    availablePurchases: mockedIap.availablePurchases,
    connected: mockedIap.connected,
    finishTransaction: mockedIap.finishTransaction,
    getAvailablePurchases: mockedIap.getAvailablePurchases,
    requestPurchase: mockedIap.requestPurchase,
    restorePurchases: mockedIap.restorePurchases,
    ...(() => {
      mockedIap.handlers = handlers;
      return {};
    })(),
  }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    isPending: mockedReactQuery.completeAppStorePurchaseIsPending,
    mutateAsync: mockedReactQuery.completeAppStorePurchase,
  }),
  useQuery: () => ({
    data: mockedReactQuery.mobileStoreProductsData,
  }),
  useQueryClient: () => ({ invalidateQueries: mockedReactQuery.invalidateQueries }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  KILO_PASS_PURCHASE_COMPLETED_EVENT: 'kilo_pass_purchase_completed',
  KILO_PASS_PURCHASE_FAILED_EVENT: 'kilo_pass_purchase_failed',
  KILO_PASS_PURCHASE_STARTED_EVENT: 'kilo_pass_purchase_started',
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      completeAppStorePurchase: { mutationOptions: () => ({}) },
      getCreditHistory: { pathFilter: () => ({ queryKey: ['credit-history'] }) },
      getMobileStoreProducts: { queryOptions: () => ({ queryKey: ['mobile-products'] }) },
      getState: { pathFilter: () => ({ queryKey: ['state'] }) },
    },
    user: {
      getContextBalance: { pathFilter: () => ({ queryKey: ['balance'] }) },
      getCreditBlocks: { pathFilter: () => ({ queryKey: ['credits'] }) },
    },
  }),
}));

type StoreKiloPassPurchaseContextValue = {
  appStoreOwnershipPreflight: 'owned-by-another-account' | null;
  purchase: (
    product: AppStoreKiloPassProduct,
    options?: { onCompleted?: () => void }
  ) => Promise<void>;
  restorePurchases: () => Promise<'restored' | 'empty' | 'failed'>;
  isPending: boolean;
  isRestoringPurchases: boolean;
  errorMessage: string | null;
};

type ReactInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
};

type HookDispatcher = {
  useCallback: <T>(callback: T) => T;
  useEffect: (effect: () => unknown) => void;
  useMemo: <T>(factory: () => T) => T;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T) => [T, (value: T | ((previous: T) => T)) => void];
};

async function flushPromises() {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
}

function renderStoreKiloPassPurchaseProvider() {
  const reactInternals = React as typeof React & ReactInternals;
  const hookState: unknown[] = [];
  let hookIndex = 0;

  const dispatcher: HookDispatcher = {
    useCallback: hookCallback => {
      hookIndex += 1;
      return hookCallback;
    },
    useEffect: effect => {
      hookIndex += 1;
      effect();
    },
    useMemo: factory => {
      hookIndex += 1;
      return factory();
    },
    useRef: initialValue => {
      const stateIndex = hookIndex;
      hookIndex += 1;
      if (hookState[stateIndex] === undefined) {
        hookState[stateIndex] = { current: initialValue };
      }
      return hookState[stateIndex] as { current: typeof initialValue };
    },
    useState: initialValue => {
      const stateIndex = hookIndex;
      hookIndex += 1;
      if (hookState[stateIndex] === undefined) {
        hookState[stateIndex] = initialValue;
      }
      const setState = (
        value: typeof initialValue | ((previous: typeof initialValue) => typeof initialValue)
      ) => {
        hookState[stateIndex] =
          typeof value === 'function'
            ? (value as (previous: typeof initialValue) => typeof initialValue)(
                hookState[stateIndex] as typeof initialValue
              )
            : value;
      };
      return [hookState[stateIndex] as typeof initialValue, setState];
    },
  };

  function render() {
    const previousDispatcher =
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    hookIndex = 0;
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try {
      const renderProviderElement = StoreKiloPassPurchaseProvider;
      const providerElement = renderProviderElement({ children: null });
      return providerElement.props.value as StoreKiloPassPurchaseContextValue;
    } finally {
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
        previousDispatcher;
    }
  }

  return { render };
}

/** Mounts `useInlinePurchaseErrorOwnership`, returning an `unmount` that runs its cleanup. */
function mountInlineErrorOwnership() {
  const reactInternals = React as typeof React & ReactInternals;
  let cleanup: (() => void) | undefined = undefined;
  const dispatcher = {
    useEffect: (effect: () => (() => void) | undefined) => {
      cleanup = effect();
    },
  };

  const previousDispatcher =
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
  try {
    // Same alias trick as renderProviderElement above: run the hook against
    // the fake dispatcher without tripping rules-of-hooks lexically.
    const mountOwnershipHook = useInlinePurchaseErrorOwnership;
    mountOwnershipHook();
  } finally {
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
      previousDispatcher;
  }

  return {
    unmount: () => {
      cleanup?.();
    },
  };
}

function ignoreDeferredResolution(_value: unknown) {
  return undefined;
}

const product: AppStoreKiloPassProduct = {
  appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
  appleProductId: 'com.kilo.pass.tier19.monthly',
  cadence: 'monthly',
  description: 'Kilo Pass',
  displayPrice: '$24.99',
  googleBasePlanId: 'monthly-v1',
  googleProductId: 'kilopass_tier19',
  storeProduct: {
    id: 'com.kilo.pass.tier19.monthly',
    displayPrice: '$24.99',
    title: 'Kilo Pass',
    description: 'Kilo Pass',
  },
  suggestedStoreMonthlyPriceUsd: 24.7,
  tier: 'tier_19',
  title: 'Kilo Pass',
  webMonthlyPriceUsd: 19,
};

function noop() {
  return undefined;
}

function createActions(
  overrides: Partial<Parameters<typeof createAppStoreKiloPassPurchaseActions>[0]> = {}
) {
  return createAppStoreKiloPassPurchaseActions({
    completeAppStorePurchase: vi.fn(),
    enabledAppleProductIds: [product.appleProductId],
    finishTransaction: vi.fn(),
    getAvailablePurchases: vi.fn().mockResolvedValue([]),
    invalidateAfterCompletion: vi.fn(),
    requestPurchase: vi.fn(),
    restorePurchases: vi.fn(),
    showError: () => undefined,
    ...overrides,
  });
}

function createDeferredPromise() {
  let resolvePromise: (value: unknown) => void = ignoreDeferredResolution;
  const promise = new Promise(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createDeferredRejectablePromise() {
  let rejectPromise: (reason?: unknown) => void = ignoreDeferredResolution;
  const promise = new Promise((_resolve, reject) => {
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise };
}

function createPurchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'purchase-1',
    ids: null,
    isAutoRenewing: true,
    platform: 'ios',
    productId: product.appleProductId,
    purchaseState: 'purchased',
    purchaseToken: 'signed-jws',
    quantity: 1,
    store: 'apple',
    transactionDate: Date.now(),
    transactionId: 'tx-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPurchaseErrorToastDedup();
  resetInlinePurchaseErrorOwnership();
  mockedIap.availablePurchases = [];
  mockedIap.connected = false;
  mockedIap.finishTransaction.mockResolvedValue(undefined);
  mockedIap.getAvailablePurchases.mockResolvedValue(undefined);
  mockedIap.handlers = null;
  mockedIap.requestPurchase.mockResolvedValue(null);
  mockedIap.restorePurchases.mockResolvedValue(undefined);
  mockedReactQuery.completeAppStorePurchase.mockResolvedValue({ alreadyProcessed: false });
  mockedReactQuery.completeAppStorePurchaseIsPending = false;
  mockedReactQuery.invalidateQueries.mockResolvedValue(undefined);
  mockedReactQuery.mobileStoreProductsData = {
    appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
    products: [{ appleProductId: product.appleProductId }],
  };
});

describe('createAppStoreKiloPassPurchaseActions', () => {
  it('requests an App Store subscription purchase', async () => {
    const requestPurchase = vi.fn().mockResolvedValue(null);
    const actions = createActions({
      requestPurchase,
    });

    await actions.purchase(product);

    expect(requestPurchase).toHaveBeenCalledWith({
      request: { apple: { appAccountToken: product.appAccountToken, sku: product.appleProductId } },
      type: 'subs',
    });
  });

  it('stores the sheet completion callback when requesting an App Store purchase', async () => {
    const onCompleted = noop;
    const setPendingPurchaseCompletedCallback = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockResolvedValue(null),
      setPendingPurchaseCompletedCallback: value => {
        setPendingPurchaseCompletedCallback(value);
      },
    });

    await actions.purchase(product, { onCompleted });

    expect(setPendingPurchaseCompletedCallback).toHaveBeenCalledWith(onCompleted);
  });

  it('clears the pending sheet completion callback when purchase request fails', async () => {
    const onCompleted = noop;
    const setPendingPurchaseCompletedCallback = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue(new Error('Could not connect to App Store')),
      setPendingPurchaseCompletedCallback: value => {
        setPendingPurchaseCompletedCallback(value);
      },
      showError: () => undefined,
    });

    await actions.purchase(product, { onCompleted });

    expect(setPendingPurchaseCompletedCallback).toHaveBeenNthCalledWith(1, onCompleted);
    expect(setPendingPurchaseCompletedCallback).toHaveBeenNthCalledWith(2, null);
  });

  it('shows an error when the App Store purchase request fails before opening the sheet', async () => {
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue(new Error('Could not connect to App Store')),
      showError: message => {
        showError(message);
      },
    });

    await actions.purchase(product);

    expect(showError).toHaveBeenCalledWith('Could not connect to App Store');
  });

  it('does not show an error when the user cancels the App Store purchase sheet', async () => {
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue({
        code: 'user-cancelled',
        message: 'User cancelled the purchase',
      }),
      showError: message => {
        showError(message);
      },
    });

    await actions.purchase(product);

    expect(showError).not.toHaveBeenCalled();
  });

  it('shows a single account-link message when the App Store account already owns the subscription', async () => {
    const showError = vi.fn();
    const actions = createActions({
      requestPurchase: vi.fn().mockRejectedValue({
        code: 'already-owned',
        message: 'Item already owned',
      }),
      showError: message => {
        showError(message);
      },
    });

    await actions.purchase(product);

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(
      'This App Store subscription is linked to another Kilo account.'
    );
  });

  it('does not finish the transaction when backend completion fails', async () => {
    const finishTransaction = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      finishTransaction,
    });

    await actions.handlePurchaseSuccess(createPurchase());

    expect(finishTransaction).not.toHaveBeenCalled();
  });

  it('finishes the transaction and invalidates Kilo Pass state after backend success', async () => {
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
      finishTransaction,
      invalidateAfterCompletion,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    await actions.handlePurchaseSuccess(purchase);

    expect(invalidateAfterCompletion).toHaveBeenCalled();
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
    expect(onPurchaseCompleted).toHaveBeenCalled();
  });

  it('calls the pending sheet callback after provider-owned backend completion succeeds', async () => {
    let pendingCompletion: (() => void) | null = null;
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockResolvedValue({ alreadyProcessed: false }),
      finishTransaction: vi.fn(),
      invalidateAfterCompletion: vi.fn(),
      onPurchaseCompleted: () => {
        const pending = pendingCompletion;
        pendingCompletion = null;
        pending?.();
      },
      requestPurchase: vi.fn().mockResolvedValue(null),
      setPendingPurchaseCompletedCallback: pending => {
        pendingCompletion = pending;
      },
    });

    await actions.purchase(product, {
      onCompleted: () => {
        onPurchaseCompleted();
      },
    });
    await actions.handlePurchaseSuccess(purchase);

    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
    expect(pendingCompletion).toBeNull();
  });

  it('does not run purchase completion callback when backend completion fails', async () => {
    const onPurchaseCompleted = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    await actions.handlePurchaseSuccess(createPurchase());

    expect(onPurchaseCompleted).not.toHaveBeenCalled();
  });

  it('clears the pending sheet callback when backend completion fails', async () => {
    const setPendingPurchaseCompletedCallback = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockRejectedValue(new Error('backend failed')),
      setPendingPurchaseCompletedCallback: value => {
        setPendingPurchaseCompletedCallback(value);
      },
    });

    await actions.handlePurchaseSuccess(createPurchase());

    expect(setPendingPurchaseCompletedCallback).toHaveBeenCalledWith(null);
  });

  it('does not show backend completion errors while recovering purchases in the background', async () => {
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi
        .fn()
        .mockRejectedValue(
          new Error('App Store purchase account token does not match the signed-in user.')
        ),
      showError: message => {
        showError(message);
      },
    });

    await actions.recoverPurchases([createPurchase()]);

    expect(showError).not.toHaveBeenCalled();
  });

  it('recovers unfinished Kilo Pass App Store purchases', async () => {
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    await actions.recoverPurchases([
      purchase,
      {
        ...purchase,
        id: 'other-purchase',
        productId: 'other.product',
        transactionId: 'other-tx',
      },
      {
        ...purchase,
        id: 'pending-purchase',
        purchaseState: 'pending',
        transactionId: 'pending-tx',
      },
    ]);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(completeAppStorePurchase).toHaveBeenCalledWith({ signedTransactionJws: 'signed-jws' });
    expect(invalidateAfterCompletion).toHaveBeenCalledTimes(1);
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
    expect(onPurchaseCompleted).not.toHaveBeenCalled();
  });

  it('invalidates Kilo Pass state once after recovering multiple purchases', async () => {
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const purchases = [
      createPurchase({ id: 'purchase-1', purchaseToken: 'signed-jws-1', transactionId: 'tx-1' }),
      createPurchase({ id: 'purchase-2', purchaseToken: 'signed-jws-2', transactionId: 'tx-2' }),
      createPurchase({ id: 'purchase-3', purchaseToken: 'signed-jws-3', transactionId: 'tx-3' }),
    ];
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      invalidateAfterCompletion,
    });

    await actions.recoverPurchases(purchases);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(3);
    expect(finishTransaction).toHaveBeenCalledTimes(3);
    expect(invalidateAfterCompletion).toHaveBeenCalledTimes(1);
  });

  it('coalesces recovery and live callbacks for the same App Store transaction', async () => {
    const backendCompletion = createDeferredPromise();
    const completeAppStorePurchase = vi.fn().mockReturnValue(backendCompletion.promise);
    const finishTransaction = vi.fn();
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
    });

    const recovery = actions.handlePurchaseSuccess(purchase, { notifyCompletion: false });
    const liveCallback = actions.handlePurchaseSuccess(purchase);
    backendCompletion.resolve({ alreadyProcessed: false });
    await Promise.all([recovery, liveCallback]);

    expect(completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(finishTransaction).toHaveBeenCalledTimes(1);
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('coalesces completion across separate Kilo Pass purchase hook instances', async () => {
    const backendCompletion = createDeferredPromise();
    const completeFromRecovery = vi.fn().mockReturnValue(backendCompletion.promise);
    const completeFromSheet = vi.fn().mockResolvedValue({ alreadyProcessed: true });
    const finishFromRecovery = vi.fn();
    const finishFromSheet = vi.fn();
    const onPurchaseCompleted = vi.fn();
    const purchase = createPurchase();
    const recoveryActions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: completeFromRecovery,
      enabledAppleProductIds: [product.appleProductId],
      finishTransaction: finishFromRecovery,
      getAvailablePurchases: vi.fn().mockResolvedValue([]),
      invalidateAfterCompletion: vi.fn(),
      requestPurchase: vi.fn(),
      restorePurchases: vi.fn(),
      showError: () => undefined,
    });
    const sheetActions = createAppStoreKiloPassPurchaseActions({
      completeAppStorePurchase: completeFromSheet,
      enabledAppleProductIds: [product.appleProductId],
      finishTransaction: finishFromSheet,
      getAvailablePurchases: vi.fn().mockResolvedValue([]),
      invalidateAfterCompletion: vi.fn(),
      onPurchaseCompleted: () => {
        onPurchaseCompleted();
      },
      requestPurchase: vi.fn(),
      restorePurchases: vi.fn(),
      showError: () => undefined,
    });

    const recovery = recoveryActions.handlePurchaseSuccess(purchase, { notifyCompletion: false });
    const liveCallback = sheetActions.handlePurchaseSuccess(purchase);
    backendCompletion.resolve({ alreadyProcessed: false });
    await Promise.all([recovery, liveCallback]);

    expect(completeFromRecovery).toHaveBeenCalledTimes(1);
    expect(completeFromSheet).not.toHaveBeenCalled();
    expect(finishFromRecovery).toHaveBeenCalledTimes(1);
    expect(finishFromSheet).not.toHaveBeenCalled();
    expect(onPurchaseCompleted).toHaveBeenCalledTimes(1);
  });

  it('explicitly restores active Kilo Pass purchases through StoreKit and backend completion', async () => {
    const purchase = createPurchase();
    const restorePurchases = vi.fn().mockResolvedValue(undefined);
    const getAvailablePurchases = vi.fn().mockResolvedValue([purchase]);
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const finishTransaction = vi.fn();
    const invalidateAfterCompletion = vi.fn();
    const actions = createActions({
      completeAppStorePurchase,
      finishTransaction,
      getAvailablePurchases,
      invalidateAfterCompletion,
      restorePurchases,
    });

    const result = await actions.restorePurchases();

    expect(result).toBe('restored');
    expect(restorePurchases).toHaveBeenCalledTimes(1);
    expect(getAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(completeAppStorePurchase).toHaveBeenCalledWith({ signedTransactionJws: 'signed-jws' });
    expect(finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
    expect(invalidateAfterCompletion).toHaveBeenCalledTimes(1);
  });

  it('loads product IDs before deciding an explicit restore is empty', async () => {
    const purchase = createPurchase();
    const loadEnabledAppleProductIds = vi.fn().mockResolvedValue([product.appleProductId]);
    const completeAppStorePurchase = vi.fn().mockResolvedValue({ alreadyProcessed: false });
    const actions = createActions({
      completeAppStorePurchase,
      enabledAppleProductIds: [],
      getAvailablePurchases: vi.fn().mockResolvedValue([purchase]),
      loadEnabledAppleProductIds,
      restorePurchases: vi.fn().mockResolvedValue(undefined),
    });

    const result = await actions.restorePurchases();

    expect(result).toBe('restored');
    expect(loadEnabledAppleProductIds).toHaveBeenCalledTimes(1);
    expect(completeAppStorePurchase).toHaveBeenCalledWith({ signedTransactionJws: 'signed-jws' });
  });

  it('returns empty when StoreKit has no active Kilo Pass purchases to restore', async () => {
    const completeAppStorePurchase = vi.fn();
    const actions = createActions({
      completeAppStorePurchase,
      getAvailablePurchases: vi
        .fn()
        .mockResolvedValue([
          createPurchase({ productId: 'other.product', transactionId: 'other-tx' }),
        ]),
      restorePurchases: vi.fn().mockResolvedValue(undefined),
    });

    const result = await actions.restorePurchases();

    expect(result).toBe('empty');
    expect(completeAppStorePurchase).not.toHaveBeenCalled();
  });

  it('does not report empty when an eligible restored purchase belongs to another Kilo account', async () => {
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi
        .fn()
        .mockRejectedValue(
          new Error('App Store purchase account token does not match the signed-in user.')
        ),
      getAvailablePurchases: vi.fn().mockResolvedValue([createPurchase()]),
      restorePurchases: vi.fn().mockResolvedValue(undefined),
      showError: message => {
        showError(message);
      },
    });

    const result = await actions.restorePurchases();

    expect(result).toBe('failed');
    expect(showError).toHaveBeenCalledWith(
      'This App Store subscription is linked to another Kilo account.'
    );
  });

  it('shows explicit restore errors when silent recovery already started completion', async () => {
    const purchase = createPurchase();
    const backendCompletion = createDeferredRejectablePromise();
    const showError = vi.fn();
    const actions = createActions({
      completeAppStorePurchase: vi.fn().mockReturnValue(backendCompletion.promise),
      getAvailablePurchases: vi.fn().mockResolvedValue([purchase]),
      restorePurchases: vi.fn().mockResolvedValue(undefined),
      showError: message => {
        showError(message);
      },
    });

    const silentRecovery = actions.handlePurchaseSuccess(purchase, {
      notifyCompletion: false,
      notifyErrors: false,
    });
    const explicitRestore = actions.restorePurchases();
    await flushPromises();
    backendCompletion.reject(
      new Error('App Store purchase account token does not match the signed-in user.')
    );

    const [, restoreResult] = await Promise.all([silentRecovery, explicitRestore]);

    expect(restoreResult).toBe('failed');
    expect(showError).toHaveBeenCalledWith(
      'This App Store subscription is linked to another Kilo account.'
    );
  });

  it('shows a generic retryable error when StoreKit restore fails', async () => {
    const showError = vi.fn();
    const actions = createActions({
      getAvailablePurchases: vi.fn(),
      restorePurchases: vi.fn().mockRejectedValue(new Error('StoreKit unavailable')),
      showError: message => {
        showError(message);
      },
    });

    const result = await actions.restorePurchases();

    expect(result).toBe('failed');
    expect(showError).toHaveBeenCalledWith('Failed to restore purchases. Try again.');
  });
});

describe('StoreKiloPassPurchaseProvider', () => {
  it('exposes an App Store ownership mismatch preflight from available purchases', () => {
    mockedIap.availablePurchases = [
      createPurchase({ appAccountToken: '550e8400-e29b-41d4-a716-446655440001' }),
    ];
    const provider = renderStoreKiloPassPurchaseProvider();

    const value = provider.render();

    expect(value.appStoreOwnershipPreflight).toBe('owned-by-another-account');
  });

  it('keeps the purchase locked after requestPurchase resolves until purchase success arrives', async () => {
    const firstCompletion = vi.fn();
    const secondCompletion = vi.fn();
    const provider = renderStoreKiloPassPurchaseProvider();

    const initialValue = provider.render();
    await initialValue.purchase(product, {
      onCompleted: () => {
        firstCompletion();
      },
    });
    const lockedValue = provider.render();

    expect(lockedValue.isPending).toBe(true);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);

    await lockedValue.purchase(product, {
      onCompleted: () => {
        secondCompletion();
      },
    });
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(1);

    mockedIap.handlers?.onPurchaseSuccess(createPurchase());
    await flushPromises();
    const releasedValue = provider.render();

    expect(releasedValue.isPending).toBe(false);
    expect(firstCompletion).toHaveBeenCalledTimes(1);
    expect(secondCompletion).not.toHaveBeenCalled();
  });

  it('releases the purchase lock when StoreKit reports a purchase error', async () => {
    const provider = renderStoreKiloPassPurchaseProvider();

    const initialValue = provider.render();
    await initialValue.purchase(product, { onCompleted: noop });
    const lockedValue = provider.render();

    expect(lockedValue.isPending).toBe(true);

    mockedIap.handlers?.onPurchaseError(new Error('StoreKit failed'));
    const releasedValue = provider.render();

    expect(releasedValue.isPending).toBe(false);
    await releasedValue.purchase(product);
    expect(mockedIap.requestPurchase).toHaveBeenCalledTimes(2);
  });

  it('toasts a purchase error when no screen owns inline feedback', async () => {
    const provider = renderStoreKiloPassPurchaseProvider();

    const initialValue = provider.render();
    await initialValue.purchase(product);

    mockedIap.handlers?.onPurchaseError(new Error('Untoasted screen check failed'));
    const releasedValue = provider.render();

    expect(toast.error).toHaveBeenCalledWith('Untoasted screen check failed');
    expect(releasedValue.errorMessage).toBe('Untoasted screen check failed');
  });

  it('suppresses the purchase-error toast while a screen owns inline feedback, and resumes once it unmounts', async () => {
    const provider = renderStoreKiloPassPurchaseProvider();
    const owner = mountInlineErrorOwnership();

    const initialValue = provider.render();
    await initialValue.purchase(product);
    mockedIap.handlers?.onPurchaseError(new Error('Inline banner check failed'));
    const ownedValue = provider.render();

    expect(toast.error).not.toHaveBeenCalled();
    expect(ownedValue.errorMessage).toBe('Inline banner check failed');

    owner.unmount();
    await ownedValue.purchase(product);
    mockedIap.handlers?.onPurchaseError(new Error('Untoasted screen check failed'));

    expect(toast.error).toHaveBeenCalledWith('Untoasted screen check failed');
  });

  it('ignores live StoreKit success for an unknown product', async () => {
    const onCompleted = vi.fn();
    const provider = renderStoreKiloPassPurchaseProvider();

    const initialValue = provider.render();
    await initialValue.purchase(product, {
      onCompleted: () => {
        onCompleted();
      },
    });

    mockedIap.handlers?.onPurchaseSuccess(
      createPurchase({
        id: 'other-purchase',
        productId: 'other.product',
        purchaseToken: 'other-signed-jws',
        transactionId: 'other-tx',
      })
    );
    await flushPromises();
    const releasedValue = provider.render();

    expect(mockedReactQuery.completeAppStorePurchase).not.toHaveBeenCalled();
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(releasedValue.isPending).toBe(false);
  });

  it('ignores live StoreKit success for a stale Kilo Pass product without releasing the active request', async () => {
    mockedReactQuery.mobileStoreProductsData = {
      appAccountToken: '550e8400-e29b-41d4-a716-446655440000',
      products: [
        { appleProductId: product.appleProductId },
        { appleProductId: 'com.kilo.pass.tier49.monthly' },
      ],
    };
    const onCompleted = vi.fn();
    const provider = renderStoreKiloPassPurchaseProvider();

    const initialValue = provider.render();
    await initialValue.purchase(product, {
      onCompleted: () => {
        onCompleted();
      },
    });

    mockedIap.handlers?.onPurchaseSuccess(
      createPurchase({
        id: 'stale-purchase',
        productId: 'com.kilo.pass.tier49.monthly',
        purchaseToken: 'stale-signed-jws',
        transactionId: 'stale-tx',
      })
    );
    await flushPromises();
    const stillPendingValue = provider.render();

    expect(mockedReactQuery.completeAppStorePurchase).not.toHaveBeenCalled();
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(stillPendingValue.isPending).toBe(true);

    const activePurchase = createPurchase();
    mockedIap.handlers?.onPurchaseSuccess(activePurchase);
    await flushPromises();
    const releasedValue = provider.render();

    expect(mockedReactQuery.completeAppStorePurchase).toHaveBeenCalledWith({
      signedTransactionJws: 'signed-jws',
    });
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({
      purchase: activePurchase,
      isConsumable: false,
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(releasedValue.isPending).toBe(false);
  });

  it('retries automatic recovery after backend completion fails', async () => {
    const purchase = createPurchase();
    mockedIap.availablePurchases = [purchase];
    mockedReactQuery.completeAppStorePurchase
      .mockRejectedValueOnce(new Error('backend failed'))
      .mockResolvedValueOnce({ alreadyProcessed: false });
    const provider = renderStoreKiloPassPurchaseProvider();

    provider.render();
    await flushPromises();

    expect(mockedReactQuery.completeAppStorePurchase).toHaveBeenCalledTimes(1);
    expect(mockedIap.finishTransaction).not.toHaveBeenCalled();
    expect(mockedReactQuery.invalidateQueries).not.toHaveBeenCalled();

    mockedIap.availablePurchases = [{ ...purchase }];
    provider.render();
    await flushPromises();

    expect(mockedReactQuery.completeAppStorePurchase).toHaveBeenCalledTimes(2);
    expect(mockedIap.finishTransaction).toHaveBeenCalledWith({ purchase, isConsumable: false });
    expect(mockedReactQuery.invalidateQueries).toHaveBeenCalled();
  });
});
