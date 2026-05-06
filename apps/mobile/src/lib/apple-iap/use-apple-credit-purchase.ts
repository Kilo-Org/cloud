import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';
import { finishStoreKitTransaction, purchaseStoreKitProduct } from './storekit';

export function useAppleCreditPurchase() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const completeAppleCreditPurchase = useMutation(
    trpc.user.completeAppleCreditPurchase.mutationOptions()
  );

  const purchaseProduct = async (productId: string) => {
    const purchase = await purchaseStoreKitProduct(productId);
    const result = await completeAppleCreditPurchase.mutateAsync({
      transactionJws: purchase.transactionJws,
    });
    await queryClient.invalidateQueries(trpc.user.getContextBalance.pathFilter());
    await queryClient.invalidateQueries(trpc.user.getCreditBlocks.pathFilter());
    await finishStoreKitTransaction(purchase.nativeTransaction);
    return result;
  };

  return {
    purchaseProduct,
    isPending: completeAppleCreditPurchase.isPending,
    error: completeAppleCreditPurchase.error,
  };
}
