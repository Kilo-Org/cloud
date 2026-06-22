/* eslint-disable max-lines */

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
  ErrorCode,
  getAvailablePurchases as getAvailableIapPurchases,
  type Purchase,
  useIAP,
} from 'expo-iap';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';
import { z } from 'zod';

import { useTRPC } from '@/lib/trpc';
import { type AppStoreKiloPassProduct } from './store-products';
import {
  type AppStoreKiloPassOwnershipPreflight,
  getAppStoreKiloPassOwnershipPreflight,
} from './subscription-card-state';

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
  'This App Store subscription is linked to another Kilo account.';
const APP_STORE_PURCHASE_NOT_LINKED_USER_MESSAGE =
  "This App Store purchase isn't linked to your Kilo account. Sign in to the Apple ID used for the purchase, then try again.";
const PURCHASE_ERROR_TOAST_DEDUPE_MS = 1500;
const RESTORE_PURCHASES_ERROR_MESSAGE = 'Failed to restore purchases. Try again.';

type AppStoreKiloPassPurchaseActionsDeps = {
  requestPurchase: (params: {
    request: { apple: { appAccountToken: string; sku: string } };
    type: 'subs';
  }) => Promise<unknown>;
  getAvailablePurchases: () => Promise<Purchase[]>;
  restorePurchases: () => Promise<void>;
  completeAppStorePurchase: (input: { signedTransactionJws: string }) => Promise<unknown>;
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

type StoreKiloPassRestorePurchasesResult = 'restored' | 'empty' | 'failed';

type StoreKiloPassPurchaseContextValue = {
  appStoreOwnershipPreflight: AppStoreKiloPassOwnershipPreflight;
  purchase: (
    product: AppStoreKiloPassProduct,
    options?: StoreKiloPassPurchaseOptions
  ) => Promise<void>;
  restorePurchases: () => Promise<StoreKiloPassRestorePurchasesResult>;
  isPending: boolean;
  isRestoringPurchases: boolean;
};

const StoreKiloPassPurchaseContext = createContext<StoreKiloPassPurchaseContextValue | null>(null);
type PurchaseCompletionResult =
  | { completed: true; errorMessage?: never }
  | { completed: false; errorMessage: string | null };

const sharedPurchaseCompletions = new Map<string, Promise<PurchaseCompletionResult>>();
let lastPurchaseErrorToast: { message: string; shownAt: number } | null = null;

export function resetPurchaseErrorToastDedup() {
  lastPurchaseErrorToast = null;
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

function isRecoverableKiloPassPurchase(
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

function getKiloPassPurchaseErrorMessage(error: unknown, fallback: string): string | null {
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

function showDedupedPurchaseError(message: string) {
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

function getPurchaseCompletionId(purchase: Purchase): string {
  return purchase.transactionId ?? purchase.id;
}

export function createAppStoreKiloPassPurchaseActions(deps: AppStoreKiloPassPurchaseActionsDeps) {
  async function completePurchase(
    purchase: Purchase,
    options: PurchaseCompletionOptions = {}
  ): Promise<PurchaseCompletionResult> {
    try {
      const signedTransactionJws = getPurchaseToken(purchase);
      await deps.completeAppStorePurchase({ signedTransactionJws });
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

export function StoreKiloPassPurchaseProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isRequestingPurchase, setIsRequestingPurchase] = useState(false);
  const [isRestoringPurchases, setIsRestoringPurchases] = useState(false);
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const recoveryInFlightPurchaseIdsRef = useRef(new Set<string>());
  const activePurchaseRequestRef = useRef<{ sku: string } | null>(null);
  const pendingPurchaseCompletedCallbackRef = useRef<(() => void) | null>(null);
  const completeAppStorePurchase = useMutation(
    trpc.kiloPass.completeAppStorePurchase.mutationOptions()
  );
  const mobileStoreProductsQuery = useQuery({
    ...trpc.kiloPass.getMobileStoreProducts.queryOptions(),
    enabled: Platform.OS === 'ios',
  });
  const { refetch: refetchMobileStoreProducts } = mobileStoreProductsQuery;
  const enabledAppleProductIds = useMemo(
    () => mobileStoreProductsQuery.data?.products.map(product => product.appleProductId) ?? [],
    [mobileStoreProductsQuery.data]
  );
  const invalidateAfterCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getCreditHistory.pathFilter()),
    ]);
  }, [queryClient, trpc]);

  const releasePurchaseRequest = useCallback(() => {
    activePurchaseRequestRef.current = null;
    pendingPurchaseCompletedCallbackRef.current = null;
    setIsRequestingPurchase(false);
  }, []);

  const actionsRef = useIAP({
    onPurchaseError: error => {
      pendingPurchaseCompletedCallbackRef.current = null;
      releasePurchaseRequest();
      const message = getKiloPassPurchaseErrorMessage(error, error.message);
      if (message) {
        showDedupedPurchaseError(message);
      }
    },
    onPurchaseSuccess: purchase => {
      if (!isRecoverableKiloPassPurchase(purchase, enabledAppleProductIds)) {
        releasePurchaseRequest();
        return;
      }

      if (activePurchaseRequestRef.current?.sku !== purchase.productId) {
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
    getAvailablePurchases,
    requestPurchase,
    restorePurchases: restoreStorePurchases,
  } = actionsRef;
  const appStoreOwnershipPreflight = useMemo(
    () =>
      getAppStoreKiloPassOwnershipPreflight({
        availablePurchases,
        currentAppAccountToken: mobileStoreProductsQuery.data?.appAccountToken,
        enabledAppleProductIds,
        platformOS: Platform.OS,
      }),
    [availablePurchases, enabledAppleProductIds, mobileStoreProductsQuery.data?.appAccountToken]
  );

  const actions = useMemo(
    () =>
      createAppStoreKiloPassPurchaseActions({
        requestPurchase,
        getAvailablePurchases: getAvailableIapPurchases,
        restorePurchases: restoreStorePurchases,
        completeAppStorePurchase: completeAppStorePurchase.mutateAsync,
        enabledAppleProductIds,
        loadEnabledAppleProductIds: async () => {
          const result = await refetchMobileStoreProducts();
          return result.data?.products.map(product => product.appleProductId) ?? [];
        },
        finishTransaction,
        invalidateAfterCompletion,
        onPurchaseCompleted: () => {
          const onCompleted = pendingPurchaseCompletedCallbackRef.current;
          pendingPurchaseCompletedCallbackRef.current = null;
          onCompleted?.();
        },
        setPendingPurchaseCompletedCallback: onCompleted => {
          pendingPurchaseCompletedCallbackRef.current = onCompleted;
        },
        showError: message => {
          showDedupedPurchaseError(message);
        },
      }),
    [
      completeAppStorePurchase.mutateAsync,
      enabledAppleProductIds,
      finishTransaction,
      invalidateAfterCompletion,
      refetchMobileStoreProducts,
      requestPurchase,
      restoreStorePurchases,
    ]
  );

  const startPurchase = useCallback(
    async (product: AppStoreKiloPassProduct, options: StoreKiloPassPurchaseOptions = {}) => {
      if (activePurchaseRequestRef.current || completeAppStorePurchase.isPending) {
        return;
      }

      activePurchaseRequestRef.current = { sku: product.appleProductId };
      setIsRequestingPurchase(true);
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
    [actions, completeAppStorePurchase.isPending, releasePurchaseRequest]
  );

  const restorePurchases = useCallback(async (): Promise<StoreKiloPassRestorePurchasesResult> => {
    if (
      activePurchaseRequestRef.current ||
      isRestoringPurchases ||
      completeAppStorePurchase.isPending
    ) {
      return 'failed';
    }

    setIsRestoringPurchases(true);
    try {
      return await actions.restorePurchases();
    } finally {
      setIsRestoringPurchases(false);
    }
  }, [actions, completeAppStorePurchase.isPending, isRestoringPurchases]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || !connected) {
      return;
    }

    void getAvailablePurchases();
  }, [connected, getAvailablePurchases]);

  useEffect(() => {
    if (
      Platform.OS !== 'ios' ||
      availablePurchases.length === 0 ||
      enabledAppleProductIds.length === 0
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
  }, [actions, availablePurchases, enabledAppleProductIds.length]);

  const value = useMemo(
    () => ({
      appStoreOwnershipPreflight,
      purchase: startPurchase,
      restorePurchases,
      isPending: isRequestingPurchase || completeAppStorePurchase.isPending || isRestoringPurchases,
      isRestoringPurchases,
    }),
    [
      appStoreOwnershipPreflight,
      completeAppStorePurchase.isPending,
      isRequestingPurchase,
      isRestoringPurchases,
      restorePurchases,
      startPurchase,
    ]
  );

  return createElement(StoreKiloPassPurchaseContext.Provider, { value }, children);
}

export function useStoreKiloPassPurchase() {
  const context = useContext(StoreKiloPassPurchaseContext);
  if (!context) {
    throw new Error('useStoreKiloPassPurchase must be used within StoreKiloPassPurchaseProvider.');
  }

  return context;
}
