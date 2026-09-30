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
  fetchProducts as fetchIapProducts,
  type ProductOrSubscription,
  type Purchase,
  useIAP,
} from 'expo-iap';

import { i18n } from '@/i18n';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  type StoreCreditProduct,
  type StoreCreditProductListing,
} from '@/lib/credits/store-products';
import { getCreditStorefront } from '@/lib/credits/storefront';
import { fetchPendingStorePurchases } from '@/lib/iap/pending-store-purchases';
import {
  createStoreCreditPurchaseActions,
  getPurchaseCompletionId,
  getStoreCreditPurchaseErrorMessageKey,
  isRecoverableCreditPurchase,
  isStoreAlreadyOwnedError,
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
  /**
   * Restores the store connection after a failed initialization. expo-iap
   * removes its purchase-update listeners on that failure, and only the hook's
   * `reconnect()` re-registers them and restores `connected`, so a product
   * retry must await this before it can enable a purchasable row.
   */
  reconnectStore: () => Promise<boolean>;
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
 * The purchase request this owner is waiting on.
 *
 * `generation` advances with every started request, so a callback or finalizer
 * that outlives the request it belongs to releases only that one: an unrelated
 * store delivery, or a completion that resolves late, must not clear a newer
 * request that started while it was in flight.
 */
type ActivePurchaseRequest = { productId: string; generation: number };

/**
 * The one in-flight already-owned recovery, scoped to the auth epoch that
 * started it. The store error listener and the `requestPurchase` rejection both
 * report the same `AlreadyOwned`; sharing this promise gives them one decision.
 */
type InFlightOwnedRecovery = { epoch: number; promise: Promise<boolean> };

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
  const inFlightOwnedRecoveryRef = useRef<InFlightOwnedRecovery | null>(null);
  const activePurchaseRequestRef = useRef<ActivePurchaseRequest | null>(null);
  const purchaseRequestGenerationRef = useRef(0);
  // The auth epoch this owner belongs to. Sign-out/sign-in bumps it and this
  // screen unmounts, but a store delivery or completion already in flight keeps
  // running; `isAccountCurrent` reports whether this instance is still the
  // current session's, so the old one never posts or announces under the new.
  const authEpochRef = useRef(currentAuthEpoch());

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

  const releasePurchaseRequest = useCallback((generation: number) => {
    if (activePurchaseRequestRef.current?.generation !== generation) {
      // A newer request owns the slot (or none does). A callback or finalizer
      // that outlived its request must never clear one it did not start.
      return;
    }
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

  // Assigned below, once the purchase actions exist. The actions object holds
  // this as a stable indirection so its `recoverOwnedPurchase` hook can call the
  // latest implementation without depending on it in a cycle.
  const recoverOwnedPurchaseRef = useRef<(() => Promise<boolean>) | null>(null);

  const {
    connected,
    finishTransaction,
    reconnect: reconnectStore,
    requestPurchase,
  } = useIAP({
    onPurchaseError: error => {
      // A store error with no purchase in flight is the store failing to answer,
      // not a purchase the user started: the screen's store-unavailable banner
      // already reports that state, so a second "purchase failed" affordance
      // beside it would contradict the banner. Only a request this owner started
      // may surface as a purchase failure.
      const request = activePurchaseRequestRef.current;
      if (request === null) {
        return;
      }
      releasePurchaseRequest(request.generation);
      if (isStoreAlreadyOwnedError(error)) {
        // The store says the pack is already owned. For a consumable that is
        // usually this same user's unfinished purchase — charged, granted
        // nothing, never consumed — so recover it before saying anything; only
        // the backend's explicit ownership refusal earns the account copy.
        void recoverOwnedPurchaseRef.current?.();
        return;
      }
      // A null key means the user cancelled — not a failure.
      const key = getStoreCreditPurchaseErrorMessageKey(error, storefront);
      if (key) {
        showError(key);
      }
    },
    onPurchaseSuccess: purchase => {
      const request = activePurchaseRequestRef.current;
      if (request === null || request.productId !== purchase.productId) {
        // The store answered the in-flight request with another product's
        // transaction, or re-delivered an unfinished one (possibly after
        // `onPurchaseError` cleared the request). The recovery effect runs only
        // when the store connects, so a transaction delivered mid-session must
        // be completed here. It is not this owner's request, so completing it
        // must not release the request that is still in flight.
        void completeStorePurchaseInSession(purchase);
        return;
      }

      const generation = request.generation;
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
          // Release only the request this delivery owns: a completion that
          // resolves after an error released it must not clear a newer request.
          releasePurchaseRequest(generation);
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
        recoverOwnedPurchase: async () => (await recoverOwnedPurchaseRef.current?.()) ?? false,
        isAccountCurrent: () => isCurrentAuthEpoch(authEpochRef.current),
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

  // The store reported the pack as already owned. For a consumable credit pack
  // that is not proof of another Kilo account: a charge whose backend completion
  // failed stays owned but unconsumed, so retrying the same pack returns the code
  // for the same user. Look the outstanding transaction up and complete it —
  // announced, because the user just tried to buy — and let the backend's own
  // ownership refusal be the thing that names another account.
  //
  // The boolean means "handled", not "recovered": `true` once a completion was
  // attempted, which covers both the announced grant and the backend's refusal
  // shown through `notifyErrors`. `false` means no outstanding transaction was
  // found, so the caller still owes its own failure copy. Both triggers below
  // share this one decision.
  const recoverOwnedCreditPurchase = useCallback(async (): Promise<boolean> => {
    // One store `AlreadyOwned` failure reaches this owner twice: the `useIAP`
    // error listener and the `requestPurchase` rejection both report it, and a
    // pass per trigger would each read the other's dedupe as "nothing
    // recovered". Instead both await this one promise, so they share the same
    // decision — the second never sees a `false` the first did not.
    //
    // Keyed by the epoch that started it: a recovery belongs to the account
    // that asked for it, so a session change starts a fresh pass instead of
    // letting the new account join the old account's result.
    const epoch = authEpochRef.current;
    const inFlight = inFlightOwnedRecoveryRef.current;
    if (inFlight?.epoch === epoch) {
      return inFlight.promise;
    }

    const recovery = (async (): Promise<boolean> => {
      try {
        // A recovery belongs to the account that asked for it. If the session
        // changes while the store answers, the new account's own pass recovers.
        let pendingPurchases: Purchase[] = [];
        try {
          pendingPurchases = await fetchPendingStorePurchases(storefront);
        } catch {
          // The store cannot answer; the retry re-runs this.
          return false;
        }
        if (!isCurrentAuthEpoch(authEpochRef.current)) {
          return false;
        }
        const outstandingPurchases = pendingPurchases.filter(
          purchase =>
            isRecoverableCreditPurchase(
              purchase,
              creditPackAppleProductIds,
              creditPackGoogleProductIds
            ) &&
            !recoveredPurchaseIdsRef.current.has(getPurchaseCompletionId(purchase)) &&
            !recoveryInFlightPurchaseIdsRef.current.has(getPurchaseCompletionId(purchase))
        );
        if (outstandingPurchases.length === 0) {
          return false;
        }
        for (const purchase of outstandingPurchases) {
          recoveryInFlightPurchaseIdsRef.current.add(getPurchaseCompletionId(purchase));
        }
        try {
          const recoveredPurchases = await actions.recoverPurchases(outstandingPurchases, {
            notifyCompletion: true,
            notifyErrors: true,
          });
          for (const purchase of recoveredPurchases) {
            recoveredPurchaseIdsRef.current.add(getPurchaseCompletionId(purchase));
          }
          // Reaching here means the pass matched an outstanding transaction and
          // tried to complete it, so this pass owns the outcome: either the
          // credits were announced, or the backend's own refusal was shown
          // through `notifyErrors`. The purchase path must not add the generic
          // failure on top of that — which is why this is `true`, not
          // `recoveredPurchases.length > 0`: a refusal has no recovered
          // purchases but is still a handled `AlreadyOwned`.
          return true;
        } finally {
          for (const purchase of outstandingPurchases) {
            recoveryInFlightPurchaseIdsRef.current.delete(getPurchaseCompletionId(purchase));
          }
        }
      } finally {
        // This pass holds its epoch's slot until it settles — a same-epoch call
        // joins it rather than replacing it — so the epoch identifies the entry
        // to release. An epoch change has already installed a newer pass.
        if (inFlightOwnedRecoveryRef.current?.epoch === epoch) {
          inFlightOwnedRecoveryRef.current = null;
        }
      }
    })();

    inFlightOwnedRecoveryRef.current = { epoch, promise: recovery };
    const handled = await recovery;
    return handled;
  }, [actions, creditPackAppleProductIds, creditPackGoogleProductIds, storefront]);

  useEffect(() => {
    recoverOwnedPurchaseRef.current = recoverOwnedCreditPurchase;
  }, [recoverOwnedCreditPurchase]);

  const startPurchase = useCallback(
    async (pack: StoreCreditProduct): Promise<boolean> => {
      if (activePurchaseRequestRef.current || completingProductId) {
        return false;
      }
      const storeProductId = pack.storeProductId;
      if (!storeProductId || !appAccountToken) {
        return false;
      }

      // Capture the generation before any await: every finalizer below releases
      // exactly this request, never a newer one that started in the meantime.
      const generation = purchaseRequestGenerationRef.current + 1;
      purchaseRequestGenerationRef.current = generation;
      activePurchaseRequestRef.current = { productId: storeProductId, generation };
      setCompletingProductId(storeProductId);
      setErrorMessageKey(null);
      try {
        const requestStarted = await actions.purchase(pack);
        if (!requestStarted) {
          releasePurchaseRequest(generation);
        }
        return requestStarted;
      } catch (error) {
        releasePurchaseRequest(generation);
        throw error;
      }
    },
    [actions, appAccountToken, completingProductId, releasePurchaseRequest]
  );

  // Recover the purchases the store already charged but the backend has not
  // granted yet.
  //
  // The lookup is `fetchPendingStorePurchases`, which reads the transactions the
  // store still holds: the StoreKit payment queue on iOS — the only place an
  // unfinished consumable waits, and a place `getAvailablePurchases` does not
  // read — and Play's own query on Android. It is the store SDK's
  // value-returning call, not `useIAP().getAvailablePurchases`: the hook routes
  // every failed query to `console.error`, and in a dev build the LogBox it
  // raises sits on top of the screen's own store-unavailable banner — two error
  // affordances, the extra one a raw library message. A store that cannot answer
  // is exactly the state the screen reports inline, so its lookup fails silently
  // here.
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
        storePurchases = await fetchPendingStorePurchases(storefront);
      } catch {
        // The store is unreachable; the screen's inline banner says so. The
        // next connect retries.
        return;
      }
      if (recoveryRun.cancelled || !isCurrentAuthEpoch(authEpochRef.current)) {
        // The pass belongs to the session that started it. `cancelled` is only
        // set by passive cleanup, so the epoch is checked here too: a pass whose
        // store lookup answered after sign-out must not submit its completions
        // under the next account.
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
  }, [
    actions,
    connected,
    creditPackAppleProductIds.length,
    creditPackGoogleProductIds.length,
    storefront,
  ]);

  const value = useMemo<CreditNativeIapContextValue>(
    () => ({
      connected,
      fetchStoreProducts: fetchCreditStoreProducts,
      reconnectStore,
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
      reconnectStore,
      startPurchase,
    ]
  );

  return createElement(CreditNativeIapContext.Provider, { value }, children);
}
