/* eslint-disable max-lines -- The IAP owner is the single `useIAP` call site and holds the purchase, restore, and recovery lifecycle for the Kilo Pass route. */
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchProducts as fetchIapProducts,
  getAvailablePurchases as getAvailableIapPurchases,
  type ProductOrSubscription,
  type ProductSubscription,
  useIAP,
} from 'expo-iap';

import {
  captureEvent,
  KILO_PASS_PURCHASE_FAILED_EVENT,
  KILO_PASS_PURCHASE_STARTED_EVENT,
} from '@/lib/analytics/posthog';
import { i18n } from '@/i18n';
import { useAuth } from '@/lib/auth/auth-context';
import {
  type AppStoreKiloPassProduct,
  type StoreKiloPassProduct,
} from '@/lib/kilo-pass/store-products';
import { getAppStoreKiloPassOwnershipPreflight } from '@/lib/kilo-pass/subscription-card-state';
import { useStoreKiloPassProducts } from '@/lib/kilo-pass/use-store-kilo-pass-products';
import {
  createAppStoreKiloPassPurchaseActions,
  getKiloPassPurchaseErrorMessage,
  getPurchaseCompletionId,
  isRecoverableKiloPassPurchase,
  showDedupedPurchaseError,
  type StoreKiloPassRestorePurchasesResult,
} from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { useTRPC } from '@/lib/trpc';

const isIapPlatform = Platform.OS === 'ios' || Platform.OS === 'android';
const isAndroid = Platform.OS === 'android';
// Shown when the store never answers the ownership lookup.
const STORE_CONNECTION_ERROR_MESSAGE_KEY = isAndroid
  ? 'kiloPass.couldNotConnectToPlay'
  : 'kiloPass.couldNotConnectToAppStore';

function getSubscriptionOfferToken(product: ProductSubscription): string | undefined {
  if (product.platform !== 'android') {
    return undefined;
  }
  const offers = product.subscriptionOffers;
  const monthly = offers.find(offer => offer.basePlanIdAndroid === 'monthly-v1');
  return (monthly ?? offers[0])?.offerTokenAndroid ?? undefined;
}

function toStoreKiloPassProduct(product: ProductOrSubscription): StoreKiloPassProduct | null {
  if (product.type !== 'subs') {
    return null;
  }

  return {
    id: product.id,
    displayPrice: product.displayPrice,
    title: product.title,
    description: product.description,
    offerToken: getSubscriptionOfferToken(product),
  };
}

async function fetchAppStoreSubscriptions(productSkus: string[]): Promise<StoreKiloPassProduct[]> {
  const products = await fetchIapProducts({
    skus: productSkus,
    type: 'subs',
  });

  const storeProducts: StoreKiloPassProduct[] = [];
  for (const product of products ?? []) {
    const storeProduct = toStoreKiloPassProduct(product);
    if (storeProduct) {
      storeProducts.push(storeProduct);
    }
  }

  return storeProducts;
}

type StoreKiloPassPurchaseOptions = {
  onCompleted?: () => void;
};

export type KiloPassNativeIapContextValue = {
  products: readonly AppStoreKiloPassProduct[];
  productsIsLoading: boolean;
  productsIsRefetching: boolean;
  productsError: string | null;
  productsRefetch: () => Promise<void>;
  purchase: (
    product: AppStoreKiloPassProduct,
    options?: StoreKiloPassPurchaseOptions
  ) => Promise<void>;
  restorePurchases: () => Promise<StoreKiloPassRestorePurchasesResult>;
  isPending: boolean;
  isRestoringPurchases: boolean;
  errorMessage: string | null;
  clearError: () => void;
  /** True when the store account already owns a pass on another Kilo account. */
  ownedByAnotherAccount: boolean;
  /** Apple product ID of a Kilo Pass this device already owns, if any. */
  ownedAppleProductId: string | null;
  /** Original transaction ID of that owned purchase, for server-side preflight. */
  ownedOriginalTransactionId: string | null;
  /** Google product ID of a Kilo Pass this device already owns, if any. */
  ownedGoogleProductId: string | null;
  /** Play purchase token of that owned purchase, for server-side preflight. */
  ownedGooglePurchaseToken: string | null;
  /** False until the store has answered once with what this device owns. */
  ownershipChecked: boolean;
  /** True when the last ownership lookup failed, so purchasing stays blocked. */
  ownershipCheckFailed: boolean;
  /** Runs the ownership lookup again after a failure. */
  retryOwnershipCheck: () => void;
};

