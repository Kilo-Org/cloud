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
  type RequestPurchaseResult,
  useIAP,
} from 'expo-iap';

import { i18n } from '@/i18n';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  admitCreditPurchaseIntent,
  type CreditPurchaseIntent,
  identifyCreditPurchaseTransaction,
  markCreditPurchaseIntentDispatched,
  matchesCreditPurchaseIntent,
  ownsCreditPurchaseIntent,
  restoreCreditPurchaseIntent,
  retireCreditPurchaseIntent,
} from '@/lib/credits/credit-purchase-intent';
import {
  type StoreCreditProduct,
  type StoreCreditProductListing,
  type StoreProductFetchOptions,
} from '@/lib/credits/store-products';
import { getCreditStorefront } from '@/lib/credits/storefront';
import { fetchPendingStorePurchases } from '@/lib/iap/pending-store-purchases';
import { withStoreDeadline } from '@/lib/iap/store-call-deadline';
import {
  createStoreCreditPurchaseActions,
  type CreditPurchaseFailure,
  creditStoreTimeoutKey,
  getPurchaseCompletionId,
  isRecoverableCreditPurchase,
  isStoreNotReadyError,
  isStorePendingPurchaseError,
  showDedupedPurchaseError,
} from '@/lib/credits/use-store-credit-purchase';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { type SurfaceAttempt } from '@/lib/surface-feedback';
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
  fetchStoreProducts: (
    productSkus: string[],
    options?: StoreProductFetchOptions
  ) => Promise<readonly StoreCreditProductListing[]>;
  /**
   * Restores the store connection after a failed initialization. expo-iap
   * removes its purchase-update listeners on that failure, and only the hook's
   * `reconnect()` re-registers them and restores `connected`, so a product
   * retry must await this before it can enable a purchasable row.
   */
  reconnectStore: () => Promise<boolean>;
  purchase: (pack: StoreCreditProduct) => Promise<boolean>;
  reconcilePurchase: (pack: StoreCreditProduct) => Promise<boolean>;
  buyAgain: (pack: StoreCreditProduct) => Promise<boolean>;
  unresolvedProductId: string | null;
  buyAgainProductId: string | null;
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

/**
 * The provider's value, exported so a development-only fixture can mount the
 * credits screen against fixed store answers. Product code always reaches it
 * through `useCreditNativeIap`.
 */
export const CreditNativeIapContext = createContext<CreditNativeIapContextValue | null>(null);

export function useCreditNativeIap(): CreditNativeIapContextValue {
  const context = useContext(CreditNativeIapContext);
  if (!context) {
    throw new Error('useCreditNativeIap must be used within CreditNativeIapOwner.');
  }

  return context;
}

/** The store key a recovery pass's own refusal uses; it names no product request. */
const RECOVERY_ERROR_KEY = 'store';

/**
 * The purchase request this owner is waiting on, as a record rather than a
 * lookup: the store SDK delivers outcomes through listeners, not through the
 * request promise, so an attempt found by product id after a timeout could
 * belong to a newer request. The record is the only thing a delivery settles.
 */
type PurchaseRequestRecord = {
  readonly intent: CreditPurchaseIntent;
  readonly epoch: number;
  readonly attempt: SurfaceAttempt<CreditPurchaseFailure>;
  readonly pack: StoreCreditProduct;
  readonly settle: () => void;
};

type BuyAgainConsent = {
  readonly intent: CreditPurchaseIntent;
  readonly productId: string;
  readonly epoch: number;
};

/**
 * The single `useIAP` call site for the credits route.
 *
 * expo-iap registers its purchase listeners at module scope, so the app must
 * never mount two owners at once; they would double-handle every purchase.
 */
