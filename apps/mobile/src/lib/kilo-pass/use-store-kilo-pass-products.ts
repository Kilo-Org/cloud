import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useIAP } from 'expo-iap';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';
import { joinAppStoreKiloPassProducts } from './store-products';

export function useStoreKiloPassProducts() {
  const trpc = useTRPC();
  const productsQuery = useQuery(trpc.kiloPass.getMobileStoreProducts.queryOptions());
  const [storeErrorMessage, setStoreErrorMessage] = useState<string | null>(null);
  const [isFetchingStoreProducts, setIsFetchingStoreProducts] = useState(false);
  const [hasFetchedStoreProducts, setHasFetchedStoreProducts] = useState(false);
  const iap = useIAP({
    onError: error => {
      const message = error.message;
      setStoreErrorMessage(message);
      toast.error(message);
    },
  });
  const { connected, fetchProducts, subscriptions } = iap;

  const backendProducts = useMemo(
    () => productsQuery.data?.products ?? [],
    [productsQuery.data?.products]
  );
  const productSkus = useMemo(
    () => backendProducts.map(product => product.appleProductId),
    [backendProducts]
  );

  const fetchStoreProducts = useCallback(async () => {
    if (!connected || Platform.OS !== 'ios' || productSkus.length === 0) {
      return;
    }

    setStoreErrorMessage(null);
    setHasFetchedStoreProducts(false);
    setIsFetchingStoreProducts(true);
    try {
      await fetchProducts({
        skus: productSkus,
        type: 'subs',
      });
    } catch {
      // useIAP onError owns the user-visible message.
    } finally {
      setHasFetchedStoreProducts(true);
      setIsFetchingStoreProducts(false);
    }
  }, [connected, fetchProducts, productSkus]);

  useEffect(() => {
    void fetchStoreProducts();
  }, [fetchStoreProducts]);

  const products = joinAppStoreKiloPassProducts({
    backendProducts,
    storeProducts: subscriptions,
  });

  const refetch = useCallback(async () => {
    await productsQuery.refetch();
    await fetchStoreProducts();
  }, [fetchStoreProducts, productsQuery]);

  return {
    products,
    isLoading:
      productsQuery.isLoading ||
      isFetchingStoreProducts ||
      (connected && productSkus.length > 0 && !hasFetchedStoreProducts && !storeErrorMessage),
    isError: productsQuery.isError,
    errorMessage:
      storeErrorMessage ??
      (productsQuery.error instanceof Error ? productsQuery.error.message : null) ??
      (!connected && productSkus.length > 0 ? 'App Store connection is not ready.' : null) ??
      (!productsQuery.isLoading && productSkus.length > 0 && products.length === 0
        ? 'No matching Kilo Pass products were returned by App Store.'
        : null),
    refetch,
  };
}
