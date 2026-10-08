/* eslint-disable max-lines -- Receipt completion and restoration share transaction and account fences. */
import { ErrorCode, type Purchase } from 'expo-iap';
import { z } from 'zod';

import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

const userCancelledPurchaseErrorSchema = z.object({
  code: z.literal(ErrorCode.UserCancelled),
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
const APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'App Store purchase account token does not match the signed-in user.';
const APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This App Store purchase isn't linked to your Kilo account. Make sure you're signed in to the Apple ID that made the purchase, then try again.";
const GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'Google Play purchase account token does not match the signed-in user.';
const GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This Google Play purchase isn't linked to your Kilo account. Make sure you're signed in to the Google account that made the purchase, then try again.";

export type AppStoreKiloPassPurchaseActionsDeps = {
  // Recovery uses the backend account token and historical identifiers, never
  // sale availability or a store-fetched product catalog.
  appAccountToken: string;
  getAvailablePurchases: () => Promise<Purchase[]>;
  restorePurchases: () => Promise<void>;
  completeAppStorePurchase: (input: {
    signedTransactionJws: string;
    platform: 'ios';
    storefront: 'app_store';
    product: 'kilo_pass';
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- receipt completion results are intentionally unused
  }) => Promise<unknown>;
  completePlayPurchase: (input: {
    purchaseToken: string;
    platform: 'android';
    storefront: 'play';
    product: 'kilo_pass';
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- receipt completion results are intentionally unused
  }) => Promise<unknown>;
  finishTransaction: (params: { purchase: Purchase; isConsumable: false }) => Promise<void>;
  enabledAppleProductIds: readonly string[];
  enabledGoogleProductIds: readonly string[];
  invalidateAfterCompletion: () => Promise<void> | void;
  /**
   * Whether the account this action set belongs to is still the signed-in one.
   *
   * A recovery pass or a store delivery outlives a sign-out/sign-in: its awaits
   * keep running after the session changed. Posting a receipt under the new
   * session would bind the wrong account, and refreshing or announcing under it
   * would credit the new account's UI for the old account's grant. The caller
   * captures the auth epoch when it builds these actions and this predicate
   * reports whether that epoch is still current; it is checked before every
   * backend submission and after every await.
   */
  isAccountCurrent: () => boolean;
  showError: (message: string) => void;
};

export type StoreKiloPassRestorePurchasesResult = 'restored' | 'empty' | 'failed';

type PurchaseCompletionResult =
  | { completed: true; stale?: boolean; errorMessage?: never }
  | { completed: false; stale?: boolean; errorMessage: string | null };

type PurchaseCompletionOutcome = {
  completed: boolean;
  /**
   * True when the account changed while this completion was in flight. The
   * backend call already started, so its receipt is not submitted again and the
   * new account's UI is neither announced nor refreshed for it.
   */
  stale: boolean;
};

// Keyed by the account submitting the completion as well as the transaction: a
// completion is posted under `deps.appAccountToken`, the backend's per-user
// `app_store_account_token`, so an unresolved request may only be joined by that
// same account. With no token yet (the catalog has not answered) the entry is
// unique rather than shared, so it can never be joined across accounts.
const sharedPurchaseCompletions = new Map<string, Promise<PurchaseCompletionResult>>();

// Scope for a completion whose account is not known yet (the catalog has not
// answered, so no account token exists). Each gets its own key: sharing an
// in-flight completion is only safe when the account scope is known.
let unknownAccountCompletionSequence = 0;

/**
 * Purchases the backend terminally refused in this process. The store keeps an
 * unfinished transaction until the app finishes it, so without this memory every
 * later pass posts a payload the backend already rejected, and logs an error each
 * time. Deliberately in-memory: the next app launch retries once, so a server-side
 * change is never ignored forever.
 */
const terminallyRejectedPurchaseIds = new Set<string>();

/** Test seam: forget the recorded rejections, so a test starts the process over. */
export function resetTerminalPurchaseRejections(): void {
  terminallyRejectedPurchaseIds.clear();
}

/**
 * Match only receipt-verification failures. The router also uses BAD_REQUEST
 * for account-token and account-state refusals, which can succeed after the
 * user changes accounts. Unknown failures stay retryable.
 */
const TERMINAL_PURCHASE_MESSAGES = {
  'We could not verify this App Store purchase. Please try again.': true,
  'We could not verify this Google Play purchase. Please try again.': true,
};

type PurchaseCompletionOptions = {
  invalidateAfterCompletion?: boolean;
  notifyErrors?: boolean;
};

type RecoverPurchasesOptions = PurchaseCompletionOptions & {
  enabledAppleProductIds?: readonly string[];
  enabledGoogleProductIds?: readonly string[];
  /**
   * An explicit user action. Post even a purchase the backend already refused, so a
   * restore is never silently empty.
   */
  ignoreRejectionMemory?: boolean;
};

export function isRecoverableKiloPassPurchase(
  purchase: Purchase,
  enabledAppleProductIds: readonly string[],
  enabledGoogleProductIds: readonly string[] = []
): boolean {
  if (purchase.purchaseState === 'pending') {
    return false;
  }
  if (purchase.store === 'apple') {
    return enabledAppleProductIds.includes(purchase.productId);
  }
  if (purchase.store === 'google') {
    return enabledGoogleProductIds.includes(purchase.productId);
  }
  return false;
}

function getPurchaseToken(purchase: Purchase): string {
  const token = purchase.purchaseToken;
  if (!token) {
    throw new Error(
      i18n.t(
        purchase.store === 'google'
          ? 'kiloPass.purchaseMissingPurchaseToken'
          : 'kiloPass.purchaseMissingSignedTransaction'
      )
    );
  }
  return token;
}

function isUserCancelledPurchaseError(error: unknown): boolean {
  return userCancelledPurchaseErrorSchema.safeParse(error).success;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return errorMessageSchema.safeParse(error).data?.message ?? fallback;
}

export function getKiloPassPurchaseErrorMessage(error: unknown, fallback: string): string | null {
  if (isUserCancelledPurchaseError(error)) {
    return null;
  }

  // The store has not finished the purchase (Play's pending state, StoreKit's
  // deferred payment). It is a state to wait out, not a failure: the store
  // re-delivers the transaction once it completes the charge, and that delivery
  // carries the same token.
  if (pendingPurchaseErrorSchema.safeParse(error).success) {
    return null;
  }

  const message = getErrorMessage(error, fallback);
  if (message === APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE) {
    return i18n.t('kiloPass.purchaseOwnedByAnotherAccount');
  }
  if (message === APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE) {
    return i18n.t('kiloPass.purchaseDifferentAccount');
  }
  if (message === GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE) {
    return i18n.t('kiloPass.purchaseOwnedByAnotherAccountPlay');
  }
  if (message === GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE) {
    return i18n.t('kiloPass.purchaseDifferentAccountPlay');
  }

  return message;
}

function getPurchaseCompletionId(purchase: Purchase): string {
  return purchase.transactionId ?? purchase.id;
}

export function createAppStoreKiloPassPurchaseActions(deps: AppStoreKiloPassPurchaseActionsDeps) {
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
      return { completed: false, stale: false, errorMessage: null };
    }

    // The account can change between this completion being queued and reaching
    // the backend (a recovery pass started under the old session, or a delivery
    // that waited behind another await). Never post the receipt under the new
    // session, and never report the old account's outcome onto it.
    if (!deps.isAccountCurrent()) {
      return { completed: false, stale: true, errorMessage: null };
    }
    try {
      const token = getPurchaseToken(purchase);
      await (purchase.store === 'google'
        ? deps.completePlayPurchase({
            purchaseToken: token,
            platform: 'android',
            storefront: 'play',
            product: 'kilo_pass',
          })
        : deps.completeAppStorePurchase({
            signedTransactionJws: token,
            platform: 'ios',
            storefront: 'app_store',
            product: 'kilo_pass',
          }));
      // The account can also change while the backend answers. The grant is the
      // old session's, so the new account's UI must not be refreshed for it.
      await deps.finishTransaction({ purchase, isConsumable: false });
      if (deps.isAccountCurrent() && (options.invalidateAfterCompletion ?? true)) {
        await deps.invalidateAfterCompletion();
      }
      return { completed: true, stale: !deps.isAccountCurrent() };
    } catch (error) {
      // Only a message that names a defect in this payload is worth remembering:
      // an account or session refusal is payable after the user acts, so it stays
      // in the store queue and is posted again.
      const refusalMessage = readTrpcErrorField(error, 'message') ?? '';
      if (Object.hasOwn(TERMINAL_PURCHASE_MESSAGES, refusalMessage)) {
        terminallyRejectedPurchaseIds.add(getPurchaseCompletionId(purchase));
      }
      // A refusal belongs to the session that submitted the receipt. Leave the
      // transaction unfinished and do not display it on a different account.
      const stale = !deps.isAccountCurrent();
      const message = stale
        ? null
        : getKiloPassPurchaseErrorMessage(error, i18n.t('kiloPass.purchaseFailed'));
      return { completed: false, stale, errorMessage: message };
    }
  }

  function reportPurchaseCompletionErrorIfNeeded(
    result: PurchaseCompletionResult,
    options: PurchaseCompletionOptions
  ) {
    if (
      !result.completed &&
      result.errorMessage &&
      (options.notifyErrors ?? true) &&
      deps.isAccountCurrent()
    ) {
      deps.showError(result.errorMessage);
    }
  }

  async function completePurchaseOnce(
    purchase: Purchase,
    options: PurchaseCompletionOptions = {}
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
    // Re-checked after the await: the account may change while this caller waits
    // on the shared completion, or between the backend answer and here, so an
    // outcome that outlived its session is always reported as stale.
    const existingCompletion = sharedPurchaseCompletions.get(purchaseId);
    if (existingCompletion) {
      const result = await existingCompletion;
      reportPurchaseCompletionErrorIfNeeded(result, options);
      return {
        completed: result.completed,
        stale: (result.stale ?? false) || !deps.isAccountCurrent(),
      };
    }

    const completion = completePurchase(purchase, options);
    sharedPurchaseCompletions.set(purchaseId, completion);
    try {
      const result = await completion;
      reportPurchaseCompletionErrorIfNeeded(result, options);
      return {
        completed: result.completed,
        stale: (result.stale ?? false) || !deps.isAccountCurrent(),
      };
    } finally {
      sharedPurchaseCompletions.delete(purchaseId);
    }
  }

  async function recoverPurchases(
    purchases: Purchase[],
    options: RecoverPurchasesOptions = {}
  ): Promise<Purchase[]> {
    const enabledAppleProductIds = options.enabledAppleProductIds ?? deps.enabledAppleProductIds;
    const enabledGoogleProductIds = options.enabledGoogleProductIds ?? deps.enabledGoogleProductIds;
    const recoveryResults = await Promise.all(
      purchases
        .filter(purchase =>
          isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds, enabledGoogleProductIds)
        )
        // The background pass honours the rejection memory. An explicit restore
        // passes `ignoreRejectionMemory`, so a user action always reaches the
        // backend.
        .filter(
          purchase =>
            options.ignoreRejectionMemory === true ||
            !terminallyRejectedPurchaseIds.has(getPurchaseCompletionId(purchase))
        )
        .map(async purchase => {
          const outcome = await completePurchaseOnce(purchase, {
            invalidateAfterCompletion: false,
            notifyErrors: options.notifyErrors ?? false,
          });
          return { outcome, purchase };
        })
    );
    // A completion that outlived its account is not reported and does not
    // refresh the new account's balance: the grant, if any, is the old
    // session's, and its own UI is gone.
    const completedPurchases = recoveryResults
      .filter(result => result.outcome.completed && !result.outcome.stale)
      .map(result => result.purchase);
    if (completedPurchases.length > 0 && deps.isAccountCurrent()) {
      await deps.invalidateAfterCompletion();
    }
    return completedPurchases;
  }

  return {
    recoverPurchases,
    restorePurchases: async (): Promise<StoreKiloPassRestorePurchasesResult> => {
      try {
        await deps.restorePurchases();
        const availablePurchases = await deps.getAvailablePurchases();
        if (!deps.isAccountCurrent()) {
          return 'failed';
        }
        const enabledAppleProductIds = deps.enabledAppleProductIds;
        const enabledGoogleProductIds = deps.enabledGoogleProductIds;
        if (enabledAppleProductIds.length === 0 && enabledGoogleProductIds.length === 0) {
          deps.showError(i18n.t('kiloPass.restoreFailed'));
          return 'failed';
        }

        const kiloPassPurchases = availablePurchases.filter(purchase =>
          isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds, enabledGoogleProductIds)
        );
        if (kiloPassPurchases.length === 0) {
          return 'empty';
        }

        const completedPurchases = await recoverPurchases(kiloPassPurchases, {
          enabledAppleProductIds,
          enabledGoogleProductIds,
          ignoreRejectionMemory: true,
          notifyErrors: true,
        });
        return completedPurchases.length > 0 ? 'restored' : 'failed';
      } catch {
        if (deps.isAccountCurrent()) {
          deps.showError(i18n.t('kiloPass.restoreFailed'));
        }
        return 'failed';
      }
    },
  };
}
