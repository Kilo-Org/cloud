import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProducts as fetchIapProducts, type ProductOrSubscription, useIAP } from 'expo-iap';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';
import { type StoreKiloPassProduct } from './store-products';
import { getStoreKiloPassProductsState } from './store-products-state';
import {
  loadAppStoreKiloPassProducts,
  NO_MATCHING_KILO_PASS_PRODUCTS_MESSAGE,
} from './store-products-loader';

const STORE_KILO_PASS_PRODUCTS_STALE_TIME_MS = 5 * 60 * 1000;

function toStoreKiloPassProduct(product: ProductOrSubscription): StoreKiloPassProduct | null {
  if (product.type !== 'subs') {
    return null;
  }

  return {
    id: product.id,
    displayPrice: product.displayPrice,
    title: product.title,
    description: product.description,
  };
}

async function fetchAppStoreSubscriptions(productSkus: string[]): Promise<StoreKiloPassProduct[]> {
  const products = await fetchIapProducts({
    skus: productSkus,
    type: 'subs',
  });

  const storeProducts: StoreKiloPassProduct[] = [];
  for (const product of products ?? []) {
    const storeProduct = toStoreKiloPassProduct(product);
    if (storeProduct) {
      storeProducts.push(storeProduct);
    }
  }

  return storeProducts;
}

export function useStoreKiloPassProducts() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [storeErrorMessage, setStoreErrorMessage] = useState<string | null>(null);

  const { connected } = useIAP({
    onError: error => {
      const message = error.message;
      setStoreErrorMessage(message);
      toast.error(message);
    },
  });

  const productsQuery = useQuery({
    queryKey: ['kilo-pass', 'app-store-products'],
    queryFn: async () => {
      const loadedProducts = await loadAppStoreKiloPassProducts({
        fetchStoreProducts: fetchAppStoreSubscriptions,
        loadBackendProducts: async () => {
          const backendResponse = await queryClient.fetchQuery(
            trpc.kiloPass.getMobileStoreProducts.queryOptions()
          );
          return backendResponse;
        },
      });
      return loadedProducts;
    },
    enabled: Platform.OS === 'ios' && connected,
    staleTime: STORE_KILO_PASS_PRODUCTS_STALE_TIME_MS,
  });

  const { refetch: refetchProducts } = productsQuery;
  const refetch = useCallback(async () => {
    setStoreErrorMessage(null);
    await refetchProducts();
  }, [refetchProducts]);

  const queryErrorMessage =
    productsQuery.error instanceof Error ? productsQuery.error.message : null;

  useEffect(() => {
    if (queryErrorMessage && queryErrorMessage !== NO_MATCHING_KILO_PASS_PRODUCTS_MESSAGE) {
      toast.error(queryErrorMessage);
    }
  }, [queryErrorMessage]);

  useEffect(() => {
    if (productsQuery.isSuccess) {
      setStoreErrorMessage(null);
    }
  }, [productsQuery.isSuccess]);

  const productsState = getStoreKiloPassProductsState({
    data: productsQuery.data,
    isError: productsQuery.isError,
    storeErrorMessage,
    queryErrorMessage,
  });

  return {
    products: productsState.products,
    isLoading:
      storeErrorMessage === null &&
      (productsQuery.isLoading || (Platform.OS === 'ios' && !connected)),
    isRefetching: productsQuery.isRefetching,
    isError: productsState.isError,
    errorMessage: productsState.errorMessage,
    refetch,
  };
}
