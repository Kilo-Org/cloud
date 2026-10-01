/* eslint-disable max-lines -- The one-off credit-pack store lifecycle (request, completion, recovery, error mapping) is a single contract and reads best in one place. */

import { useEffect } from 'react';
import { ErrorCode, type Purchase } from 'expo-iap';
import { toast } from 'sonner-native';
import { z } from 'zod';

import { readTrpcErrorField } from '@/lib/trpc-error';
import { type StoreCreditProduct } from './store-products';

/**
 * Catalog keys, never translated copy: the screen translates them. The keys
 * that name Kilo Pass in their copy are reused where the sentence is
 * product-agnostic (a failure, an unlinked purchase, a missing store token);
 * the account-mismatch copy names Kilo Pass, so it needs credit-pack keys of
 * its own (`credits.purchaseOwnedByAnotherAccount*`), owned by the screen slice.
 */
export const CREDIT_PURCHASE_FAILED_KEY = 'kiloPass.purchaseFailed';
const CREDIT_PURCHASE_DIFFERENT_ACCOUNT_KEY = 'kiloPass.purchaseDifferentAccount';
const CREDIT_PURCHASE_DIFFERENT_ACCOUNT_PLAY_KEY = 'kiloPass.purchaseDifferentAccountPlay';
const CREDIT_PURCHASE_MISSING_SIGNED_TRANSACTION_KEY = 'kiloPass.purchaseMissingSignedTransaction';
const CREDIT_PURCHASE_MISSING_PURCHASE_TOKEN_KEY = 'kiloPass.purchaseMissingPurchaseToken';
export const CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY = 'credits.purchaseOwnedByAnotherAccount';
export const CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_PLAY_KEY =
  'credits.purchaseOwnedByAnotherAccountPlay';

const userCancelledPurchaseErrorSchema = z.object({
  code: z.literal(ErrorCode.UserCancelled),
});

const alreadyOwnedPurchaseErrorSchema = z.object({
  code: z.literal(ErrorCode.AlreadyOwned),
});

// A store purchase the store has accepted but not finished: Play reports
// `pending` for a payment awaiting approval, and StoreKit reports an
// ask-to-buy/deferred payment with the same code. Nothing is wrong with the
// receipt — the very same token becomes a purchased one once the store
// completes the charge — so it must never read as a failure.
const pendingPurchaseErrorSchema = z.object({
  code: z.union([z.literal(ErrorCode.Pending), z.literal(ErrorCode.DeferredPayment)]),
});

const errorMessageSchema = z.object({
  message: z.string(),
});

// Backend contract strings. The server sends these in English whatever the
// app's language is, so they are matched, never shown, and never translated.
// The first four are the account-token assertions shared with the Kilo Pass
// store flow; the last is the credit-pack completion's already-credited
// refusal (`apps/web/src/routers/credits-router.ts`).
const APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'App Store purchase account token does not match the signed-in user.';
const APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This App Store purchase isn't linked to your Kilo account. Make sure you're signed in to the Apple ID that made the purchase, then try again.";
const GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'Google Play purchase account token does not match the signed-in user.';
const GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This Google Play purchase isn't linked to your Kilo account. Make sure you're signed in to the Google account that made the purchase, then try again.";
const STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE =
  'This purchase is already linked to another Kilo account.';
// The credit-pack completion's retryable pending refusal
// (`apps/web/src/routers/credits-router.ts`, `STORE_PURCHASE_PENDING_MESSAGE`).
// Play has accepted the charge but not finished it — or the completion reached
// Play's API before the store finished the charge — so the same token verifies
// later. Matched, never shown, and never remembered as a terminal refusal.
export const STORE_PURCHASE_PENDING_MESSAGE = 'This Google Play purchase is still pending.';
const PURCHASE_ERROR_TOAST_DEDUPE_MS = 1500;

type StoreCreditPurchaseRequest =
  | { apple: { appAccountToken: string; sku: string } }
  | { google: { obfuscatedAccountId: string; skus: string[] } };

