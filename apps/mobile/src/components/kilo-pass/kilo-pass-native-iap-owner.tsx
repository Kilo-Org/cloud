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
  endConnection,
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
import {
  backendStoreKiloPassProductsQueryOptions,
  useStoreKiloPassProducts,
} from '@/lib/kilo-pass/use-store-kilo-pass-products';
import {
  createAppStoreKiloPassPurchaseActions,
  getKiloPassPurchaseErrorMessage,
  getPurchaseCompletionId,
  isRecoverableKiloPassPurchase,
  showDedupedPurchaseError,
  type StoreKiloPassPurchaseOptions,
  type StoreKiloPassRestorePurchasesResult,
} from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import { useTRPC } from '@/lib/trpc';

const isIapPlatform = Platform.OS === 'ios' || Platform.OS === 'android';
const isAndroid = Platform.OS === 'android';
// Shown when the store never answers the ownership lookup.
const STORE_CONNECTION_ERROR_MESSAGE_KEY = isAndroid
  ? 'kiloPass.couldNotConnectToPlay'
  : 'kiloPass.couldNotConnectToAppStore';
// A store that just reconnected can report the handshake before its billing
// service serves product queries, so the reload that follows the retry can fail
// against a store that is already up. Reload it across the store-product hook's
// own connection wait, sized to the store reconnect bound below, before the
// products-unavailable card is left standing.
const PRODUCTS_RETRY_ATTEMPTS = 8;
const PRODUCTS_RETRY_DELAY_MS = 1500;
// Bounds the whole catalog reload of one retry. A forced fetch can stay pending
// forever — React Query pauses it while the app is offline, and the native store
// call has no timeout — so without this the retry's busy state would never clear
// and the button would sit disabled on "Trying again" with no way back. A reload
// that lands after the bound still writes the query cache, so a store that
// answers late still clears the card.
const PRODUCTS_RELOAD_BOUND_MS = 15000;
// A store whose billing service never answers leaves `reconnect` pending. Bound
// the handshake at the store-product hook's own connection wait so the catalog
// reload still runs: a store that answers product queries clears the
// products-unavailable card even though the handshake never reported back, and a
// handshake that lands after the bound re-enables the hook's own query.
const STORE_RECONNECT_BOUND_MS = 8000;

async function waitForProductsRetry(ms: number): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Awaits `work` for at most `ms`. Bounds the store handshake: a `reconnect`
 * whose billing service never answers must not hold the catalog reload. The
 * losing wait is cancelled so no timer outlives the retry.
 */