export function CreditNativeIapOwner({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // The one platform-derived value in the flow: the store this device can buy
  // from. Read from the shared helper so the owner, the screen and the catalog
  // hook can never pick two different storefronts.
  const storefront = getCreditStorefront();
  // The purchase phase, keyed by store product id: a row is busy while its own
  // request is pending, and the screen renders a failed entry's key.
  const purchases = useKeyedSurfaceFeedback<string, CreditPurchaseFailure>();
  const beginPurchase = purchases.begin;
  const completingProductId = purchases.snapshot.pendingKeys[0] ?? null;
  // The screen renders one error line, so the owner reads the failed entry (an
  // absent key reads idle). A pending entry can never be disturbed by this.
  // One line on screen, so the first failed entry names it. A pending entry can
  // never be disturbed by clearError, which only retires `failed`.
  const errorMessageKey =
    [...purchases.snapshot.states.values()].find(phase => phase.status === 'failed')?.failure
      .messageKey ?? null;
  const purchaseStatesRef = useRef(purchases.snapshot.states);
  purchaseStatesRef.current = purchases.snapshot.states;
  const clearPurchaseFailure = purchases.clearWhere;
  const clearError = useCallback(() => {
    for (const [key, phase] of purchaseStatesRef.current) {
      if (phase.status === 'failed') {
        clearPurchaseFailure(key, () => true);
      }
    }
  }, [clearPurchaseFailure]);
  const [completedPurchaseCount, setCompletedPurchaseCount] = useState(0);
  const [unresolvedProductId, setUnresolvedProductId] = useState<string | null>(null);
  const [buyAgainProductId, setBuyAgainProductId] = useState<string | null>(null);
  const buyAgainConsentRef = useRef<BuyAgainConsent | null>(null);
  const clearBlockedPurchase = useCallback(() => {
    setUnresolvedProductId(null);
    setBuyAgainProductId(null);
    buyAgainConsentRef.current = null;
  }, []);
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const recoveryInFlightPurchaseIdsRef = useRef(new Set<string>());
  const pendingPurchaseRef = useRef<PurchaseRequestRecord | null>(null);
  const completeDeliveredPurchaseRef = useRef<((purchase: Purchase) => Promise<void>) | null>(null);
  // The auth epoch this owner belongs to. Sign-out/sign-in bumps it and this
  // screen unmounts, but a store delivery or completion already in flight keeps
  // running; `isAccountCurrent` reports whether this instance is still the
  // current session's, so the old one never posts or announces under the new.
  const authEpochRef = useRef(currentAuthEpoch());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingPurchaseRef.current?.settle();
    };
  }, []);

  const retireCompletedIntent = useCallback(
    async (intent: CreditPurchaseIntent) => {
      const owner = pendingPurchaseRef.current;
      await retireCreditPurchaseIntent(intent);
      if (
        !mountedRef.current ||
        !isCurrentAuthEpoch(authEpochRef.current) ||
        ownsCreditPurchaseIntent(intent) ||
        pendingPurchaseRef.current !== owner
      ) {
        return;
      }
      clearError();
      clearBlockedPurchase();
      if (owner?.intent === intent) {
        pendingPurchaseRef.current = null;
        owner.settle();
        owner.attempt.succeed();
      }
    },
    [clearBlockedPurchase, clearError]
  );

  const completeAppStorePurchase = useMutation(
    trpc.credits.completeAppStorePurchase.mutationOptions()
  );
  const completePlayPurchase = useMutation(trpc.credits.completePlayPurchase.mutationOptions());

  // Server-backed catalog: its account token is the one the store purchase must
  // carry, and its product ids drive recovery even when the store fetch failed.
  const serverProductsQuery = useQuery(
    trpc.credits.getMobileStoreProducts.queryOptions({ supportsCreditExpiry: true })
  );
  const appAccountToken = serverProductsQuery.data?.appAccountToken ?? '';
  const creditPackAppleProductIds = useMemo(
    () => serverProductsQuery.data?.products.map(product => product.appleProductId) ?? [],
    [serverProductsQuery.data]
  );
  const creditPackGoogleProductIds = useMemo(
    () =>
      serverProductsQuery.data?.recoveryGoogleProductIds ??
      serverProductsQuery.data?.products.map(product => product.googleProductId) ??
      [],
    [serverProductsQuery.data]
  );

  // Reserved key for a failure that belongs to no product request (a recovery
  // pass's refusal): the screen renders one line, so it takes one slot.
  const toastPurchaseError = useCallback((key: string) => {
    // Translating an existing key, not authoring copy: the screen owns the
    // inline message and translates a failed entry's key itself.
    showDedupedPurchaseError(i18n.t(key));
  }, []);

  const showError = useCallback(
    (key: string) => {
      toastPurchaseError(key);
      // A refusal that is not one product request's failure (a recovery pass
      // refuses a receipt) still reaches the screen's one line.
      beginPurchase(RECOVERY_ERROR_KEY)?.fail({ kind: 'purchase-refused', messageKey: key });
    },
    [beginPurchase, toastPurchaseError]
  );

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
    // Native listener errors carry no request or transaction identity. Only the
    // rejection of the captured request promise may settle an admission.
    onPurchaseSuccess: purchase => {
      void (async () => {
        try {
          await completeDeliveredPurchaseRef.current?.(purchase);
        } catch {
          if (mountedRef.current && isCurrentAuthEpoch(authEpochRef.current)) {
            showError(creditStoreTimeoutKey(storefront));
          }
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
        requestPurchase: async params => {
          const record = pendingPurchaseRef.current;
          if (record === null) {
            throw new Error('A purchase needs an admitted request.');
          }
          try {
            await markCreditPurchaseIntentDispatched(record.intent);
          } catch (error) {
            await retireCreditPurchaseIntent(record.intent);
            throw error;
          }
          if (!record.attempt.owns() || !isCurrentAuthEpoch(record.epoch) || !ownsCreditPurchaseIntent(record.intent)) {
            await retireCreditPurchaseIntent(record.intent);
            return null;
          }
          let delivered: RequestPurchaseResult = null;
          try {
            delivered = await requestPurchase(params);
          } catch (error) {
            if (isStoreNotReadyError(error) && isCurrentAuthEpoch(record.epoch)) {
              await reconnectStore();
            }
            if (!isStorePendingPurchaseError(error)) {
              await retireCreditPurchaseIntent(record.intent);
              record.settle();
            }
            throw error;
          }
          if (!ownsCreditPurchaseIntent(record.intent)) {
            const recovered = Array.isArray(delivered) ? delivered : [delivered];
            await Promise.all(recovered.map(async purchase => {
              if (purchase && isCurrentAuthEpoch(record.epoch)) {
                await completeDeliveredPurchaseRef.current?.(purchase);
              }
            }));
            return delivered;
          }
          const nativePurchases = Array.isArray(delivered) ? delivered : [delivered];
          await Promise.all(
            nativePurchases.map(async purchase => {
              if (
                !purchase ||
                !isCurrentAuthEpoch(record.epoch) ||
                !ownsCreditPurchaseIntent(record.intent)
              ) {
                return;
              }
              if (purchase.productId !== record.intent.productId) {
                await completeDeliveredPurchaseRef.current?.(purchase);
                return;
              }
              await identifyCreditPurchaseTransaction(record.intent, purchase);
              if (!isCurrentAuthEpoch(record.epoch) || !ownsCreditPurchaseIntent(record.intent)) {
                return;
              }
              await (recoveredPurchaseIdsRef.current.has(getPurchaseCompletionId(purchase))
                ? retireCompletedIntent(record.intent)
                : completeDeliveredPurchaseRef.current?.(purchase));
            })
          );
          return delivered;
        },
        completeAppStorePurchase: completeAppStorePurchase.mutateAsync,
        completePlayPurchase: completePlayPurchase.mutateAsync,
        finishTransaction,
        invalidateAfterCompletion,
        onPurchaseCompleted: () => {
          if (!mountedRef.current || !isCurrentAuthEpoch(authEpochRef.current)) {
            return;
          }
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
      reconnectStore,
      requestPurchase,
      retireCompletedIntent,
      showError,
      storefront,
    ]
  );

  // Completes one transaction the store delivered outside a request this owner
  // started (a re-delivered or deferred purchase). Recovery only runs when the
  // store connects, so the purchase callback must complete it in-session or the
  // user stays charged and uncredited until the screen remounts.
  const completeStorePurchaseInSession = useCallback(
    async (purchase: Purchase): Promise<void> => {
      if (!isCurrentAuthEpoch(authEpochRef.current)) {
        return;
      }
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
      const intent = await restoreCreditPurchaseIntent();
      if (!isCurrentAuthEpoch(authEpochRef.current)) {
        return;
      }
      const owned = intent !== null && matchesCreditPurchaseIntent(intent, purchase);
      if (owned) {
        await identifyCreditPurchaseTransaction(intent, purchase);
        if (!isCurrentAuthEpoch(authEpochRef.current)) {
          return;
        }
      }
      recoveryInFlightPurchaseIdsRef.current.add(id);
      try {
        // The store delivered this transaction on its own, so the completion
        // announces itself; a failure stays silent because the recovery pass
        // retries it on the next connect.
        const completed = await actions.handlePurchaseSuccess(purchase, {
          notifyErrors: owned,
        });
        if (completed) {
          recoveredPurchaseIdsRef.current.add(id);
          if (
            intent !== null &&
            matchesCreditPurchaseIntent(intent, purchase) &&
            ownsCreditPurchaseIntent(intent)
          ) {
            await retireCompletedIntent(intent);
          }
        } else if (owned && purchase.purchaseState !== 'pending') {
          const owner = pendingPurchaseRef.current;
          if (owner?.intent === intent && isCurrentAuthEpoch(owner.epoch) && owner.attempt.owns()) {
            pendingPurchaseRef.current = null;
            owner.settle();
            setUnresolvedProductId(owner.intent.productId);
            owner.attempt.fail({
              kind: 'purchase-refused',
              messageKey: 'kiloPass.purchaseFailed',
            });
          }
        }
      } finally {
        recoveryInFlightPurchaseIdsRef.current.delete(id);
      }
    },
    [actions, creditPackAppleProductIds, creditPackGoogleProductIds, retireCompletedIntent]
  );

  useEffect(() => {
    completeDeliveredPurchaseRef.current = completeStorePurchaseInSession;
  }, [completeStorePurchaseInSession]);

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
  // found, so the caller still owes its own failure copy.
  const recoverOwnedCreditPurchase = useCallback(async (): Promise<boolean> => {
    let pendingPurchases: Purchase[] = [];
    try {
      pendingPurchases = await withStoreDeadline(
        fetchPendingStorePurchases(storefront),
        'the pending purchase lookup'
      );
    } catch {
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
      if (isCurrentAuthEpoch(authEpochRef.current)) {
        for (const purchase of recoveredPurchases) {
          recoveredPurchaseIdsRef.current.add(getPurchaseCompletionId(purchase));
        }
      }
      // A backend refusal is handled too: the recovery already published its copy.
      return true;
    } finally {
      for (const purchase of outstandingPurchases) {
        recoveryInFlightPurchaseIdsRef.current.delete(getPurchaseCompletionId(purchase));
      }
    }
  }, [actions, creditPackAppleProductIds, creditPackGoogleProductIds, storefront]);

  useEffect(() => {
    recoverOwnedPurchaseRef.current = recoverOwnedCreditPurchase;
  }, [recoverOwnedCreditPurchase]);

  // Completes whatever the store still holds for a request that timed out. The
  // SDK has no cancellation, so the charge may land after the row was released;
  // buying the same pack again must finish that intent instead of charging
  // twice. Bounded like every other store read in this flow.
  const reconcilePurchaseIntent = useCallback(
    async (record: PurchaseRequestRecord): Promise<boolean> => {
      let emptyForIntent = false;
      try {
        const pending = await withStoreDeadline(
          fetchPendingStorePurchases(storefront),
          'the pending purchase lookup'
        );
        if (
          pendingPurchaseRef.current !== record ||
          !record.attempt.owns() ||
          !isCurrentAuthEpoch(record.epoch)
        ) {
          return false;
        }
        emptyForIntent = !pending.some(purchase =>
          purchase.productId === record.intent.productId ||
          matchesCreditPurchaseIntent(record.intent, purchase)
        );
        await Promise.all(
          pending.map(async purchase => {
            if (
              isCurrentAuthEpoch(record.epoch) &&
              pendingPurchaseRef.current === record &&
              record.attempt.owns()
            ) {
              await completeStorePurchaseInSession(purchase);
            }
          })
        );
      } catch {
        // An empty or failed lookup is not proof that the native request cannot charge.
      }
      if (
        pendingPurchaseRef.current === record &&
        record.attempt.owns() &&
        isCurrentAuthEpoch(record.epoch)
      ) {
        pendingPurchaseRef.current = null;
        record.settle();
        setUnresolvedProductId(record.intent.productId);
        if (emptyForIntent && record.pack.storeProductId !== null) {
          buyAgainConsentRef.current = {
            intent: record.intent,
            productId: record.pack.storeProductId,
            epoch: record.epoch,
          };
          setBuyAgainProductId(record.pack.storeProductId);
        }
        record.attempt.fail({
          kind: 'store-timeout',
          messageKey: creditStoreTimeoutKey(storefront),
        });
      }
      return false;
    },
    [completeStorePurchaseInSession, storefront]
  );

  const admissionRef = useRef<SurfaceAttempt<CreditPurchaseFailure> | null>(null);
  const startPurchase = useCallback(
    async (pack: StoreCreditProduct, queryOnly = false): Promise<boolean> => {
      const storeProductId = pack.storeProductId;
      if (
        !mountedRef.current ||
        !isCurrentAuthEpoch(authEpochRef.current) ||
        !storeProductId ||
        !appAccountToken ||
        admissionRef.current?.owns()
      ) {
        return false;
      }
      const attempt = beginPurchase(storeProductId);
      if (attempt === null) {
        return false;
      }
      admissionRef.current = attempt;
      const epoch = authEpochRef.current;
      clearError();
      buyAgainConsentRef.current = null;
      setBuyAgainProductId(null);
      let reservedIntent: CreditPurchaseIntent | null = null;
      try {
        const admitted = await admitCreditPurchaseIntent(storeProductId, appAccountToken, !queryOnly);
        reservedIntent = admitted.intent;
        if (!attempt.owns() || !isCurrentAuthEpoch(epoch)) {
          if (admitted.created && admitted.intent !== null) {
            await retireCreditPurchaseIntent(admitted.intent);
          }
          return false;
        }
        if (admitted.intent === null) {
          clearBlockedPurchase();
          attempt.abandon();
          return false;
        }
        const settlement = Promise.withResolvers<undefined>();
        const record = {
          intent: admitted.intent,
          epoch,
          attempt,
          pack,
          settle: () => {
            settlement.resolve(undefined);
          },
        };
        pendingPurchaseRef.current = record;
        if (!admitted.created) {
          setUnresolvedProductId(admitted.intent.productId);
          return await reconcilePurchaseIntent(record);
        }
        clearBlockedPurchase();
        void (async () => {
          try {
            await withStoreDeadline(settlement.promise, 'the purchase outcome');
          } catch {
            if (
              pendingPurchaseRef.current === record &&
              attempt.owns() &&
              isCurrentAuthEpoch(epoch)
            ) {
              pendingPurchaseRef.current = null;
              setUnresolvedProductId(record.intent.productId);
              attempt.fail({
                kind: 'store-timeout',
                messageKey: creditStoreTimeoutKey(storefront),
              });
            }
          }
        })();
        const outcome = await actions.purchase(pack);
        if (
          pendingPurchaseRef.current !== record ||
          !attempt.owns() ||
          !isCurrentAuthEpoch(epoch)
        ) {
          return false;
        }
        if (outcome.started) {
          return true;
        }
        if (outcome.failure === null && ownsCreditPurchaseIntent(record.intent)) {
          return false;
        }
        pendingPurchaseRef.current = null;
        record.settle();
        if (ownsCreditPurchaseIntent(record.intent)) {
          setUnresolvedProductId(record.intent.productId);
        } else {
          clearBlockedPurchase();
        }
        if (outcome.failure === null) {
          attempt.abandon();
          return false;
        }
        toastPurchaseError(outcome.failure.messageKey);
        attempt.fail(outcome.failure);
      } catch {
        if (reservedIntent !== null && !reservedIntent.dispatched) {
          try {
            await retireCreditPurchaseIntent(reservedIntent);
          } catch {
            // A reservation whose deletion failed remains a charge admission barrier.
          }
        }
        if (attempt.owns() && isCurrentAuthEpoch(epoch)) {
          setUnresolvedProductId(
            reservedIntent !== null && ownsCreditPurchaseIntent(reservedIntent)
              ? reservedIntent.productId
              : null
          );
          attempt.fail({ kind: 'store-timeout', messageKey: creditStoreTimeoutKey(storefront) });
        }
      }
      return false;
    },
    [
      actions,
      appAccountToken,
      beginPurchase,
      clearBlockedPurchase,
      clearError,
      reconcilePurchaseIntent,
      storefront,
      toastPurchaseError,
    ]
  );

  const reconcilePurchase = useCallback(async (pack: StoreCreditProduct): Promise<boolean> => {
    const reconciled = await startPurchase(pack, true);
    return reconciled;
  }, [startPurchase]);

  const buyAgain = useCallback(async (pack: StoreCreditProduct): Promise<boolean> => {
    const consent = buyAgainConsentRef.current;
    const productId = pack.storeProductId;
    if (
      !mountedRef.current ||
      consent === null ||
      productId === null ||
      consent.productId !== productId ||
      !isCurrentAuthEpoch(consent.epoch) ||
      !ownsCreditPurchaseIntent(consent.intent) ||
      admissionRef.current?.owns()
    ) {
      return false;
    }
    const attempt = beginPurchase(productId);
    if (attempt === null) {
      return false;
    }
    admissionRef.current = attempt;
    buyAgainConsentRef.current = null;
    setBuyAgainProductId(null);
    try {
      await retireCreditPurchaseIntent(consent.intent);
      if (!attempt.owns() || !isCurrentAuthEpoch(consent.epoch)) {
        return false;
      }
      if (ownsCreditPurchaseIntent(consent.intent)) {
        attempt.fail({ kind: 'store-timeout', messageKey: creditStoreTimeoutKey(storefront) });
        return false;
      }
      clearBlockedPurchase();
      attempt.abandon();
      return await startPurchase(pack);
    } catch {
      if (attempt.owns() && isCurrentAuthEpoch(consent.epoch)) {
        attempt.fail({ kind: 'store-timeout', messageKey: creditStoreTimeoutKey(storefront) });
      }
      return false;
    }
  }, [beginPurchase, clearBlockedPurchase, startPurchase, storefront]);

  useEffect(() => {
    void (async () => {
      try {
        const intent = await restoreCreditPurchaseIntent();
        if (intent !== null && mountedRef.current && isCurrentAuthEpoch(authEpochRef.current)) {
          setUnresolvedProductId(intent.productId);
          beginPurchase(intent.productId)?.fail({
            kind: 'store-timeout',
            messageKey: creditStoreTimeoutKey(storefront),
          });
        }
      } catch {
        if (mountedRef.current && isCurrentAuthEpoch(authEpochRef.current)) {
          showError(creditStoreTimeoutKey(storefront));
        }
      }
    })();
  }, [beginPurchase, showError, storefront]);

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
        if (!isCurrentAuthEpoch(authEpochRef.current)) {
          return;
        }
        const intent = await restoreCreditPurchaseIntent();
        if (!isCurrentAuthEpoch(authEpochRef.current)) {
          return;
        }
        if (
          intent !== null &&
          recoveredPurchases.some(purchase => matchesCreditPurchaseIntent(intent, purchase))
        ) {
          await retireCompletedIntent(intent);
        }
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
    retireCompletedIntent,
    connected,
    creditPackAppleProductIds.length,
    creditPackGoogleProductIds.length,
    storefront,
  ]);

  // Play can drop its billing client after this owner connected (a service
  // disconnect, or another owner's `endConnection`); `connected` still reads
  // true and the next price lookup fails with `NotPrepared`. Reconnect and ask
  // once more, so one dropped connection is not reported as a store outage. A
  // reconnect that fails, or a second failure, reaches the loader, which shows
  // the store-unavailable copy.
  //
  // The ask once more is skipped once the caller's deadline has settled this
  // call: the store SDK has no cancellation, so the first call can surface a
  // stale failure long after the screen gave up, and a store that stayed
  // silent for the whole deadline stays silent for a retry too. Checked before
  // and after the reconnect, which is itself a store call.
  const fetchStoreProducts = useCallback(
    async (
      productSkus: string[],
      options?: StoreProductFetchOptions
    ): Promise<StoreCreditProductListing[]> => {
      const signal = options?.signal;
      try {
        return await fetchCreditStoreProducts(productSkus);
      } catch (error) {
        if (
          signal?.aborted ||
          !isStoreNotReadyError(error) ||
          !(await reconnectStore()) ||
          signal?.aborted
        ) {
          throw error;
        }
        return fetchCreditStoreProducts(productSkus);
      }
    },
    [reconnectStore]
  );

  const value = useMemo<CreditNativeIapContextValue>(
    () => ({
      connected,
      fetchStoreProducts,
      reconnectStore,
      purchase: startPurchase,
      reconcilePurchase,
      buyAgain,
      unresolvedProductId,
      buyAgainProductId,
      completingProductId,
      errorMessageKey,
      completedPurchaseCount,
      clearError,
    }),
    [
      buyAgain,
      buyAgainProductId,
      clearError,
      completedPurchaseCount,
      completingProductId,
      connected,
      errorMessageKey,
      fetchStoreProducts,
      reconnectStore,
      reconcilePurchase,
      startPurchase,
      unresolvedProductId,
    ]
  );

  return createElement(CreditNativeIapContext.Provider, { value }, children);
}
