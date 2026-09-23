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
import { getCreditStorefront } from '@/lib/credits/storefront';
import {
  createStoreCreditPurchaseActions,
  getPurchaseCompletionId,
  getStoreCreditPurchaseErrorMessageKey,
  isRecoverableCreditPurchase,
  showDedupedPurchaseError,
} from '@/lib/credits/use-store-credit-purchase';
import { useTRPC } from '@/lib/trpc';

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
  // The one platform-derived value in the flow: the store this device can buy
  // from. Read from the shared helper so the owner, the screen and the catalog
  // hook can never pick two different storefronts.
  const storefront = getCreditStorefront();
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
      // A store error with no purchase in flight is the store failing to answer,
      // not a purchase the user started: the screen's store-unavailable banner
      // already reports that state, so a second "purchase failed" affordance
      // beside it would contradict the banner. Only a request this owner started
      // may surface as a purchase failure.
      const purchaseWasInFlight = activePurchaseRequestRef.current !== null;
      releasePurchaseRequest();
      if (!purchaseWasInFlight) {
        return;
      }
      // A null key means the user cancelled — not a failure.
      const key = getStoreCreditPurchaseErrorMessageKey(error, storefront);
      if (key) {
        showError(key);
      }
    },
    onPurchaseSuccess: purchase => {
      if (activePurchaseRequestRef.current !== purchase.productId) {
        // The store answered the in-flight request with another product's
        // transaction, or re-delivered an unfinished one (possibly after
        // `onPurchaseError` cleared the request). The recovery effect runs only
        // when the store connects, so a transaction delivered mid-session must
        // be completed here: releasing the request and waiting for that effect
        // leaves the user charged and uncredited until the screen remounts.
        releasePurchaseRequest();
        void completeStorePurchaseInSession(purchase);
        return;
      }

      void (async () => {
        try {
          const completed = await actions.handlePurchaseSuccess(purchase);
          if (completed) {
            // The store can re-deliver this transaction (its `finishTransaction`
            // failed and the error was swallowed). Record the id the request
            // completed, so the re-delivery path skips it instead of completing
            // and announcing the same purchase twice.
            recoveredPurchaseIdsRef.current.add(getPurchaseCompletionId(purchase));
          }
        } finally {
          releasePurchaseRequest();
        }
      })();
    },
  });

  const actions = useMemo(
    () =>
      createStoreCreditPurchaseActions({
        storefront,
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
      storefront,
    ]
  );

  // Completes one transaction the store delivered outside a request this owner
  // started (a re-delivered or deferred purchase). Recovery only runs when the
  // store connects, so the purchase callback must complete it in-session or the
  // user stays charged and uncredited until the screen remounts.
  const completeStorePurchaseInSession = useCallback(
    async (purchase: Purchase) => {
      if (
        !isRecoverableCreditPurchase(
          purchase,
          creditPackAppleProductIds,
          creditPackGoogleProductIds
        )
      ) {
        return;
      }
      const id = getPurchaseCompletionId(purchase);
      if (
        recoveredPurchaseIdsRef.current.has(id) ||
        recoveryInFlightPurchaseIdsRef.current.has(id)
      ) {
        return;
      }
      recoveryInFlightPurchaseIdsRef.current.add(id);
      try {
        // The store delivered this transaction on its own, so the completion
        // announces itself; a failure stays silent because the recovery pass
        // retries it on the next connect.
        const completed = await actions.handlePurchaseSuccess(purchase, {
          notifyErrors: false,
        });
        if (completed) {
          recoveredPurchaseIdsRef.current.add(id);
        }
      } finally {
        recoveryInFlightPurchaseIdsRef.current.delete(id);
      }
    },
    [actions, creditPackAppleProductIds, creditPackGoogleProductIds]
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
    if (!connected) {
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
