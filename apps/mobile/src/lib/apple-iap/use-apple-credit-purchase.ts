import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';
import {
  finishStoreKitTransaction,
  getUnfinishedStoreKitPurchases,
  purchaseStoreKitProduct,
  type StoreKitPurchaseResult,
} from './storekit';

export function useAppleCreditPurchase() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const completeAppleCreditPurchase = useMutation(
    trpc.user.completeAppleCreditPurchase.mutationOptions()
  );

  const completePurchase = async (purchase: StoreKitPurchaseResult) => {
    const result = await completeAppleCreditPurchase.mutateAsync({
      transactionJws: purchase.transactionJws,
    });
    await queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter());
    await queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter());
    await finishStoreKitTransaction(purchase.nativeTransaction);
    return result;
  };

  const purchaseProduct = async (productId: string) => {
    const purchase = await purchaseStoreKitProduct(productId);
    return completePurchase(purchase);
  };

  const recoverUnfinishedPurchases = async (productIds: string[]) => {
    const purchases = await getUnfinishedStoreKitPurchases(productIds);
    const completionPromises = [];
    for (const purchase of purchases) {
      completionPromises.push(completePurchase(purchase));
    }
    return Promise.all(completionPromises);
  };

  return {
    isPending: completeAppleCreditPurchase.isPending,
    error: completeAppleCreditPurchase.error,
    purchaseProduct,
    recoverUnfinishedPurchases,
  };
}
