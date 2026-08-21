/* eslint-disable max-lines */

import { useEffect } from 'react';
import { ErrorCode, type Purchase } from 'expo-iap';
import { toast } from 'sonner-native';
import { z } from 'zod';

import { type AppStoreKiloPassProduct } from './store-products';

const userCancelledPurchaseErrorSchema = z.object({
  code: z.literal(ErrorCode.UserCancelled),
});

const alreadyOwnedPurchaseErrorSchema = z.object({
  code: z.literal(ErrorCode.AlreadyOwned),
});

const errorMessageSchema = z.object({
  message: z.string(),
});

const APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE =
  'App Store purchase account token does not match the signed-in user.';
const APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE =
  "This App Store purchase isn't linked to your Kilo account. Make sure you're signed in to the Apple ID that made the purchase, then try again.";
const APP_STORE_SUBSCRIPTION_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE =
  'The Kilo Pass on this Apple Account belongs to a different Kilo account.';
const APP_STORE_PURCHASE_NOT_LINKED_USER_MESSAGE =
  "This App Store purchase isn't linked to your Kilo account. Sign in to the Apple Account used for the purchase, then try again.";
const PURCHASE_ERROR_TOAST_DEDUPE_MS = 1500;
const RESTORE_PURCHASES_ERROR_MESSAGE = 'Failed to restore purchases. Try again.';

export type AppStoreKiloPassPurchaseActionsDeps = {
  // The real implementations (expo-iap's mutateAsync, the tRPC mutation) each
  // resolve to their own concrete result; this module never reads it, only
  // awaits it, so `Promise<void>` can't stand in here — `Promise<X>` requires
  // its real `X` to be assignable to `void`, which none of the callers' true
  // return types are.
  requestPurchase: (params: {
    request: { apple: { appAccountToken: string; sku: string } };
    type: 'subs';
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above: the resolved value is intentionally unused and varies per real implementation
  }) => Promise<unknown>;
  getAvailablePurchases: () => Promise<Purchase[]>;
  restorePurchases: () => Promise<void>;
  completeAppStorePurchase: (input: {
    signedTransactionJws: string;
    platform: 'ios';
    storefront: 'app_store';
    product: 'kilo_pass';
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above requestPurchase: the resolved value is intentionally unused and varies per real implementation
  }) => Promise<unknown>;
  finishTransaction: (params: { purchase: Purchase; isConsumable: false }) => Promise<void>;
  enabledAppleProductIds: readonly string[];
  loadEnabledAppleProductIds?: () => Promise<readonly string[]>;
  invalidateAfterCompletion: () => Promise<void> | void;
  onPurchaseCompleted?: () => void;
  setPendingPurchaseCompletedCallback?: (callback: (() => void) | null) => void;
  showError: (message: string) => void;
};

type StoreKiloPassPurchaseOptions = {
  onCompleted?: () => void;
};

export type StoreKiloPassRestorePurchasesResult = 'restored' | 'empty' | 'failed';

type PurchaseCompletionResult =
  | { completed: true; errorMessage?: never }
  | { completed: false; errorMessage: string | null };

const sharedPurchaseCompletions = new Map<string, Promise<PurchaseCompletionResult>>();
let lastPurchaseErrorToast: { message: string; shownAt: number } | null = null;

export function resetPurchaseErrorToastDedup() {
  lastPurchaseErrorToast = null;
}

// Screens that render `errorMessage` inline (e.g. the subscription screen)
// register ownership on mount so purchase/restore failures don't also pop a
// toast behind them. Counter (not a boolean) so it degrades safely if more
// than one owner is ever mounted at once.
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

type PurchaseCompletionOptions = {
  invalidateAfterCompletion?: boolean;
  notifyErrors?: boolean;
};

type PurchaseSuccessOptions = PurchaseCompletionOptions & {
  notifyCompletion?: boolean;
};

type RecoverPurchasesOptions = PurchaseCompletionOptions & {
  enabledAppleProductIds?: readonly string[];
};

export function isRecoverableKiloPassPurchase(
  purchase: Purchase,
  enabledAppleProductIds: readonly string[]
): boolean {
  if (purchase.purchaseState === 'pending') {
    return false;
  }
  if (purchase.store !== 'apple') {
    return false;
  }
  return enabledAppleProductIds.includes(purchase.productId);
}

function getPurchaseToken(purchase: Purchase): string {
  const token = purchase.purchaseToken;
  if (!token) {
    throw new Error('App Store purchase did not include a signed transaction JWS.');
  }
  return token;
}

function isUserCancelledPurchaseError(error: unknown): boolean {
  return userCancelledPurchaseErrorSchema.safeParse(error).success;
}

function isAlreadyOwnedPurchaseError(error: unknown): boolean {
  return alreadyOwnedPurchaseErrorSchema.safeParse(error).success;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return errorMessageSchema.safeParse(error).data?.message ?? fallback;
}

