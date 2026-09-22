/* eslint-disable max-lines -- The IAP owner is the single `useIAP` call site and holds the purchase and recovery lifecycle for the credits route. */

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
  getAvailablePurchases as fetchAvailablePurchases,
  fetchProducts as fetchIapProducts,
  type ProductOrSubscription,
  type Purchase,
  useIAP,
} from 'expo-iap';

import { i18n } from '@/i18n';
import {
  type StoreCreditProduct,
  type StoreCreditProductListing,
} from '@/lib/credits/store-products';
import {
  createStoreCreditPurchaseActions,
  getPurchaseCompletionId,
  getStoreCreditPurchaseErrorMessageKey,
  showDedupedPurchaseError,
} from '@/lib/credits/use-store-credit-purchase';
import { useTRPC } from '@/lib/trpc';

const isIapPlatform = Platform.OS === 'ios' || Platform.OS === 'android';
const isAndroid = Platform.OS === 'android';

function toCreditProductListing(product: ProductOrSubscription): StoreCreditProductListing | null {
  if (product.type !== 'in-app') {
    return null;
  }
  return { id: product.id, displayPrice: product.displayPrice };
}

async function fetchCreditStoreProducts(
  productSkus: string[]
): Promise<StoreCreditProductListing[]> {
  const products = await fetchIapProducts({
    skus: productSkus,
    type: 'in-app',
  });

  const listings: StoreCreditProductListing[] = [];
  for (const product of products ?? []) {
    const listing = toCreditProductListing(product);
    if (listing) {
      listings.push(listing);
    }
  }

  return listings;
}

export type CreditNativeIapContextValue = {
  connected: boolean;
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreCreditProductListing[]>;
  purchase: (pack: StoreCreditProduct) => Promise<boolean>;
  /** Store product id whose purchase or backend completion is in flight. */
  completingProductId: string | null;
  /** Catalog key of the last purchase error, or null. The screen translates it. */
  errorMessageKey: string | null;
  /**
   * Increments once per purchase the backend granted, so a screen can announce
   * the credit without guessing success from the in-flight state (a cancelled
   * purchase releases the request with no error key).
   */
  completedPurchaseCount: number;
  clearError: () => void;
};

const CreditNativeIapContext = createContext<CreditNativeIapContextValue | null>(null);

export function useCreditNativeIap(): CreditNativeIapContextValue {
  const context = useContext(CreditNativeIapContext);
  if (!context) {
    throw new Error('useCreditNativeIap must be used within CreditNativeIapOwner.');
  }

  return context;
}

/**
 * The single `useIAP` call site for the credits route.
 *
 * expo-iap registers its purchase listeners at module scope, so the app must
 * never mount two owners at once. The Kilo Pass route is popped before the
 * credits route can be pushed, so `KiloPassNativeIapOwner` and this owner never
 * coexist; a future route that mounts both would double-handle every purchase.
 */
