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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchProducts as fetchIapProducts,
  getAvailablePurchases as getAvailableIapPurchases,
  type ProductOrSubscription,
  useIAP,
} from 'expo-iap';

import {
  captureEvent,
  KILO_PASS_PURCHASE_FAILED_EVENT,
  KILO_PASS_PURCHASE_STARTED_EVENT,
} from '@/lib/analytics/posthog';
import { useAuth } from '@/lib/auth/auth-context';
import {
  type AppStoreKiloPassProduct,
  type StoreKiloPassProduct,
} from '@/lib/kilo-pass/store-products';
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

function toStoreKiloPassProduct(product: ProductOrSubscription): StoreKiloPassProduct | null {
  if (product.type !== 'subs') {
    return null;
  }

  return {
    id: product.id,
    displayPrice: product.displayPrice,
    title: product.title,
    description: product.description,
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
 * `native_iap` on iOS, so Android never initializes StoreKit and there is never
 * more than one IAP owner on the Kilo Pass route.
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
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const recoveryInFlightPurchaseIdsRef = useRef(new Set<string>());
  const activePurchaseRequestRef = useRef<{ sku: string } | null>(null);
  const pendingPurchaseCompletedCallbackRef = useRef<(() => void) | null>(null);

  const completeAppStorePurchase = useMutation(
    trpc.kiloPass.completeAppStorePurchase.mutationOptions()
  );

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
      const message = getKiloPassPurchaseErrorMessage(error, error.message);
      if (message) {
        captureEvent(KILO_PASS_PURCHASE_FAILED_EVENT);
        showDedupedPurchaseError(message);
        setErrorMessage(message);
      }
    },
    onPurchaseSuccess: purchase => {
      if (!isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds)) {
        releasePurchaseRequest();
        return;
      }

      if (activePurchaseRequestRef.current?.sku !== purchase.productId) {
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
  } = actionsRef;

  const productsQuery = useStoreKiloPassProducts({
    connected,
    fetchStoreProducts: fetchAppStoreSubscriptions,
  });
  const enabledAppleProductIds = useMemo(
    () => productsQuery.products.map(product => product.appleProductId),
    [productsQuery.products]
  );

  const invalidateAfterCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getCreditHistory.pathFilter()),
    ]);
  }, [queryClient, trpc]);

  const actions = useMemo(
    () =>
      createAppStoreKiloPassPurchaseActions({
        requestPurchase,
        getAvailablePurchases: getAvailableIapPurchases,
        restorePurchases: restoreStorePurchases,
        completeAppStorePurchase: completeAppStorePurchase.mutateAsync,
        enabledAppleProductIds,
        loadEnabledAppleProductIds: async () => {
          const result = await queryClient.fetchQuery(
            trpc.kiloPass.getMobileStoreProducts.queryOptions()
          );
          return result.products.map(product => product.appleProductId);
        },
        finishTransaction,
        invalidateAfterCompletion,
        onPurchaseCompleted: () => {
          // Completed is emitted server-side by completeAppStorePurchase — do not
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
      enabledAppleProductIds,
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
      if (activePurchaseRequestRef.current || completeAppStorePurchase.isPending) {
        return;
      }

      activePurchaseRequestRef.current = { sku: product.appleProductId };
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
    [actions, completeAppStorePurchase.isPending, releasePurchaseRequest]
  );

  const restorePurchases = useCallback(async (): Promise<StoreKiloPassRestorePurchasesResult> => {
    if (
      activePurchaseRequestRef.current ||
      isRestoringPurchases ||
      completeAppStorePurchase.isPending
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
  }, [actions, completeAppStorePurchase.isPending, isRestoringPurchases]);

  useEffect(() => {
    queryClient.removeQueries({ queryKey: ['kilo-pass', 'app-store-products'] });
  }, [authEpoch, queryClient]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    void getAvailableIapPurchases();
  }, [connected]);

  useEffect(() => {
    if (availablePurchases.length === 0 || enabledAppleProductIds.length === 0) {
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
  }, [actions, availablePurchases, enabledAppleProductIds.length]);

  const value = useMemo<KiloPassNativeIapContextValue>(
    () => ({
      products: productsQuery.products,
      productsIsLoading: productsQuery.isLoading,
      productsIsRefetching: productsQuery.isRefetching,
      productsError: productsQuery.errorMessage,
      productsRefetch: productsQuery.refetch,
      purchase: startPurchase,
      restorePurchases,
      isPending: isRequestingPurchase || completeAppStorePurchase.isPending || isRestoringPurchases,
      isRestoringPurchases,
      errorMessage,
      clearError,
    }),
    [
      clearError,
      completeAppStorePurchase.isPending,
      errorMessage,
      isRequestingPurchase,
      isRestoringPurchases,
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