export function getKiloPassPurchaseErrorMessage(error: unknown, fallback: string): string | null {
  if (isUserCancelledPurchaseError(error)) {
    return null;
  }

  if (isAlreadyOwnedPurchaseError(error)) {
    return APP_STORE_SUBSCRIPTION_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE;
  }

  const message = getErrorMessage(error, fallback);
  if (message === APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE) {
    return APP_STORE_SUBSCRIPTION_OWNED_BY_ANOTHER_ACCOUNT_MESSAGE;
  }
  if (message === APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE) {
    return APP_STORE_PURCHASE_NOT_LINKED_USER_MESSAGE;
  }

  return message;
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

export function createAppStoreKiloPassPurchaseActions(deps: AppStoreKiloPassPurchaseActionsDeps) {
  async function completePurchase(
    purchase: Purchase,
    options: PurchaseCompletionOptions = {}
  ): Promise<PurchaseCompletionResult> {
    try {
      const signedTransactionJws = getPurchaseToken(purchase);
      await deps.completeAppStorePurchase({
        signedTransactionJws,
        platform: 'ios',
        storefront: 'app_store',
        product: 'kilo_pass',
      });
      if (options.invalidateAfterCompletion ?? true) {
        await deps.invalidateAfterCompletion();
      }
      await deps.finishTransaction({ purchase, isConsumable: false });
      return { completed: true };
    } catch (error) {
      const message = getKiloPassPurchaseErrorMessage(error, 'Failed to complete purchase.');
      return { completed: false, errorMessage: message };
    }
  }

  function reportPurchaseCompletionErrorIfNeeded(
    result: PurchaseCompletionResult,
    options: PurchaseCompletionOptions
  ) {
    if (!result.completed && result.errorMessage && (options.notifyErrors ?? true)) {
      deps.showError(result.errorMessage);
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

  async function handlePurchaseSuccess(purchase: Purchase, options: PurchaseSuccessOptions = {}) {
    const completed = await completePurchaseOnce(purchase, options);
    if (completed && (options.notifyCompletion ?? true)) {
      deps.onPurchaseCompleted?.();
    } else if (!completed && (options.notifyCompletion ?? true)) {
      deps.setPendingPurchaseCompletedCallback?.(null);
    }
    return completed;
  }

  async function getEnabledAppleProductIdsForRestore() {
    if (deps.enabledAppleProductIds.length > 0) {
      return deps.enabledAppleProductIds;
    }
    return (await deps.loadEnabledAppleProductIds?.()) ?? [];
  }

  async function recoverPurchases(
    purchases: Purchase[],
    options: RecoverPurchasesOptions = {}
  ): Promise<Purchase[]> {
    const enabledAppleProductIds = options.enabledAppleProductIds ?? deps.enabledAppleProductIds;
    const recoveryResults = await Promise.all(
      purchases
        .filter(purchase => isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds))
        .map(async purchase => {
          const completed = await handlePurchaseSuccess(purchase, {
            invalidateAfterCompletion: false,
            notifyCompletion: false,
            notifyErrors: options.notifyErrors ?? false,
          });
          return { completed, purchase };
        })
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
    purchase: async (
      product: AppStoreKiloPassProduct,
      options: StoreKiloPassPurchaseOptions = {}
    ): Promise<boolean> => {
      try {
        deps.setPendingPurchaseCompletedCallback?.(options.onCompleted ?? null);
        await deps.requestPurchase({
          request: {
            apple: { appAccountToken: product.appAccountToken, sku: product.appleProductId },
          },
          type: 'subs',
        });
        return true;
      } catch (error) {
        const message = getKiloPassPurchaseErrorMessage(
          error,
          'Failed to start App Store purchase.'
        );
        if (message) {
          deps.showError(message);
        }
        deps.setPendingPurchaseCompletedCallback?.(null);
        return false;
      }
    },
    handlePurchaseSuccess,
    recoverPurchases,
    restorePurchases: async (): Promise<StoreKiloPassRestorePurchasesResult> => {
      try {
        await deps.restorePurchases();
        const availablePurchases = await deps.getAvailablePurchases();
        const enabledAppleProductIds = await getEnabledAppleProductIdsForRestore();
        if (enabledAppleProductIds.length === 0) {
          deps.showError(RESTORE_PURCHASES_ERROR_MESSAGE);
          return 'failed';
        }

        const kiloPassPurchases = availablePurchases.filter(purchase =>
          isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds)
        );
        if (kiloPassPurchases.length === 0) {
          return 'empty';
        }

        const completedPurchases = await recoverPurchases(kiloPassPurchases, {
          enabledAppleProductIds,
          notifyErrors: true,
        });
        return completedPurchases.length > 0 ? 'restored' : 'failed';
      } catch {
        deps.showError(RESTORE_PURCHASES_ERROR_MESSAGE);
        return 'failed';
      }
    },
  };
}
