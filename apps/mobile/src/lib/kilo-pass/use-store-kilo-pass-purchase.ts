import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Purchase, useIAP } from 'expo-iap';
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

function getPurchaseToken(purchase: Purchase): string {
  const token = purchase.purchaseToken;
  if (!token) {
    throw new Error('App Store purchase did not include a signed transaction JWS.');
  }
  return token;
}

export function createAppStoreKiloPassPurchaseActions(deps: AppStoreKiloPassPurchaseActionsDeps) {
  return {
    purchase: async (product: AppStoreKiloPassProduct) => {
      await deps.requestPurchase({
        request: { apple: { sku: product.appleProductId } },
        type: 'subs',
      });
    },
    handlePurchaseSuccess: async (purchase: Purchase) => {
      try {
        const signedTransactionJws = getPurchaseToken(purchase);
        await deps.completeAppStorePurchase({ signedTransactionJws });
        await deps.invalidateAfterCompletion();
        await deps.finishTransaction({ purchase, isConsumable: false });
      } catch (error) {
        deps.showError(error instanceof Error ? error.message : 'Failed to complete purchase.');
      }
    },
  };
}

export function useStoreKiloPassPurchase() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
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

  const actions = createAppStoreKiloPassPurchaseActions({
    requestPurchase: actionsRef.requestPurchase,
    completeAppStorePurchase: completeAppStorePurchase.mutateAsync,
    finishTransaction: actionsRef.finishTransaction,
    invalidateAfterCompletion,
    showError: message => {
      toast.error(message);
    },
  });

  return {
    purchase: actions.purchase,
    isPending: completeAppStorePurchase.isPending,
  };
}
