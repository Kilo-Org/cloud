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
  canAttributeNativePurchaseOutcome,
  isCreditPurchaseTransportDisconnection,
  registerCreditPurchaseDispatch,
  restoreCreditPurchaseAuthority,
  retainEarlierUnresolvedPurchase,
} from '@/lib/credits/credit-purchase-authority';
import {
  admitCreditPurchaseIntent,
  consentToReplaceMalformedCreditPurchaseIntent,
  type CreditPurchaseIntent,
  identifyCreditPurchaseTransaction,
  MalformedCreditPurchaseIntentError,
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
  type CreditPurchaseCompletion,
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
import { type CreditPurchaseResolution } from './credit-unresolved-purchase-notice';

/**
 * The mount flag, read through a call. A direct `mountedRef.current` read after
 * an earlier guard in the same async body is narrowed by the compiler even
 * though the screen can unmount while the body awaits.
 */
function isStillMounted(ref: { readonly current: boolean }): boolean {
  return ref.current;
}

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

/** How far the durable admission read has got; the screen waits for it. */
export type CreditPurchaseHydration = 'loading' | 'ready' | 'failed';

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
  /**
   * Asks the store what it still holds for the earlier request. It names no
   * pack and starts no charge, so it stays reachable when the earlier SKU is
   * retired, unpriced or unreadable.
   */
  reconcilePurchase: () => Promise<boolean>;
  buyAgain: (pack: StoreCreditProduct) => Promise<boolean>;
  /**
   * An earlier charge is still unresolved, so every new purchase needs consent.
   */
  hasUnresolvedPurchase: boolean;
  /** What the store holds for that earlier request, once it answered. */
  purchaseResolution: CreditPurchaseResolution;
  /** The durable admission read the purchase layout waits for. */
  purchaseHydration: CreditPurchaseHydration;
  /** The stored admission cannot be parsed; only consent may replace it. */
  malformedPurchaseAdmission: boolean;
  /** Erases the unreadable admission after the person consents to replacing it. */
  replaceMalformedPurchaseAdmission: () => Promise<boolean>;
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
  /**
   * The catalog pack the person tapped, or null for a store query the notice
   * started: that query names no pack, and consent for a replacement comes from
   * a row tap or the earlier request's own id.
   */
  readonly pack: StoreCreditProduct | null;
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
  const [buyAgainProductId, setBuyAgainProductId] = useState<string | null>(null);
  const [purchaseResolution, setPurchaseResolution] = useState<CreditPurchaseResolution>('unknown');
  const [hasUnresolvedPurchase, setHasUnresolvedPurchase] = useState(false);
  const [purchaseHydration, setPurchaseHydration] = useState<CreditPurchaseHydration>('loading');
  const [malformedPurchaseAdmission, setMalformedPurchaseAdmission] = useState(false);
  const buyAgainConsentRef = useRef<BuyAgainConsent | null>(null);
  const clearBlockedPurchase = useCallback(() => {
    setBuyAgainProductId(null);
    setPurchaseResolution('unknown');
    setHasUnresolvedPurchase(false);
    buyAgainConsentRef.current = null;
  }, []);
  /**
   * An admission still owns a charge, so the screen must say so before offering
   * another. The resolution is what the store answered for that earlier request;
   * `unknown` is one no lookup has covered yet.
   */
  const markUnresolvedPurchase = useCallback((resolution: CreditPurchaseResolution) => {
    if (!mountedRef.current || !isCurrentAuthEpoch(authEpochRef.current)) {
      return;
    }
    setPurchaseResolution(resolution);
    setHasUnresolvedPurchase(true);
  }, []);
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const recoveryInFlightPurchaseIdsRef = useRef(new Set<string>());
  const pendingPurchaseRef = useRef<PurchaseRequestRecord | null>(null);
  const completeDeliveredPurchaseRef = useRef<
    ((purchase: Purchase) => Promise<CreditPurchaseCompletion | undefined>) | null
  >(null);
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

  const offerBuyAgain = useCallback((record: PurchaseRequestRecord) => {
    // Consent names the pack the person picked when the request came from a row
    // tap; a store query started from the notice has no pack, so the earlier
    // request's own id is the only target it can offer — and the screen renders
    // no Buy again when the current catalog no longer sells that SKU.
    const productId = record.pack?.storeProductId ?? record.intent.productId;
    if (
      !mountedRef.current ||
      !isCurrentAuthEpoch(record.epoch) ||
      !record.attempt.owns() ||
      (pendingPurchaseRef.current !== null && pendingPurchaseRef.current !== record)
    ) {
      return;
    }
    buyAgainConsentRef.current = { intent: record.intent, productId, epoch: record.epoch };
    setBuyAgainProductId(productId);
  }, []);

  const retireCompletedIntent = useCallback(
    async (intent: CreditPurchaseIntent, owner: PurchaseRequestRecord | null) => {
      if (!canAttributeNativePurchaseOutcome(intent)) {
        return;
      }
      await retireCreditPurchaseIntent(intent);
      const currentOwner = pendingPurchaseRef.current;
      if (
        !mountedRef.current ||
        !isCurrentAuthEpoch(authEpochRef.current) ||
        ownsCreditPurchaseIntent(intent) ||
        (currentOwner !== null && currentOwner.intent !== intent)
      ) {
        return;
      }
      clearError();
      clearBlockedPurchase();
      if (owner?.intent === intent && currentOwner === owner) {
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
      if (!mountedRef.current || !isCurrentAuthEpoch(authEpochRef.current)) {
        return;
      }
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
    // Native callbacks and request promises share a pool; only an unambiguous
    // in-process admission may claim one of their outcomes.
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
          if (
            !record.attempt.owns() ||
            !isCurrentAuthEpoch(record.epoch) ||
            !ownsCreditPurchaseIntent(record.intent)
          ) {
            await retireCreditPurchaseIntent(record.intent);
            return null;
          }
          registerCreditPurchaseDispatch(record.intent);
          let delivered: RequestPurchaseResult = null;
          try {
            delivered = await requestPurchase(params);
          } catch (error) {
            if (isStoreNotReadyError(error) && isCurrentAuthEpoch(record.epoch)) {
              await reconnectStore();
            }
            if (
              canAttributeNativePurchaseOutcome(record.intent) &&
              !isStorePendingPurchaseError(error) &&
              !isCreditPurchaseTransportDisconnection(error)
            ) {
              await retireCreditPurchaseIntent(record.intent);
              record.settle();
            }
            throw error;
          }
          const nativePurchases = Array.isArray(delivered) ? delivered : [delivered];
          const purchase = nativePurchases.length === 1 ? nativePurchases[0] : null;
          if (
            !purchase ||
            purchase.productId !== record.intent.productId ||
            !canAttributeNativePurchaseOutcome(record.intent)
          ) {
            await Promise.all(
              nativePurchases.map(async recovered => {
                if (recovered && isCurrentAuthEpoch(record.epoch)) {
                  await completeDeliveredPurchaseRef.current?.(recovered);
                }
              })
            );
            return delivered;
          }
          if (!isCurrentAuthEpoch(record.epoch)) {
            return delivered;
          }
          await identifyCreditPurchaseTransaction(record.intent, purchase);
          if (
            !isCurrentAuthEpoch(record.epoch) ||
            !canAttributeNativePurchaseOutcome(record.intent)
          ) {
            return delivered;
          }
          await (recoveredPurchaseIdsRef.current.has(getPurchaseCompletionId(purchase))
            ? retireCompletedIntent(record.intent, record)
            : completeDeliveredPurchaseRef.current?.(purchase));
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
    async (
      purchase: Purchase,
      reconciliation: PurchaseRequestRecord | null = null
    ): Promise<CreditPurchaseCompletion | undefined> => {
      if (!isCurrentAuthEpoch(authEpochRef.current)) {
        return undefined;
      }
      if (
        !isRecoverableCreditPurchase(
          purchase,
          creditPackAppleProductIds,
          creditPackGoogleProductIds
        )
      ) {
        return undefined;
      }
      const id = getPurchaseCompletionId(purchase);
      if (
        recoveredPurchaseIdsRef.current.has(id) ||
        recoveryInFlightPurchaseIdsRef.current.has(id)
      ) {
        return undefined;
      }
      const requestOwner = reconciliation ?? pendingPurchaseRef.current;
      const intent = await restoreCreditPurchaseIntent();
      if (!isCurrentAuthEpoch(authEpochRef.current)) {
        return undefined;
      }
      const owned =
        intent !== null &&
        canAttributeNativePurchaseOutcome(intent) &&
        matchesCreditPurchaseIntent(intent, purchase);
      if (owned) {
        await identifyCreditPurchaseTransaction(intent, purchase);
        if (!isCurrentAuthEpoch(authEpochRef.current)) {
          return undefined;
        }
      }
      recoveryInFlightPurchaseIdsRef.current.add(id);
      try {
        const completion = await actions.handlePurchaseSuccess(purchase, { notifyErrors: false });
        if (completion.status === 'completed') {
          recoveredPurchaseIdsRef.current.add(id);
          if (
            intent !== null &&
            matchesCreditPurchaseIntent(intent, purchase) &&
            canAttributeNativePurchaseOutcome(intent)
          ) {
            await retireCompletedIntent(intent, requestOwner);
          }
        } else if (
          reconciliation === null &&
          owned &&
          (completion.status === 'terminal-refusal' || completion.status === 'retryable-refusal') &&
          completion.messageKey !== null
        ) {
          const owner = requestOwner;
          if (
            owner !== null &&
            pendingPurchaseRef.current === owner &&
            owner.intent === intent &&
            mountedRef.current &&
            isCurrentAuthEpoch(owner.epoch) &&
            owner.attempt.owns()
          ) {
            pendingPurchaseRef.current = null;
            owner.settle();
            markUnresolvedPurchase(
              completion.status === 'terminal-refusal' ? 'terminal-refusal' : 'found'
            );
            if (completion.status === 'terminal-refusal') {
              offerBuyAgain(owner);
            }
            toastPurchaseError(completion.messageKey);
            owner.attempt.fail({ kind: 'purchase-refused', messageKey: completion.messageKey });
          }
        }
        return completion;
      } finally {
        recoveryInFlightPurchaseIdsRef.current.delete(id);
      }
    },
    [
      actions,
      creditPackAppleProductIds,
      creditPackGoogleProductIds,
      markUnresolvedPurchase,
      offerBuyAgain,
      retireCompletedIntent,
      toastPurchaseError,
    ]
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

  // Store calls cannot be cancelled; reconciliation never silently authorizes another charge.
  const reconcilePurchaseIntent = useCallback(
    async (record: PurchaseRequestRecord): Promise<boolean> => {
      let resolution: CreditPurchaseResolution = 'unknown';
      let failure: CreditPurchaseFailure | null = null;
      const reconcile = async () => {
        const pending = await fetchPendingStorePurchases(storefront);
        if (
          pendingPurchaseRef.current !== record ||
          !record.attempt.owns() ||
          !isCurrentAuthEpoch(record.epoch)
        ) {
          return;
        }
        const related = (purchase: Purchase) =>
          purchase.productId === record.intent.productId ||
          matchesCreditPurchaseIntent(record.intent, purchase);
        resolution = pending.some(purchase => related(purchase)) ? 'found' : 'not-found';
        const results = await Promise.all(
          pending.map(async purchase => ({
            purchase,
            completion:
              pendingPurchaseRef.current === record &&
              record.attempt.owns() &&
              isCurrentAuthEpoch(record.epoch)
                ? await completeStorePurchaseInSession(purchase, record)
                : undefined,
          }))
        );
        const terminal = results.find(
          result => related(result.purchase) && result.completion?.status === 'terminal-refusal'
        )?.completion;
        const retryable = results.find(
          result =>
            related(result.purchase) &&
            result.completion?.status === 'retryable-refusal' &&
            result.completion.messageKey !== null
        )?.completion;
        if (terminal?.status === 'terminal-refusal') {
          resolution = 'terminal-refusal';
          failure = { kind: 'purchase-refused', messageKey: terminal.messageKey };
        } else if (retryable?.status === 'retryable-refusal' && retryable.messageKey !== null) {
          failure = { kind: 'purchase-refused', messageKey: retryable.messageKey };
        }
      };
      try {
        await withStoreDeadline(reconcile(), 'the purchase reconciliation');
      } catch {
        failure = { kind: 'store-timeout', messageKey: creditStoreTimeoutKey(storefront) };
      }
      if (
        pendingPurchaseRef.current === record &&
        record.attempt.owns() &&
        isCurrentAuthEpoch(record.epoch)
      ) {
        pendingPurchaseRef.current = null;
        record.settle();
        if (!ownsCreditPurchaseIntent(record.intent)) {
          clearBlockedPurchase();
          record.attempt.abandon();
          return false;
        }
        markUnresolvedPurchase(resolution);
        offerBuyAgain(record);
        if (failure === null) {
          record.attempt.abandon();
        } else {
          toastPurchaseError(failure.messageKey);
          record.attempt.fail(failure);
        }
      }
      return false;
    },
    [
      clearBlockedPurchase,
      completeStorePurchaseInSession,
      markUnresolvedPurchase,
      offerBuyAgain,
      storefront,
      toastPurchaseError,
    ]
  );

  const admissionRef = useRef<SurfaceAttempt<CreditPurchaseFailure> | null>(null);
  const startPurchase = useCallback(
    async (pack: StoreCreditProduct): Promise<boolean> => {
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
        await restoreCreditPurchaseAuthority();
        if (!attempt.owns() || !isCurrentAuthEpoch(epoch) || !isStillMounted(mountedRef)) {
          return false;
        }
        const admitted = await admitCreditPurchaseIntent(storeProductId, appAccountToken);
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
          // The stored admission still owns a charge: the row tap is the
          // person's selection, and reconciliation asks the store about that
          // charge before any new one is admitted.
          markUnresolvedPurchase('unknown');
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
              markUnresolvedPurchase('unknown');
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
          markUnresolvedPurchase('unknown');
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
          if (reservedIntent !== null && ownsCreditPurchaseIntent(reservedIntent)) {
            markUnresolvedPurchase('unknown');
          } else {
            clearBlockedPurchase();
          }
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
      markUnresolvedPurchase,
      reconcilePurchaseIntent,
      storefront,
      toastPurchaseError,
    ]
  );

  /**
   * The notice's retry, and the retry of a failed admission read: both ask the
   * store what it still holds without naming a pack, so neither starts a charge
   * and neither needs the earlier SKU to exist in the current catalog.
   */
  const reconcilePurchase = useCallback(async (): Promise<boolean> => {
    if (
      !mountedRef.current ||
      !isCurrentAuthEpoch(authEpochRef.current) ||
      admissionRef.current?.owns()
    ) {
      return false;
    }
    let intent: CreditPurchaseIntent | null = null;
    try {
      intent = await restoreCreditPurchaseIntent();
    } catch {
      // The stored admission still cannot be read. The status region keeps its
      // retry and consent exits, and no new charge may be admitted meanwhile.
      if (isStillMounted(mountedRef) && isCurrentAuthEpoch(authEpochRef.current)) {
        setPurchaseHydration('failed');
      }
      return false;
    }
    if (!isStillMounted(mountedRef) || !isCurrentAuthEpoch(authEpochRef.current)) {
      return false;
    }
    setPurchaseHydration('ready');
    if (intent === null) {
      clearBlockedPurchase();
      return false;
    }
    const attempt = beginPurchase(intent.productId);
    if (attempt === null) {
      return false;
    }
    admissionRef.current = attempt;
    const settlement = Promise.withResolvers<undefined>();
    const record: PurchaseRequestRecord = {
      intent,
      epoch: authEpochRef.current,
      attempt,
      pack: null,
      settle: () => {
        settlement.resolve(undefined);
      },
    };
    pendingPurchaseRef.current = record;
    return reconcilePurchaseIntent(record);
  }, [beginPurchase, clearBlockedPurchase, reconcilePurchaseIntent]);

  const buyAgain = useCallback(
    async (pack: StoreCreditProduct): Promise<boolean> => {
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
        if (consent.intent.dispatched) {
          await retainEarlierUnresolvedPurchase();
          if (!attempt.owns() || !isCurrentAuthEpoch(consent.epoch)) {
            return false;
          }
        }
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
    },
    [beginPurchase, clearBlockedPurchase, startPurchase, storefront]
  );

  /**
   * Reads the durable admission once per mount. The purchase layout stays hidden
   * until this settles, and an admission that cannot be read fails closed: no row
   * may take a charge while the earlier store state is unknown. A read that
   * failed for a transient reason is retried by the screen's Try again, which is
   * the same store query that never starts a charge.
   */
  const hydratePurchaseAdmission = useCallback(async () => {
    try {
      await restoreCreditPurchaseAuthority();
    } catch {
      if (mountedRef.current && isCurrentAuthEpoch(authEpochRef.current)) {
        showError(creditStoreTimeoutKey(storefront));
      }
    }
    let restored: CreditPurchaseIntent | null = null;
    try {
      restored = await restoreCreditPurchaseIntent();
    } catch (error) {
      if (mountedRef.current && isCurrentAuthEpoch(authEpochRef.current)) {
        setMalformedPurchaseAdmission(error instanceof MalformedCreditPurchaseIntentError);
        setPurchaseHydration('failed');
      }
      return;
    }
    if (!mountedRef.current || !isCurrentAuthEpoch(authEpochRef.current)) {
      return;
    }
    setMalformedPurchaseAdmission(false);
    setPurchaseHydration('ready');
    if (restored === null) {
      setHasUnresolvedPurchase(false);
      return;
    }
    markUnresolvedPurchase('unknown');
    beginPurchase(restored.productId)?.fail({
      kind: 'store-timeout',
      messageKey: creditStoreTimeoutKey(storefront),
    });
  }, [beginPurchase, markUnresolvedPurchase, showError, storefront]);

  useEffect(() => {
    void hydratePurchaseAdmission();
  }, [hydratePurchaseAdmission]);

  /**
   * Erases an unreadable admission after the person consents to replacing it.
   * Only the exact stored text is removed, so a record that changed under the
   * read is never deleted, and the barrier stands until that consent arrives.
   */
  const replaceMalformedPurchaseAdmission = useCallback(async (): Promise<boolean> => {
    if (!mountedRef.current || !isCurrentAuthEpoch(authEpochRef.current)) {
      return false;
    }
    let replaced = false;
    try {
      replaced = await consentToReplaceMalformedCreditPurchaseIntent();
    } catch {
      return false;
    }
    if (!replaced || !isStillMounted(mountedRef) || !isCurrentAuthEpoch(authEpochRef.current)) {
      return false;
    }
    setMalformedPurchaseAdmission(false);
    setPurchaseHydration('ready');
    clearBlockedPurchase();
    return true;
  }, [clearBlockedPurchase]);

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
  // The pass holds the recovery entry in a ref: the actions object is rebuilt
  // whenever its dependencies change, and a pass must not re-query the store
  // because this component rendered again.
  const recoverPurchasesRef = useRef(actions.recoverPurchases);
  recoverPurchasesRef.current = actions.recoverPurchases;
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
        const requestOwner = pendingPurchaseRef.current;
        const recoveredPurchases = await recoverPurchasesRef.current(unrecoveredPurchases);
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
          await retireCompletedIntent(intent, requestOwner);
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
      replaceMalformedPurchaseAdmission,
      buyAgain,
      buyAgainProductId,
      hasUnresolvedPurchase,
      purchaseResolution,
      purchaseHydration,
      malformedPurchaseAdmission,
      completingProductId,
      errorMessageKey,
      completedPurchaseCount,
      clearError,
    }),
    [
      buyAgain,
      buyAgainProductId,
      purchaseResolution,
      hasUnresolvedPurchase,
      malformedPurchaseAdmission,
      purchaseHydration,
      clearError,
      completedPurchaseCount,
      completingProductId,
      connected,
      errorMessageKey,
      fetchStoreProducts,
      reconnectStore,
      reconcilePurchase,
      replaceMalformedPurchaseAdmission,
      startPurchase,
    ]
  );

  return createElement(CreditNativeIapContext.Provider, { value }, children);
}
