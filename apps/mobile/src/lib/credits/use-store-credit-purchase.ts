/* eslint-disable max-lines -- The one-off credit-pack store lifecycle (request, completion, recovery, error mapping) is a single contract and reads best in one place. */

import { useEffect } from 'react';
import { ErrorCode, type Purchase } from 'expo-iap';
import { toast } from 'sonner-native';
import { z } from 'zod';

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
const PURCHASE_ERROR_TOAST_DEDUPE_MS = 1500;

type StoreCreditPurchaseRequest =
  | { apple: { appAccountToken: string; sku: string } }
  | { google: { obfuscatedAccountId: string; skus: string[] } };

export type StoreCreditPurchaseActionsDeps = {
  // Which storefront the current device buys from. The owner injects this from
  // `Platform.OS` so this module never imports `react-native`.
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
};

type PurchaseCompletionResult =
  | { completed: true; errorMessageKey?: never }
  | { completed: false; errorMessageKey: string | null };

type PurchaseCompletionOptions = {
  invalidateAfterCompletion?: boolean;
  notifyErrors?: boolean;
};

type PurchaseSuccessOptions = PurchaseCompletionOptions & {
  notifyCompletion?: boolean;
};

type RecoverPurchasesOptions = PurchaseCompletionOptions & {
  creditPackAppleProductIds?: readonly string[];
  creditPackGoogleProductIds?: readonly string[];
};

const sharedPurchaseCompletions = new Map<string, Promise<PurchaseCompletionResult>>();
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

  const ownedByAnotherAccountKey =
    storefront === 'play'
      ? CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_PLAY_KEY
      : CREDIT_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT_KEY;

  if (alreadyOwnedPurchaseErrorSchema.safeParse(error).success) {
    return ownedByAnotherAccountKey;
  }

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
    const token = purchase.purchaseToken;
    if (!token) {
      return { completed: false, errorMessageKey: missingTokenKey(purchase) };
    }

    try {
      await (purchase.store === 'google'
        ? deps.completePlayPurchase({
            productId: purchase.productId,
            purchaseToken: token,
          })
        : deps.completeAppStorePurchase({ signedTransactionJws: token }));
    } catch (error) {
      return {
        completed: false,
        errorMessageKey: getStoreCreditPurchaseErrorMessageKey(error, deps.storefront),
      };
    }

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
    if (options.invalidateAfterCompletion ?? true) {
      try {
        await deps.invalidateAfterCompletion();
      } catch {
        // The balance refresh is cosmetic; the screen refetches on focus.
      }
    }
    return { completed: true };
  }

  function reportPurchaseCompletionErrorIfNeeded(
    result: PurchaseCompletionResult,
    options: PurchaseCompletionOptions
  ) {
    if (!result.completed && result.errorMessageKey && (options.notifyErrors ?? true)) {
      deps.showError(result.errorMessageKey);
    }
  }

  async function completePurchaseOnce(
    purchase: Purchase,
    options: PurchaseCompletionOptions = {}
  ): Promise<boolean> {
    const purchaseId = getPurchaseCompletionId(purchase);
    const existingCompletion = sharedPurchaseCompletions.get(purchaseId);
    if (existingCompletion) {
      const result = await existingCompletion;
      reportPurchaseCompletionErrorIfNeeded(result, options);
      return result.completed;
    }

    const completion = completePurchase(purchase, options);
    sharedPurchaseCompletions.set(purchaseId, completion);
    try {
      const result = await completion;
      reportPurchaseCompletionErrorIfNeeded(result, options);
      return result.completed;
    } finally {
      sharedPurchaseCompletions.delete(purchaseId);
    }
  }

  async function handlePurchaseSuccess(
    purchase: Purchase,
    options: PurchaseSuccessOptions = {}
  ): Promise<boolean> {
    const completed = await completePurchaseOnce(purchase, options);
    if ((options.notifyCompletion ?? true) && completed) {
      deps.onPurchaseCompleted?.();
    }
    return completed;
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
    // transaction twice must not be completed twice.
    const seenCompletionIds = new Set<string>();
    const eligiblePurchases = purchases.filter(purchase => {
      if (
        !isRecoverableCreditPurchase(
          purchase,
          creditPackAppleProductIds,
          creditPackGoogleProductIds
        )
      ) {
        return false;
      }
      const id = getPurchaseCompletionId(purchase);
      if (seenCompletionIds.has(id)) {
        return false;
      }
      seenCompletionIds.add(id);
      return true;
    });

    const recoveryResults = await Promise.all(
      eligiblePurchases.map(async purchase => ({
        completed: await handlePurchaseSuccess(purchase, {
          invalidateAfterCompletion: false,
          notifyCompletion: false,
          notifyErrors: options.notifyErrors ?? false,
        }),
        purchase,
      }))
    );
    const completedPurchases = recoveryResults
      .filter(result => result.completed)
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