export type StoreCreditPurchaseActionsDeps = {
  // Which storefront this device buys from — the store the platform actually
  // has (see `storefront.ts`). The owner injects it so this module never
  // imports `react-native`.
  storefront: 'app_store' | 'play';
  // The account token the app attaches to the store purchase. It comes from the
  // backend catalog response (never from a store-fetched product), so recovery
  // and live purchase agree on the token even when the store fetch failed.
  appAccountToken: string;
  // Backend catalog ids for the four credit packs. Recovery matches against
  // these, not the store-fetched list, so a charged purchase is completed even
  // when the store fetch failed.
  creditPackAppleProductIds: readonly string[];
  creditPackGoogleProductIds: readonly string[];
  requestPurchase: (params: {
    request: StoreCreditPurchaseRequest;
    type: 'in-app';
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- the resolved value is intentionally unused and varies per real implementation (expo-iap's mutateAsync)
  }) => Promise<unknown>;
  completeAppStorePurchase: (input: {
    signedTransactionJws: string;
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above requestPurchase: the resolved value is intentionally unused
  }) => Promise<unknown>;
  completePlayPurchase: (input: {
    productId: string;
    purchaseToken: string;
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above requestPurchase: the resolved value is intentionally unused
  }) => Promise<unknown>;
  finishTransaction: (params: { purchase: Purchase; isConsumable: true }) => Promise<void>;
  invalidateAfterCompletion: () => Promise<void> | void;
  onPurchaseCompleted?: () => void;
  /** Receives a catalog key, never translated copy; the screen translates it. */
  showError: (errorMessageKey: string) => void;
  /**
   * Whether the account this action set belongs to is still the signed-in one.
   *
   * A store delivery or a recovery pass outlives a sign-out/sign-in: its awaits
   * keep running after the session changed. Posting a receipt under the new
   * session would bind the wrong account, and refreshing or announcing under it
   * would credit the new account's UI for the old account's grant. The caller
   * captures the auth epoch when it builds these actions and this predicate
   * reports whether that epoch is still current; it is checked before every
   * backend submission and after every await.
   */
  isAccountCurrent: () => boolean;
  /**
   * Completes the store transaction the store reported as already owned.
   *
   * Only consulted for a store-side `AlreadyOwned` refusal. For a consumable
   * credit pack that code is not proof of another Kilo account: a charge whose
   * backend completion failed leaves the purchase owned but unconsumed, so
   * retrying the same pack returns it for the same user. The owner looks the
   * outstanding transaction up and completes it; a genuine ownership refusal
   * comes back from that completion, which is where the account copy belongs.
   *
   * Returns whether the failure was handled — `true` when a completion was
   * attempted, so the credits were announced or the backend's refusal was
   * already shown. The purchase path then reports nothing itself. `false` means
   * no outstanding transaction was found (or the store or account could not
   * answer), so the store error still owes its own failure copy.
   */
  recoverOwnedPurchase?: () => Promise<boolean>;
};

type PurchaseCompletionResult =
  | { completed: true; stale?: boolean; errorMessageKey?: never }
  | { completed: false; stale?: boolean; errorMessageKey: string | null };

type PurchaseCompletionOutcome = {
  completed: boolean;
  /**
   * True when this caller is the one that announces the successful completion.
   * The store can re-deliver one transaction while its first completion is still
   * resolving, and the silent recovery pass can start a completion a live
   * delivery then joins. The announcement is claimed by the first caller that
   * wants it, so a granted credit is announced exactly once.
   */
  shouldNotifyCompletion: boolean;
  /**
   * True when the account changed while this completion was in flight. The
   * backend call already started, so its receipt is not submitted again and the
   * new account's UI is neither announced nor refreshed for it.
   */
  stale: boolean;
};

type PurchaseCompletionOptions = {
  invalidateAfterCompletion?: boolean;
  notifyErrors?: boolean;
};

type PurchaseSuccessOptions = PurchaseCompletionOptions & {
  notifyCompletion?: boolean;
};

type RecoverPurchasesOptions = PurchaseSuccessOptions & {
  creditPackAppleProductIds?: readonly string[];
  creditPackGoogleProductIds?: readonly string[];
};

type SharedPurchaseCompletion = {
  promise: Promise<PurchaseCompletionResult>;
  /**
   * True once a caller awaiting this completion has claimed the success
   * announcement. The silent recovery pass can start the completion first, so a
   * live delivery that coalesces with it must still announce the granted credit.
   */
  hasNotifier: boolean;
};

const sharedPurchaseCompletions = new Map<string, SharedPurchaseCompletion>();

// Scope for a completion whose account is not known yet (the catalog has not
// answered, so no account token exists). Each gets its own key: sharing an
// in-flight completion is only safe when the account scope is known.
let unknownAccountCompletionSequence = 0;

/**
 * Refusals that make this exact receipt permanently unacceptable. Matched by
 * message, never shown, whatever code carries them.
 *
 * A positive list on purpose. The completion router
 * (`apps/web/src/routers/credits-router.ts`) answers `BAD_REQUEST` for a receipt
 * the store will never let succeed — a revoked or wrong-bundle Apple transaction,
 * a Play purchase that is not in a purchased state — and for a receipt tied to a
 * processed refund. It answers account failures — an account-token mismatch, a
 * purchase already linked to another account — and session failures separately,
 * and those name something the user can change, so they must stay in the queue:
 * only the messages naming the receipt itself are remembered.
 */
const TERMINAL_PURCHASE_MESSAGES = {
  'We could not verify this store purchase. Please try again.': true,
  'This store purchase has been refunded, so Kilo cannot credit it.': true,
};

/**
 * Purchases the backend terminally refused in this process, with the catalog key
 * their refusal maps to. The store keeps an unfinished transaction until the app
 * finishes it, so without this memory every later recovery pass posts a payload
 * the backend already rejected. Deliberately in-memory: the next app launch
 * retries once, so a server-side change is never ignored forever.
 *
 * The key is kept, not just the id, because the silent background pass must skip
 * a remembered refusal without a word, while an explicit recovery (the store
 * reported the pack as already owned) must still surface why it can never
 * succeed — without posting the refused receipt again.
 */
const terminallyRejectedPurchases = new Map<string, string>();

/** Test seam: forget the recorded rejections, so a test starts the process over. */
export function resetTerminalPurchaseRejections(): void {
  terminallyRejectedPurchases.clear();
}

let lastPurchaseErrorToast: { message: string; shownAt: number } | null = null;

export function resetPurchaseErrorToastDedup() {
  lastPurchaseErrorToast = null;
}

// Screens that render `errorMessageKey` inline register ownership on mount so
// purchase failures don't also pop a toast behind them. Counter (not a
// boolean) so it degrades safely if more than one owner is ever mounted.
let inlineErrorOwnerCount = 0;

export function resetInlinePurchaseErrorOwnership() {
  inlineErrorOwnerCount = 0;
}

export function useInlinePurchaseErrorOwnership() {
  useEffect(() => {
    inlineErrorOwnerCount += 1;
    return () => {
      inlineErrorOwnerCount -= 1;
    };
  }, []);
}

export function isRecoverableCreditPurchase(
  purchase: Purchase,
  creditPackAppleProductIds: readonly string[],
  creditPackGoogleProductIds: readonly string[] = []
): boolean {
  if (purchase.purchaseState === 'pending') {
    return false;
  }
  if (purchase.store === 'apple') {
    return creditPackAppleProductIds.includes(purchase.productId);
  }
  if (purchase.store === 'google') {
    return creditPackGoogleProductIds.includes(purchase.productId);
  }
  return false;
}

function missingTokenKey(purchase: Purchase): string {
  return purchase.store === 'google'
    ? CREDIT_PURCHASE_MISSING_PURCHASE_TOKEN_KEY
    : CREDIT_PURCHASE_MISSING_SIGNED_TRANSACTION_KEY;
}

/**
 * The store reports the SKU as already owned.
 *
 * Not by itself proof that another Kilo account owns it: a consumable purchase
 * whose backend completion failed stays owned but unconsumed, so retrying the
 * same pack returns this code for the same user. Callers recover the
 * outstanding transaction first; only the backend's explicit ownership refusal
 * earns the different-account copy.
 */
export function isStoreAlreadyOwnedError(error: unknown): boolean {
  return alreadyOwnedPurchaseErrorSchema.safeParse(error).success;
}

/**
 * Maps a store or backend error to the catalog key the screen translates.
 * A store-side `UserCancelled` is not a failure: it maps to `null` (no toast,
 * no copy), mirroring `getKiloPassPurchaseErrorMessage`.
 */
export function getStoreCreditPurchaseErrorMessageKey(
  error: unknown,
  storefront: 'app_store' | 'play'
): string | null {
  if (userCancelledPurchaseErrorSchema.safeParse(error).success) {
    return null;
  }

  // The store has not finished the purchase (Play's pending state, StoreKit's
  // deferred payment) and the backend's pending refusal both name a state to
  // wait out, not a failure: no copy, and the purchase stays queued for the
  // later delivery.
  if (pendingPurchaseErrorSchema.safeParse(error).success) {
    return null;
  }
  if (readTrpcErrorField(error, 'message') === STORE_PURCHASE_PENDING_MESSAGE) {
    return null;
  }

  const ownedByAnotherAccountKey =
    storefront === 'play'
      ? CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_PLAY_KEY
      : CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY;

  const message = errorMessageSchema.safeParse(error).data?.message ?? '';
  if (
    message === APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE ||
    message === GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE ||
    message === STORE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE
  ) {
    return ownedByAnotherAccountKey;
  }
  if (message === APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE) {
    return CREDIT_PURCHASE_DIFFERENT_ACCOUNT_KEY;
  }
  if (message === GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE) {
    return CREDIT_PURCHASE_DIFFERENT_ACCOUNT_PLAY_KEY;
  }

  return CREDIT_PURCHASE_FAILED_KEY;
}

export function showDedupedPurchaseError(message: string) {
  if (inlineErrorOwnerCount > 0) {
    return;
  }

  const now = Date.now();
  if (
    lastPurchaseErrorToast?.message === message &&
    now - lastPurchaseErrorToast.shownAt < PURCHASE_ERROR_TOAST_DEDUPE_MS
  ) {
    return;
  }

  lastPurchaseErrorToast = { message, shownAt: now };
  toast.error(message);
}

export function getPurchaseCompletionId(purchase: Purchase): string {
  return purchase.transactionId ?? purchase.id;
}

export function createStoreCreditPurchaseActions(deps: StoreCreditPurchaseActionsDeps) {
  async function completePurchase(
    purchase: Purchase,
    options: PurchaseCompletionOptions = {}
  ): Promise<PurchaseCompletionResult> {
    // The store has accepted the charge but not finished it (Play's `pending`
    // state, StoreKit's ask-to-buy/deferred payment). Posting the token now can
    // only fail — the store has not made it purchasable yet — and that refusal
    // would be remembered as terminal, stranding a charge that is approved a
    // moment later. Leave the store transaction queued: the store re-delivers
    // it once it completes the charge, and that delivery completes it once.
    if (purchase.purchaseState === 'pending') {
      return { completed: false, errorMessageKey: null };
    }

    const token = purchase.purchaseToken;
    if (!token) {
      return { completed: false, errorMessageKey: missingTokenKey(purchase) };
    }

    // The account can change between this completion being queued and reaching
    // the backend (a recovery pass started under the old session, or a delivery
    // that waited behind another await). Never post the receipt under the new
    // session, and never report the old account's outcome onto it.
    if (!deps.isAccountCurrent()) {
      return { completed: false, stale: true, errorMessageKey: null };
    }

    try {
      await (purchase.store === 'google'
        ? deps.completePlayPurchase({
            productId: purchase.productId,
            purchaseToken: token,
          })
        : deps.completeAppStorePurchase({ signedTransactionJws: token }));
    } catch (error) {
      // Only a message that names a defect in the receipt itself is worth
      // remembering: an account or session refusal is payable after the user acts,
      // so it stays in the store queue and is posted again.
      const refusalMessage = readTrpcErrorField(error, 'message') ?? '';
      const errorMessageKey = getStoreCreditPurchaseErrorMessageKey(error, deps.storefront);
      if (Object.hasOwn(TERMINAL_PURCHASE_MESSAGES, refusalMessage) && errorMessageKey) {
        // Remember the key the refusal maps to, so a later explicit recovery can
        // show it without posting this receipt again.
        terminallyRejectedPurchases.set(getPurchaseCompletionId(purchase), errorMessageKey);
      }
      return { completed: false, errorMessageKey };
    }

    // The account can also change while the backend answers. The grant is the
    // old session's, so the new account's UI must not be told about it: no
    // announcement, no balance refresh. The store transaction is still finished,
    // because the store holds it for this device whatever Kilo account is signed
    // in and leaving it queued would only re-deliver it.
    const stale = !deps.isAccountCurrent();

    // The backend granted the credits, so the purchase succeeded. Finishing the
    // store transaction and refreshing the balance are best-effort follow-ups:
    // if either fails, the store keeps re-delivering the transaction and the
    // recovery pass finishes it on the next launch. Reporting a failure here
    // would hide credits the user already owns and skip the success signal.
    try {
      await deps.finishTransaction({ purchase, isConsumable: true });
    } catch {
      // The store still holds the unfinished transaction; recovery retries it.
    }
    if (!stale && (options.invalidateAfterCompletion ?? true)) {
      try {
        await deps.invalidateAfterCompletion();
      } catch {
        // The balance refresh is cosmetic; the screen refetches on focus.
      }
    }
    return { completed: true, stale };
  }

  function reportPurchaseCompletionErrorIfNeeded(
    result: PurchaseCompletionResult,
    options: PurchaseCompletionOptions
  ) {
    if (
      !result.completed &&
      result.errorMessageKey &&
      (options.notifyErrors ?? true) &&
      deps.isAccountCurrent()
    ) {
      deps.showError(result.errorMessageKey);
    }
  }

  async function completePurchaseOnce(
    purchase: Purchase,
    options: PurchaseSuccessOptions = {}
  ): Promise<PurchaseCompletionOutcome> {
    // Keyed by the account submitting it as well as the transaction. A
    // completion is posted under `deps.appAccountToken`, the backend's per-user
    // `app_store_account_token`, so an unresolved request may only be joined by
    // that same account: keyed by transaction id alone, a logout/login that
    // replaced the recovery mount let the new account join the old account's
    // in-flight request and inherit its ownership refusal instead of submitting
    // its own. With no token yet (the catalog has not answered) the entry is
    // unique rather than shared, so it can never be joined across accounts.
    const accountScope =
      deps.appAccountToken === ''
        ? `unknown-account-${(unknownAccountCompletionSequence += 1)}`
        : deps.appAccountToken;
    const purchaseId = `${accountScope}\u0000${getPurchaseCompletionId(purchase)}`;
    const notifyCompletion = options.notifyCompletion ?? true;
    const existingCompletion = sharedPurchaseCompletions.get(purchaseId);
    if (existingCompletion) {
      // A joiner announces only when the in-flight completion has no notifying
      // caller yet: the silent recovery pass can start it, and a live delivery
      // that coalesces with it must still announce the granted credit once.
      const shouldNotifyCompletion = notifyCompletion && !existingCompletion.hasNotifier;
      existingCompletion.hasNotifier = existingCompletion.hasNotifier || notifyCompletion;
      const result = await existingCompletion.promise;
      reportPurchaseCompletionErrorIfNeeded(result, options);
      return {
        completed: result.completed,
        // Re-checked after the await: the account may have changed while this
        // caller waited on the shared completion.
        shouldNotifyCompletion: shouldNotifyCompletion && deps.isAccountCurrent(),
        stale: result.stale ?? false,
      };
    }

    const completion: SharedPurchaseCompletion = {
      promise: completePurchase(purchase, options),
      hasNotifier: notifyCompletion,
    };
    sharedPurchaseCompletions.set(purchaseId, completion);
    try {
      const result = await completion.promise;
      reportPurchaseCompletionErrorIfNeeded(result, options);
      return {
        completed: result.completed,
        shouldNotifyCompletion: notifyCompletion && deps.isAccountCurrent(),
        stale: result.stale ?? false,
      };
    } finally {
      sharedPurchaseCompletions.delete(purchaseId);
    }
  }

  async function completeAndAnnounce(
    purchase: Purchase,
    options: PurchaseSuccessOptions = {}
  ): Promise<PurchaseCompletionOutcome> {
    const outcome = await completePurchaseOnce(purchase, options);
    // One announcement per granted completion: a re-delivery that joins a
    // notifying caller stays silent, and a live delivery that coalesces with the
    // silent recovery pass is that completion's first notifier.
    if (outcome.shouldNotifyCompletion && outcome.completed) {
      deps.onPurchaseCompleted?.();
    }
    return outcome;
  }

  async function handlePurchaseSuccess(
    purchase: Purchase,
    options: PurchaseSuccessOptions = {}
  ): Promise<boolean> {
    const outcome = await completeAndAnnounce(purchase, options);
    return outcome.completed;
  }

  async function recoverPurchases(
    purchases: Purchase[],
    options: RecoverPurchasesOptions = {}
  ): Promise<Purchase[]> {
    const creditPackAppleProductIds =
      options.creditPackAppleProductIds ?? deps.creditPackAppleProductIds;
    const creditPackGoogleProductIds =
      options.creditPackGoogleProductIds ?? deps.creditPackGoogleProductIds;
    // One completion per store transaction: a store that lists the same
    // transaction twice must not be completed twice. A payload the backend named
    // as defective is never posted again: posting it can never succeed, and the
    // store keeps re-delivering it. The next app launch retries it once.
    const seenCompletionIds = new Set<string>();
    const rememberedRejections: string[] = [];
    const eligiblePurchases = purchases.filter(purchase => {
      const id = getPurchaseCompletionId(purchase);
      const rememberedErrorMessageKey = terminallyRejectedPurchases.get(id);
      if (rememberedErrorMessageKey !== undefined) {
        // The silent background pass skips a remembered refusal without a word.
        // An explicit recovery must still say why this purchase can never
        // complete, once per pass, without posting the refused receipt again.
        if ((options.notifyErrors ?? false) && !seenCompletionIds.has(id)) {
          seenCompletionIds.add(id);
          rememberedRejections.push(rememberedErrorMessageKey);
        }
        return false;
      }
      if (
        !isRecoverableCreditPurchase(
          purchase,
          creditPackAppleProductIds,
          creditPackGoogleProductIds
        )
      ) {
        return false;
      }
      if (seenCompletionIds.has(id)) {
        return false;
      }
      seenCompletionIds.add(id);
      return true;
    });

    // A remembered refusal belongs to the account that asked for it: a session
    // change while this pass ran must not report the old account's refusal onto
    // the new one.
    if (deps.isAccountCurrent()) {
      for (const errorMessageKey of rememberedRejections) {
        deps.showError(errorMessageKey);
      }
    }

    const recoveryResults = await Promise.all(
      eligiblePurchases.map(async purchase => ({
        outcome: await completeAndAnnounce(purchase, {
          invalidateAfterCompletion: false,
          // The silent background pass announces nothing; a recovery the user
          // triggered (the store reported the pack as already owned) still
          // announces the credits it completes.
          notifyCompletion: options.notifyCompletion ?? false,
          notifyErrors: options.notifyErrors ?? false,
        }),
        purchase,
      }))
    );
    // A completion that outlived its account is not reported and does not
    // refresh the new account's balance: the grant, if any, is the old
    // session's, and its own UI is gone.
    const completedPurchases = recoveryResults
      .filter(result => result.outcome.completed && !result.outcome.stale)
      .map(result => result.purchase);
    if (completedPurchases.length > 0) {
      await deps.invalidateAfterCompletion();
    }
    return completedPurchases;
  }

  return {
    purchase: async (pack: StoreCreditProduct): Promise<boolean> => {
      const storeProductId = pack.storeProductId;
      if (!storeProductId) {
        // The store priced no such pack; the screen disables the row, so this
        // only guards a stale tap.
        return false;
      }

      try {
        const request: StoreCreditPurchaseRequest =
          deps.storefront === 'play'
            ? {
                google: {
                  obfuscatedAccountId: deps.appAccountToken,
                  skus: [storeProductId],
                },
              }
            : {
                apple: { appAccountToken: deps.appAccountToken, sku: storeProductId },
              };
        await deps.requestPurchase({ request, type: 'in-app' });
        return true;
      } catch (error) {
        if (
          isStoreAlreadyOwnedError(error) &&
          deps.recoverOwnedPurchase &&
          (await deps.recoverOwnedPurchase())
        ) {
          // The store says the pack is already owned. Recover the outstanding
          // transaction before saying anything: for a consumable it is usually
          // a charge whose backend completion failed, owned by this same user.
          // A real cross-account refusal surfaces from that completion.
          return false;
        }
        const errorMessageKey = getStoreCreditPurchaseErrorMessageKey(error, deps.storefront);
        if (errorMessageKey) {
          deps.showError(errorMessageKey);
        }
        return false;
      }
    },
    handlePurchaseSuccess,
    recoverPurchases,
  };
}