const KiloPassNativeIapContext = createContext<KiloPassNativeIapContextValue | null>(null);

export function useKiloPassNativeIap(): KiloPassNativeIapContextValue {
  const context = useContext(KiloPassNativeIapContext);
  if (!context) {
    throw new Error('useKiloPassNativeIap must be used within KiloPassNativeIapOwner.');
  }

  return context;
}

/**
 * The single `useIAP` call site. Mounted only when the purchase presentation is
 * `native_iap` on iOS or Android, so there is never more than one IAP owner on
 * the Kilo Pass route.
 */
export function KiloPassNativeIapOwner({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { authEpoch } = useAuth();
  const [isRequestingPurchase, setIsRequestingPurchase] = useState(false);
  const [isRestoringPurchases, setIsRestoringPurchases] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const clearError = useCallback(() => {
    setErrorMessage(null);
  }, []);
  const [ownershipChecked, setOwnershipChecked] = useState(false);
  const [ownershipCheckFailed, setOwnershipCheckFailed] = useState(false);
  const [ownershipAttempt, setOwnershipAttempt] = useState(0);
  const retryOwnershipCheck = useCallback(() => {
    setOwnershipCheckFailed(false);
    setOwnershipAttempt(attempt => attempt + 1);
  }, []);
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const recoveryInFlightPurchaseIdsRef = useRef(new Set<string>());
  const activePurchaseRequestRef = useRef<{ sku: string } | null>(null);
  const pendingPurchaseCompletedCallbackRef = useRef<(() => void) | null>(null);

  const completeAppStorePurchase = useMutation(
    trpc.kiloPass.completeAppStorePurchase.mutationOptions()
  );
  const completePlayPurchase = useMutation(trpc.kiloPass.completePlayPurchase.mutationOptions());

  const releasePurchaseRequest = useCallback(() => {
    activePurchaseRequestRef.current = null;
    pendingPurchaseCompletedCallbackRef.current = null;
    setIsRequestingPurchase(false);
  }, []);

  const actionsRef = useIAP({
    onPurchaseError: error => {
      pendingPurchaseCompletedCallbackRef.current = null;
      releasePurchaseRequest();
      // A null message means the user cancelled — not a failure.
      const message = getKiloPassPurchaseErrorMessage(
        error,
        error.message,
        isAndroid ? 'play' : 'app_store'
      );
      if (message) {
        captureEvent(KILO_PASS_PURCHASE_FAILED_EVENT);
        showDedupedPurchaseError(message);
        setErrorMessage(message);
      }
    },
    onPurchaseSuccess: purchase => {
      if (
        !isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds, enabledGoogleProductIds)
      ) {
        releasePurchaseRequest();
        return;
      }

      if (activePurchaseRequestRef.current?.sku !== purchase.productId) {
        // The store answered the in-flight request with a transaction for another
        // SKU (an upgrade it refused re-delivers the current subscription), and no
        // purchase error follows. Release the request or the screen keeps its
        // "Completing purchase" state forever. The recovery effect below still
        // completes this transaction if it is not yet linked.
        releasePurchaseRequest();
        return;
      }

      void (async () => {
        try {
          await actions.handlePurchaseSuccess(purchase);
        } finally {
          releasePurchaseRequest();
        }
      })();
    },
  });
  const {
    availablePurchases,
    connected,
    finishTransaction,
    requestPurchase,
    restorePurchases: restoreStorePurchases,
    // The hook's own fetch is the only one that publishes into `availablePurchases`.
    // The module-level `getAvailablePurchases` returns the list without touching
    // hook state, which left every ownership check blind until a manual restore.
    getAvailablePurchases: refreshAvailablePurchases,
  } = actionsRef;

  // Server-backed fallback for the recovery SKU list: when the store fetch
  // fails or returns no products, recovery still needs the enabled product IDs
  // so charged-but-uncompleted transactions are completed instead of released.
  const serverProductsQuery = useQuery(trpc.kiloPass.getMobileStoreProducts.queryOptions());
  const productsQuery = useStoreKiloPassProducts({
    connected,
    fetchStoreProducts: fetchAppStoreSubscriptions,
  });
  const enabledAppleProductIds = useMemo(() => {
    if (productsQuery.products.length > 0) {
      return productsQuery.products.map(product => product.appleProductId);
    }
    return serverProductsQuery.data?.products.map(product => product.appleProductId) ?? [];
  }, [productsQuery.products, serverProductsQuery.data]);
  const enabledGoogleProductIds = useMemo(() => {
    if (productsQuery.products.length > 0) {
      return productsQuery.products.map(product => product.googleProductId);
    }
    return serverProductsQuery.data?.products.map(product => product.googleProductId) ?? [];
  }, [productsQuery.products, serverProductsQuery.data]);

  const ownedPurchase = useMemo(() => {
    if (!isIapPlatform) {
      return null;
    }
    return (
      availablePurchases.find(purchase =>
        isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds, enabledGoogleProductIds)
      ) ?? null
    );
  }, [availablePurchases, enabledAppleProductIds, enabledGoogleProductIds]);
  const ownedAppleProductId = isAndroid ? null : (ownedPurchase?.productId ?? null);
  const ownedGoogleProductId = isAndroid ? (ownedPurchase?.productId ?? null) : null;
  const ownedOriginalTransactionId =
    (ownedPurchase as { originalTransactionIdentifierIOS?: string | null } | null)
      ?.originalTransactionIdentifierIOS ?? null;
  const ownedGooglePurchaseToken = isAndroid ? (ownedPurchase?.purchaseToken ?? null) : null;

  const ownedByAnotherAccount = useMemo(
    () =>
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases,
        currentAppAccountToken: serverProductsQuery.data?.appAccountToken,
        enabledAppleProductIds,
        enabledGoogleProductIds,
        platformOS: Platform.OS,
      }) === 'owned-by-another-account',
    [availablePurchases, enabledAppleProductIds, enabledGoogleProductIds, serverProductsQuery.data]
  );

  const invalidateAfterCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getCreditHistory.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getPurchasePresentation.pathFilter()),
    ]);
  }, [queryClient, trpc]);

  const actions = useMemo(
    () =>
      createAppStoreKiloPassPurchaseActions({
        storefront: isAndroid ? 'play' : 'app_store',
        requestPurchase,
        getAvailablePurchases: getAvailableIapPurchases,
        restorePurchases: restoreStorePurchases,
        completeAppStorePurchase: completeAppStorePurchase.mutateAsync,
        completePlayPurchase: completePlayPurchase.mutateAsync,
        enabledAppleProductIds,
        enabledGoogleProductIds,
        loadEnabledAppleProductIds: async () => {
          const result = await queryClient.fetchQuery(
            trpc.kiloPass.getMobileStoreProducts.queryOptions()
          );
          return result.products.map(product => product.appleProductId);
        },
        loadEnabledGoogleProductIds: async () => {
          const result = await queryClient.fetchQuery(
            trpc.kiloPass.getMobileStoreProducts.queryOptions()
          );
          return result.products.map(product => product.googleProductId);
        },
        finishTransaction,
        invalidateAfterCompletion,
        onPurchaseCompleted: () => {
          // Completed is emitted server-side by the completion mutation — do not
          // re-add a client capture (double counting).
          setErrorMessage(null);
          const onCompleted = pendingPurchaseCompletedCallbackRef.current;
          pendingPurchaseCompletedCallbackRef.current = null;
          onCompleted?.();
        },
        setPendingPurchaseCompletedCallback: onCompleted => {
          pendingPurchaseCompletedCallbackRef.current = onCompleted;
        },
        showError: message => {
          showDedupedPurchaseError(message);
          setErrorMessage(message);
        },
      }),
    [
      completeAppStorePurchase.mutateAsync,
      completePlayPurchase.mutateAsync,
      enabledAppleProductIds,
      enabledGoogleProductIds,
      finishTransaction,
      invalidateAfterCompletion,
      queryClient,
      requestPurchase,
      restoreStorePurchases,
      trpc,
    ]
  );

  const startPurchase = useCallback(
    async (product: AppStoreKiloPassProduct, options: StoreKiloPassPurchaseOptions = {}) => {
      if (
        activePurchaseRequestRef.current ||
        completeAppStorePurchase.isPending ||
        completePlayPurchase.isPending
      ) {
        return;
      }

      activePurchaseRequestRef.current = {
        sku: isAndroid ? product.googleProductId : product.appleProductId,
      };
      setIsRequestingPurchase(true);
      setErrorMessage(null);
      captureEvent(KILO_PASS_PURCHASE_STARTED_EVENT);
      try {
        const requestStarted = await actions.purchase(product, options);
        if (!requestStarted) {
          releasePurchaseRequest();
        }
      } catch (error) {
        releasePurchaseRequest();
        throw error;
      }
    },
    [
      actions,
      completeAppStorePurchase.isPending,
      completePlayPurchase.isPending,
      releasePurchaseRequest,
    ]
  );

  const restorePurchases = useCallback(async (): Promise<StoreKiloPassRestorePurchasesResult> => {
    if (
      activePurchaseRequestRef.current ||
      isRestoringPurchases ||
      completeAppStorePurchase.isPending ||
      completePlayPurchase.isPending
    ) {
      return 'failed';
    }

    setIsRestoringPurchases(true);
    setErrorMessage(null);
    try {
      return await actions.restorePurchases();
    } finally {
      setIsRestoringPurchases(false);
    }
  }, [
    actions,
    completeAppStorePurchase.isPending,
    completePlayPurchase.isPending,
    isRestoringPurchases,
  ]);

  useEffect(() => {
    queryClient.removeQueries({ queryKey: ['kilo-pass', 'app-store-products'] });
  }, [authEpoch, queryClient]);

  useEffect(() => {
    if (!isIapPlatform) {
      setOwnershipChecked(true);
      return;
    }
    if (!connected) {
      return;
    }

    void (async () => {
      try {
        await refreshAvailablePurchases();
        // Purchases are only known after the store answers. Until then the screen
        // must not start a purchase: a device subscription owned by another Kilo
        // account would otherwise charge the user before any check can see it.
        setOwnershipChecked(true);
      } catch {
        // A failed lookup answers nothing, so purchasing stays blocked and the
        // screen offers a retry instead of charging the user blind.
        setOwnershipCheckFailed(true);
        setErrorMessage(i18n.t(STORE_CONNECTION_ERROR_MESSAGE_KEY));
      }
    })();
  }, [connected, ownershipAttempt, refreshAvailablePurchases]);

  useEffect(() => {
    if (
      availablePurchases.length === 0 ||
      (enabledAppleProductIds.length === 0 && enabledGoogleProductIds.length === 0)
    ) {
      return;
    }

    const unrecoveredPurchases = availablePurchases.filter(availablePurchase => {
      const id = getPurchaseCompletionId(availablePurchase);
      if (
        recoveredPurchaseIdsRef.current.has(id) ||
        recoveryInFlightPurchaseIdsRef.current.has(id)
      ) {
        return false;
      }
      recoveryInFlightPurchaseIdsRef.current.add(id);
      return true;
    });

    if (unrecoveredPurchases.length > 0) {
      void (async () => {
        try {
          const recoveredPurchases = await actions.recoverPurchases(unrecoveredPurchases);
          for (const recoveredPurchase of recoveredPurchases) {
            recoveredPurchaseIdsRef.current.add(getPurchaseCompletionId(recoveredPurchase));
          }
        } finally {
          for (const unrecoveredPurchase of unrecoveredPurchases) {
            recoveryInFlightPurchaseIdsRef.current.delete(
              getPurchaseCompletionId(unrecoveredPurchase)
            );
          }
        }
      })();
    }
  }, [actions, availablePurchases, enabledAppleProductIds.length, enabledGoogleProductIds.length]);

  const value = useMemo<KiloPassNativeIapContextValue>(
    () => ({
      products: productsQuery.products,
      productsIsLoading: productsQuery.isLoading,
      productsIsRefetching: productsQuery.isRefetching,
      productsError: productsQuery.errorMessage,
      productsRefetch: productsQuery.refetch,
      purchase: startPurchase,
      restorePurchases,
      isPending:
        isRequestingPurchase ||
        completeAppStorePurchase.isPending ||
        completePlayPurchase.isPending ||
        isRestoringPurchases,
      isRestoringPurchases,
      errorMessage,
      clearError,
      ownedByAnotherAccount,
      ownedAppleProductId,
      ownedOriginalTransactionId,
      ownedGoogleProductId,
      ownedGooglePurchaseToken,
      ownershipChecked,
      ownershipCheckFailed,
      retryOwnershipCheck,
    }),
    [
      clearError,
      completeAppStorePurchase.isPending,
      completePlayPurchase.isPending,
      errorMessage,
      isRequestingPurchase,
      isRestoringPurchases,
      ownedAppleProductId,
      ownedByAnotherAccount,
      ownedGoogleProductId,
      ownedGooglePurchaseToken,
      ownedOriginalTransactionId,
      ownershipChecked,
      ownershipCheckFailed,
      retryOwnershipCheck,
      productsQuery.errorMessage,
      productsQuery.isLoading,
      productsQuery.isRefetching,
      productsQuery.products,
      productsQuery.refetch,
      restorePurchases,
      startPurchase,
    ]
  );

  return createElement(KiloPassNativeIapContext.Provider, { value }, children);
}