async function waitForAtMost(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Awaits `work` for at most `ms`, returning its value, or `undefined` when the
 * bound wins. Unlike `waitForAtMost`, the caller needs the value to tell an
 * answered reload from one that ran out of time. The losing work keeps running
 * and still lands in the query cache.
 */
async function settleForAtMost<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Reloads the catalog until it answers, a bounded number of times. The first
 * query after a fresh store handshake can fail while the billing service is
 * still coming up, so a single refetch is not enough to clear the
 * products-unavailable card. Bounded so a store that is truly down still falls
 * through to the store-product hook's connection wait. Reports whether the
 * catalog answered.
 */
async function reloadProductsUntilAnswered(
  reload: () => Promise<{ isError: boolean }>,
  attemptsLeft: number
): Promise<boolean> {
  const result = await reload();
  if (!result.isError) {
    return true;
  }
  if (attemptsLeft <= 1) {
    return false;
  }
  await waitForProductsRetry(PRODUCTS_RETRY_DELAY_MS);
  return reloadProductsUntilAnswered(reload, attemptsLeft - 1);
}

/**
 * The screen shows one store-failure surface. The store-connection message is
 * the same failure the products-unavailable card states, so the screen must
 * recognize it without comparing translated copy: the app language can change
 * while the message is on screen, and a copy comparison then fails and brings
 * the duplicate line back. The flag travels with the message so they can never
 * drift apart.
 */
type KiloPassIapError = { message: string; storeConnection: boolean };

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

/**
 * Every product identifier recovery, restore, and ownership may act on: the ones
 * the backend advertises unioned with the ones the store resolved. A store that
 * cannot query one tier must not drop it from this set — an owned but
 * uncompleted transaction for that tier would be released instead of completed,
 * costing the user a purchase they paid for.
 */
function getEnabledProductIds(
  backendProductIds: readonly string[],
  storeProductIds: readonly string[]
): string[] {
  return [...new Set([...backendProductIds, ...storeProductIds])];
}

export type KiloPassNativeIapContextValue = {
  products: readonly AppStoreKiloPassProduct[];
  productsIsLoading: boolean;
  productsIsRefetching: boolean;
  productsError: string | null;
  /** Re-runs the store handshake, then retries the catalog fetch. */
  productsRefetch: () => Promise<void>;
  purchase: (
    product: AppStoreKiloPassProduct,
    options?: StoreKiloPassPurchaseOptions
  ) => Promise<void>;
  restorePurchases: () => Promise<StoreKiloPassRestorePurchasesResult>;
  isPending: boolean;
  isRestoringPurchases: boolean;
  errorMessage: string | null;
  /** True when `errorMessage` is the store-connection message, not a purchase or restore failure. */
  storeConnectionError: boolean;
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
 * The single `useIAP` call site. Mounted once at the Kilo Pass route entry on
 * iOS and Android — before the presentation query resolves — so the native
 * store connection and the store-product query overlap that request instead of
 * queuing behind it. It wraps every presentation variant (loading, error,
 * non-native, and native-IAP) so it never unmounts and remounts as the query
 * settles; only the purchasable content is gated on `native_iap`.
 */
export function KiloPassNativeIapOwner({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { authEpoch } = useAuth();
  const [isRequestingPurchase, setIsRequestingPurchase] = useState(false);
  const [isRestoringPurchases, setIsRestoringPurchases] = useState(false);
  const [iapError, setIapError] = useState<KiloPassIapError | null>(null);
  const clearError = useCallback(() => {
    setIapError(null);
  }, []);
  const [ownershipChecked, setOwnershipChecked] = useState(false);
  const [ownershipCheckFailed, setOwnershipCheckFailed] = useState(false);
  const [ownershipAttempt, setOwnershipAttempt] = useState(0);
  // True for the whole products retry: the native handshake and the bounded wait
  // for `connected` run before the store-product hook's `refetch` can raise its
  // own busy flag, so without this the retry button stays enabled and labelled
  // "Try again" for that window and the user can fire it repeatedly.
  const [isRetryingProducts, setIsRetryingProducts] = useState(false);
  const retryOwnershipCheck = useCallback(() => {
    setOwnershipCheckFailed(false);
    setOwnershipAttempt(attempt => attempt + 1);
  }, []);
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const recoveryInFlightPurchaseIdsRef = useRef(new Set<string>());
  const activePurchaseRequestRef = useRef<{ sku: string; replacedSku?: string } | null>(null);
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
        setIapError({ message, storeConnection: false });
      }
    },
    onPurchaseSuccess: purchase => {
      if (
        !isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds, enabledGoogleProductIds)
      ) {
        releasePurchaseRequest();
        return;
      }

      if (
        activePurchaseRequestRef.current?.sku !== purchase.productId &&
        activePurchaseRequestRef.current?.replacedSku !== purchase.productId
      ) {
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
    // Re-runs the store handshake after the initial auto-connect failed. `useIAP`
    // only connects once on mount, so without this the failed connection never
    // recovers while the route stays open.
    reconnect,
    restorePurchases: restoreStorePurchases,
    // The hook's own fetch is the only one that publishes into `availablePurchases`.
    // The module-level `getAvailablePurchases` returns the list without touching
    // hook state, which left every ownership check blind until a manual restore.
    getAvailablePurchases: refreshAvailablePurchases,
  } = actionsRef;

  // The store answered, so the ownership lookup is no longer in doubt. Runs on
  // mount and again after a store reconnect, because the lookup that ran against
  // the dead connection raised the store-connection message.
  const checkOwnership = useCallback(async () => {
    try {
      await refreshAvailablePurchases();
      // Purchases are only known after the store answers. Until then the screen
      // must not start a purchase: a device subscription owned by another Kilo
      // account would otherwise charge the user before any check can see it.
      setOwnershipChecked(true);
      setOwnershipCheckFailed(false);
      // The lookup that failed before has now answered, so the store-connection
      // message it raised no longer describes this screen. Any other failure
      // (a purchase or a restore message) is still true and stays.
      setIapError(current => (current?.storeConnection ? null : current));
    } catch {
      // A failed lookup answers nothing, so purchasing stays blocked and the
      // screen offers a retry instead of charging the user blind.
      setOwnershipCheckFailed(true);
      setIapError({ message: i18n.t(STORE_CONNECTION_ERROR_MESSAGE_KEY), storeConnection: true });
    }
  }, [refreshAvailablePurchases]);

  // The backend's product identifiers, unioned by the enabled-id sets below with
  // the store-resolved ones, so a tier the store cannot query still has its
  // charged-but-uncompleted transactions completed instead of released. Shares
  // the store-product cache lifetime, so a re-entered route reads the catalog
  // instead of paying the request again.
  const serverProductsQuery = useQuery(backendStoreKiloPassProductsQueryOptions(trpc));
  const productsQuery = useStoreKiloPassProducts({
    connected,
    fetchStoreProducts: fetchAppStoreSubscriptions,
  });
  // The products-unavailable "Try again" is also the store-connection retry. The
  // store-product hook's `refetch` only restarts its bounded wait for the
  // connection; it never re-runs the native handshake, so it keeps failing
  // against a store whose billing service is gone. End the cached connection
  // first: `initConnection` short-circuits while expo-iap's native ready flag is
  // still set (even when the owner renders `connected` false), so without
  // `endConnection` the reconnect reports success without rebinding a dead
  // billing client and the catalog keeps failing. Then reload the catalog through
  // the hook's force path rather than its gated `refetch`: `reconnect` can report
  // failure (or success without the owner rendering `connected`), and the hook's
  // query is enabled only while `connected` is true, so the force path is what
  // fetches from a store that answers product queries. A store whose billing
  // service comes up before, during, or after the handshake is then caught,
  // because the reload runs alongside the handshake instead of waiting for it to
  // settle. The handshake, the connection teardown, and the reload are each
  // bounded, so a `reconnect` or fetch that never answers cannot hold the retry's
  // busy state: the reload keeps running past the bound and still lands in the
  // query cache.
  const { refetchForced: refetchProductsForced } = productsQuery;
  const retryProducts = useCallback(async () => {
    setIsRetryingProducts(true);
    try {
      // Bound the teardown too. `endConnection` queues on expo-iap's native
      // connection lock, so a store that never answers it must not hold the
      // reconnect and reload that recover the catalog.
      try {
        await waitForAtMost(STORE_RECONNECT_BOUND_MS, endConnection());
      } catch {
        // Nothing to end when no connection ever established; the reconnect
        // below is the part that matters.
      }
      // Start the handshake and the catalog reload together, so a store that
      // answers product queries mid-handshake clears the card instead of waiting
      // out the handshake first and then missing the reload budget.
      const handshake = waitForAtMost(STORE_RECONNECT_BOUND_MS, reconnect());
      const answered =
        (await settleForAtMost(
          PRODUCTS_RELOAD_BOUND_MS,
          reloadProductsUntilAnswered(refetchProductsForced, PRODUCTS_RETRY_ATTEMPTS)
        )) ?? false;
      await handshake;
      // The screen's own ownership retry runs before the reconnect lands and
      // fails again against the dead store, so it is re-run here, against the
      // store that answered, to clear its failure together with the catalog.
      if (answered) {
        await checkOwnership();
      }
    } finally {
      setIsRetryingProducts(false);
    }
  }, [checkOwnership, reconnect, refetchProductsForced]);
  const enabledAppleProductIds = useMemo(
    () =>
      getEnabledProductIds(
        serverProductsQuery.data?.products.map(product => product.appleProductId) ?? [],
        productsQuery.products.map(product => product.appleProductId)
      ),
    [productsQuery.products, serverProductsQuery.data]
  );
  const enabledGoogleProductIds = useMemo(
    () =>
      getEnabledProductIds(
        serverProductsQuery.data?.products.map(product => product.googleProductId) ?? [],
        productsQuery.products.map(product => product.googleProductId)
      ),
    [productsQuery.products, serverProductsQuery.data]
  );

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
    ownedPurchase && 'originalTransactionIdentifierIOS' in ownedPurchase
      ? (ownedPurchase.originalTransactionIdentifierIOS ?? null)
      : null;
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
            backendStoreKiloPassProductsQueryOptions(trpc)
          );
          return getEnabledProductIds(
            result.products.map(product => product.appleProductId),
            enabledAppleProductIds
          );
        },
        loadEnabledGoogleProductIds: async () => {
          const result = await queryClient.fetchQuery(
            backendStoreKiloPassProductsQueryOptions(trpc)
          );
          return getEnabledProductIds(
            result.products.map(product => product.googleProductId),
            enabledGoogleProductIds
          );
        },
        finishTransaction,
        invalidateAfterCompletion,
        onPurchaseCompleted: () => {
          // Completed is emitted server-side by the completion mutation — do not
          // re-add a client capture (double counting).
          setIapError(null);
          const onCompleted = pendingPurchaseCompletedCallbackRef.current;
          pendingPurchaseCompletedCallbackRef.current = null;
          onCompleted?.();
        },
        setPendingPurchaseCompletedCallback: onCompleted => {
          pendingPurchaseCompletedCallbackRef.current = onCompleted;
        },
        showError: message => {
          showDedupedPurchaseError(message);
          setIapError({ message, storeConnection: false });
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
        replacedSku: options.googleReplacement?.productId,
      };
      setIsRequestingPurchase(true);
      setIapError(null);
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
    setIapError(null);
    try {
      const result = await actions.restorePurchases();
      if (result !== 'failed') {
        // A restore that answered proves the store is reachable, so the
        // ownership lookup is no longer in doubt. Clear the failure or the
        // screen keeps claiming the store is unreachable over its own
        // "restored"/"no purchases" feedback and offers a retry that cannot
        // fix anything.
        setOwnershipChecked(true);
        setOwnershipCheckFailed(false);
      }
      return result;
    } finally {
      setIsRestoringPurchases(false);
    }
  }, [
    actions,
    completeAppStorePurchase.isPending,
    completePlayPurchase.isPending,
    isRestoringPurchases,
  ]);

  // Drop the store-product caches only when the signed-in account actually
  // changes. Running this on the owner's first mount deleted the 5-minute entry
  // `useStoreKiloPassProducts` deliberately keeps, so every re-entry re-ran the
  // native `fetchProducts` plus `getMobileStoreProducts` and repainted the tier
  // skeletons for products the app already had. The backend catalog carries the
  // account's `appAccountToken` and now lives for the same window, so it is
  // dropped with the entry it feeds instead of leaking the previous account's.
  const previousAuthEpochRef = useRef(authEpoch);
  useEffect(() => {
    if (previousAuthEpochRef.current === authEpoch) {
      return;
    }
    previousAuthEpochRef.current = authEpoch;
    queryClient.removeQueries(trpc.kiloPass.getMobileStoreProducts.pathFilter());
    queryClient.removeQueries({ queryKey: ['kilo-pass', 'app-store-products'] });
  }, [authEpoch, queryClient, trpc]);

  useEffect(() => {
    if (!isIapPlatform) {
      setOwnershipChecked(true);
      return;
    }
    if (!connected) {
      return;
    }

    void checkOwnership();
  }, [checkOwnership, connected, ownershipAttempt]);

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
      productsIsRefetching: productsQuery.isRefetching || isRetryingProducts,
      productsError: productsQuery.errorMessage,
      productsRefetch: retryProducts,
      purchase: startPurchase,
      restorePurchases,
      isPending:
        isRequestingPurchase ||
        completeAppStorePurchase.isPending ||
        completePlayPurchase.isPending ||
        isRestoringPurchases,
      isRestoringPurchases,
      errorMessage: iapError?.message ?? null,
      storeConnectionError: iapError?.storeConnection ?? false,
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
      iapError,
      isRequestingPurchase,
      isRestoringPurchases,
      isRetryingProducts,
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
      restorePurchases,
      retryProducts,
      startPurchase,
    ]
  );

  return createElement(KiloPassNativeIapContext.Provider, { value }, children);
}
