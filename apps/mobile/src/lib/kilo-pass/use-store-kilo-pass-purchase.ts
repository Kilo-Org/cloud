import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorCode, type Purchase, useIAP } from 'expo-iap';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';
import { z } from 'zod';

import { useTRPC } from '@/lib/trpc';
import { type AppStoreKiloPassProduct } from './store-products';

const userCancelledPurchaseErrorSchema = z.object({
  code: z.literal(ErrorCode.UserCancelled),
});

type AppStoreKiloPassPurchaseActionsDeps = {
  requestPurchase: (params: {
    request: { apple: { appAccountToken: string; sku: string } };
    type: 'subs';
  }) => Promise<unknown>;
  completeAppStorePurchase: (input: { signedTransactionJws: string }) => Promise<unknown>;
  finishTransaction: (params: { purchase: Purchase; isConsumable: false }) => Promise<void>;
  invalidateAfterCompletion: () => Promise<void> | void;
  onPurchaseCompleted?: () => void;
  purchaseCompletions?: RefObject<Map<string, Promise<boolean>>>;
  showError: (message: string) => void;
};

const sharedPurchaseCompletions = new Map<string, Promise<boolean>>();

function isRecoverableKiloPassPurchase(purchase: Purchase): boolean {
  if (purchase.purchaseState === 'pending') {
    return false;
  }
  if (purchase.store !== 'apple') {
    return false;
  }
  return purchase.productId.startsWith('kilopass.');
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

function getPurchaseCompletionId(purchase: Purchase): string {
  return purchase.transactionId ?? purchase.id;
}

export function createAppStoreKiloPassPurchaseActions(deps: AppStoreKiloPassPurchaseActionsDeps) {
  async function completePurchase(purchase: Purchase): Promise<boolean> {
    try {
      const signedTransactionJws = getPurchaseToken(purchase);
      await deps.completeAppStorePurchase({ signedTransactionJws });
      await deps.invalidateAfterCompletion();
      await deps.finishTransaction({ purchase, isConsumable: false });
      return true;
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : 'Failed to complete purchase.');
      return false;
    }
  }

  async function completePurchaseOnce(purchase: Purchase): Promise<boolean> {
    const purchaseId = getPurchaseCompletionId(purchase);
    const purchaseCompletions = deps.purchaseCompletions?.current ?? sharedPurchaseCompletions;
    const existingCompletion = purchaseCompletions.get(purchaseId);
    if (existingCompletion) {
      return existingCompletion;
    }

    const completion = completePurchase(purchase);
    purchaseCompletions.set(purchaseId, completion);
    const completed = await completion;
    purchaseCompletions.delete(purchaseId);
    return completed;
  }

  async function handlePurchaseSuccess(
    purchase: Purchase,
    options: { notifyCompletion?: boolean } = {}
  ) {
    const completed = await completePurchaseOnce(purchase);
    if (completed && (options.notifyCompletion ?? true)) {
      deps.onPurchaseCompleted?.();
    }
  }

  return {
    purchase: async (product: AppStoreKiloPassProduct) => {
      try {
        await deps.requestPurchase({
          request: {
            apple: { appAccountToken: product.appAccountToken, sku: product.appleProductId },
          },
          type: 'subs',
        });
      } catch (error) {
        if (isUserCancelledPurchaseError(error)) {
          return;
        }

        deps.showError(
          error instanceof Error ? error.message : 'Failed to start App Store purchase.'
        );
      }
    },
    handlePurchaseSuccess,
    recoverPurchases: async (purchases: Purchase[]) => {
      await Promise.all(
        purchases
          .filter(purchase => isRecoverableKiloPassPurchase(purchase))
          .map(async purchase => {
            await handlePurchaseSuccess(purchase, { notifyCompletion: false });
          })
      );
    },
  };
}

export function useStoreKiloPassPurchase(options: { onPurchaseCompleted?: () => void } = {}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [isRequestingPurchase, setIsRequestingPurchase] = useState(false);
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
  const purchaseCompletionsRef = useRef(new Map<string, Promise<boolean>>());
  const requestInFlightRef = useRef(false);
  const completeAppStorePurchase = useMutation(
    trpc.kiloPass.completeAppStorePurchase.mutationOptions()
  );

  const invalidateAfterCompletion = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.kiloPass.getState.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter()),
      queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter()),
      queryClient.invalidateQueries(trpc.kiloPass.getCreditHistory.pathFilter()),
    ]);
  }, [queryClient, trpc]);

  const actionsRef = useIAP({
    onPurchaseError: error => {
      if (isUserCancelledPurchaseError(error)) {
        return;
      }

      toast.error(error.message);
    },
    onPurchaseSuccess: purchase => {
      void actions.handlePurchaseSuccess(purchase);
    },
  });
  const {
    availablePurchases,
    connected,
    finishTransaction,
    getAvailablePurchases,
    requestPurchase,
  } = actionsRef;

  const actions = useMemo(
    () =>
      createAppStoreKiloPassPurchaseActions({
        requestPurchase,
        completeAppStorePurchase: completeAppStorePurchase.mutateAsync,
        finishTransaction,
        invalidateAfterCompletion,
        onPurchaseCompleted: options.onPurchaseCompleted,
        purchaseCompletions: purchaseCompletionsRef,
        showError: message => {
          toast.error(message);
        },
      }),
    [
      completeAppStorePurchase.mutateAsync,
      finishTransaction,
      invalidateAfterCompletion,
      options.onPurchaseCompleted,
      purchaseCompletionsRef,
      requestPurchase,
    ]
  );

  const startPurchase = useCallback(
    async (product: AppStoreKiloPassProduct) => {
      if (requestInFlightRef.current || completeAppStorePurchase.isPending) {
        return;
      }

      requestInFlightRef.current = true;
      setIsRequestingPurchase(true);
      try {
        await actions.purchase(product);
      } finally {
        requestInFlightRef.current = false;
        setIsRequestingPurchase(false);
      }
    },
    [actions, completeAppStorePurchase.isPending]
  );

  useEffect(() => {
    if (Platform.OS !== 'ios' || !connected) {
      return;
    }

    void getAvailablePurchases();
  }, [connected, getAvailablePurchases]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || availablePurchases.length === 0) {
      return;
    }

    const unrecoveredPurchases = availablePurchases.filter(availablePurchase => {
      const id = availablePurchase.transactionId ?? availablePurchase.id;
      if (recoveredPurchaseIdsRef.current.has(id)) {
        return false;
      }
      recoveredPurchaseIdsRef.current.add(id);
      return true;
    });

    if (unrecoveredPurchases.length > 0) {
      void actions.recoverPurchases(unrecoveredPurchases);
    }
  }, [actions, availablePurchases]);

  return {
    purchase: startPurchase,
    isPending: isRequestingPurchase || completeAppStorePurchase.isPending,
  };
}

export function StoreKiloPassPurchaseRecoveryMount() {
  useStoreKiloPassPurchase();
  return null;
}
