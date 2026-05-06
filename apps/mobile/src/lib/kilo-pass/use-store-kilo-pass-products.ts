import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useIAP } from 'expo-iap';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';
import { joinAppStoreKiloPassProducts } from './store-products';

export function useStoreKiloPassProducts() {
  const trpc = useTRPC();
  const productsQuery = useQuery(trpc.kiloPass.getMobileStoreProducts.queryOptions());
  const iap = useIAP({
    onError: error => {
      toast.error(error.message);
    },
  });

  const backendProducts = useMemo(
    () => productsQuery.data?.products ?? [],
    [productsQuery.data?.products]
  );

  useEffect(() => {
    if (!iap.connected || Platform.OS !== 'ios' || backendProducts.length === 0) {
      return;
    }

    void iap.fetchProducts({
      skus: backendProducts.map(product => product.appleProductId),
      type: 'subs',
    });
  }, [backendProducts, iap]);

  return {
    products: joinAppStoreKiloPassProducts({
      backendProducts,
      storeProducts: iap.subscriptions,
    }),
    isLoading: productsQuery.isLoading || (iap.connected && iap.subscriptions.length === 0),
    isError: productsQuery.isError,
    refetch: productsQuery.refetch,
  };
}
