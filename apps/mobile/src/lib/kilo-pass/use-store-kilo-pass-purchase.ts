import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Purchase, useIAP } from 'expo-iap';
import { Platform } from 'react-native';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';
import { type AppStoreKiloPassProduct } from './store-products';

type AppStoreKiloPassPurchaseActionsDeps = {
  requestPurchase: (params: {
    request: { apple: { sku: string } };
    type: 'subs';
  }) => Promise<unknown>;
  completeAppStorePurchase: (input: { signedTransactionJws: string }) => Promise<unknown>;
  finishTransaction: (params: { purchase: Purchase; isConsumable: false }) => Promise<void>;
  invalidateAfterCompletion: () => Promise<void> | void;
  showError: (message: string) => void;
};

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

export function createAppStoreKiloPassPurchaseActions(deps: AppStoreKiloPassPurchaseActionsDeps) {
  async function handlePurchaseSuccess(purchase: Purchase) {
    try {
      const signedTransactionJws = getPurchaseToken(purchase);
      await deps.completeAppStorePurchase({ signedTransactionJws });
      await deps.invalidateAfterCompletion();
      await deps.finishTransaction({ purchase, isConsumable: false });
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : 'Failed to complete purchase.');
    }
  }

  return {
    purchase: async (product: AppStoreKiloPassProduct) => {
      await deps.requestPurchase({
        request: { apple: { sku: product.appleProductId } },
        type: 'subs',
      });
    },
    handlePurchaseSuccess,
    recoverPurchases: async (purchases: Purchase[]) => {
      await Promise.all(
        purchases
          .filter(purchase => isRecoverableKiloPassPurchase(purchase))
          .map(async purchase => {
            await handlePurchaseSuccess(purchase);
          })
      );
    },
  };
}

export function useStoreKiloPassPurchase() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const recoveredPurchaseIdsRef = useRef(new Set<string>());
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
        showError: message => {
          toast.error(message);
        },
      }),
    [
      completeAppStorePurchase.mutateAsync,
      finishTransaction,
      invalidateAfterCompletion,
      requestPurchase,
    ]
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

    const unrecoveredPurchases = availablePurchases.filter(purchase => {
      const id = purchase.transactionId ?? purchase.id;
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
    purchase: actions.purchase,
    isPending: completeAppStorePurchase.isPending,
  };
}