export function CreditNativeIapOwner({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [completingProductId, setCompletingProductId] = useState<string | null>(null);
  const [errorMessageKey, setErrorMessageKey] = useState<string | null>(null);
  const [completedPurchaseCount, setCompletedPurchaseCount] = useState(0);
  const clearError = useCallback(() => {
    setErrorMessageKey(null);
  }, []);
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const recoveryInFlightPurchaseIdsRef = useRef(new Set<string>());
  const activePurchaseRequestRef = useRef<string | null>(null);

  const completeAppStorePurchase = useMutation(
    trpc.credits.completeAppStorePurchase.mutationOptions()
  );
  const completePlayPurchase = useMutation(trpc.credits.completePlayPurchase.mutationOptions());

  // Server-backed catalog: its account token is the one the store purchase must
  // carry, and its product ids drive recovery even when the store fetch failed.
  const serverProductsQuery = useQuery(trpc.credits.getMobileStoreProducts.queryOptions());
  const appAccountToken = serverProductsQuery.data?.appAccountToken ?? '';
  const creditPackAppleProductIds = useMemo(
    () => serverProductsQuery.data?.products.map(product => product.appleProductId) ?? [],
    [serverProductsQuery.data]
  );
  const creditPackGoogleProductIds = useMemo(
    () => serverProductsQuery.data?.products.map(product => product.googleProductId) ?? [],
    [serverProductsQuery.data]
  );

  const releasePurchaseRequest = useCallback(() => {
    activePurchaseRequestRef.current = null;
    setCompletingProductId(null);
  }, []);

  const showError = useCallback((key: string) => {
    // Translating an existing key, not authoring copy: the screen owns the
    // inline message and translates `errorMessageKey` itself.
    showDedupedPurchaseError(i18n.t(key));
    setErrorMessageKey(key);
  }, []);

  const invalidateAfterCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
    ]);
  }, [queryClient, trpc]);

  const { connected, finishTransaction, requestPurchase } = useIAP({
    onPurchaseError: error => {
      releasePurchaseRequest();
      // A null key means the user cancelled — not a failure.
      const key = getStoreCreditPurchaseErrorMessageKey(error, isAndroid ? 'play' : 'app_store');
      if (key) {
        showError(key);
      }
    },
    onPurchaseSuccess: purchase => {
      if (activePurchaseRequestRef.current !== purchase.productId) {
        // The store answered the in-flight request with another product's
        // transaction (or re-delivered an unfinished one); the recovery effect
        // completes it if it is a credit pack. Release the request or the row
        // keeps its "Completing purchase" state forever.
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

  const actions = useMemo(
    () =>
      createStoreCreditPurchaseActions({
        storefront: isAndroid ? 'play' : 'app_store',
        appAccountToken,
        creditPackAppleProductIds,
        creditPackGoogleProductIds,
        requestPurchase,
        completeAppStorePurchase: completeAppStorePurchase.mutateAsync,
        completePlayPurchase: completePlayPurchase.mutateAsync,
        finishTransaction,
        invalidateAfterCompletion,
        onPurchaseCompleted: () => {
          setErrorMessageKey(null);
          setCompletedPurchaseCount(count => count + 1);
        },
        showError,
      }),
    [
      appAccountToken,
      completeAppStorePurchase.mutateAsync,
      completePlayPurchase.mutateAsync,
      creditPackAppleProductIds,
      creditPackGoogleProductIds,
      finishTransaction,
      invalidateAfterCompletion,
      requestPurchase,
      showError,
    ]
  );

  const startPurchase = useCallback(
    async (pack: StoreCreditProduct): Promise<boolean> => {
      if (activePurchaseRequestRef.current || completingProductId) {
        return false;
      }
      const storeProductId = pack.storeProductId;
      if (!storeProductId || !appAccountToken) {
        return false;
      }

      activePurchaseRequestRef.current = storeProductId;
      setCompletingProductId(storeProductId);
      setErrorMessageKey(null);
      try {
        const requestStarted = await actions.purchase(pack);
        if (!requestStarted) {
          releasePurchaseRequest();
        }
        return requestStarted;
      } catch (error) {
        releasePurchaseRequest();
        throw error;
      }
    },
    [actions, appAccountToken, completingProductId, releasePurchaseRequest]
  );

  // Recover the purchases the store already charged but the backend has not
  // granted yet.
  //
  // The lookup uses the store SDK's value-returning `getAvailablePurchases`,
  // not `useIAP().getAvailablePurchases`: the hook routes every failed query to
  // `console.error`, and in a dev build the LogBox it raises sits on top of the
  // screen's own store-unavailable banner — two error affordances, the extra one
  // a raw library message. A store that cannot answer is exactly the state the
  // screen reports inline, so its lookup must fail silently here.
  useEffect(() => {
    if (!isIapPlatform || !connected) {
      return undefined;
    }
    if (creditPackAppleProductIds.length === 0 && creditPackGoogleProductIds.length === 0) {
      return undefined;
    }

    const recoveryRun = { cancelled: false };
    void (async () => {
      let storePurchases: Purchase[] = [];
      try {
        storePurchases = await fetchAvailablePurchases();
      } catch {
        // The store is unreachable; the screen's inline banner says so. The
        // next connect retries.
        return;
      }
      if (recoveryRun.cancelled) {
        return;
      }

      const unrecoveredPurchases = storePurchases.filter(availablePurchase => {
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
      if (unrecoveredPurchases.length === 0) {
        return;
      }

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

    return () => {
      recoveryRun.cancelled = true;
    };
  }, [actions, connected, creditPackAppleProductIds.length, creditPackGoogleProductIds.length]);

  const value = useMemo<CreditNativeIapContextValue>(
    () => ({
      connected,
      fetchStoreProducts: fetchCreditStoreProducts,
      purchase: startPurchase,
      completingProductId,
      errorMessageKey,
      completedPurchaseCount,
      clearError,
    }),
    [
      clearError,
      completedPurchaseCount,
      completingProductId,
      connected,
      errorMessageKey,
      startPurchase,
    ]
  );

  return createElement(CreditNativeIapContext.Provider, { value }, children);
}
