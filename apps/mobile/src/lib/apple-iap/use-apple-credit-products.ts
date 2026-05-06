import { useQuery } from '@tanstack/react-query';
import { Platform } from 'react-native';

import { useTRPC } from '@/lib/trpc';
import { fetchStoreKitProducts } from './storekit';
import { type AppleCreditDisplayProduct, type BackendAppleCreditProduct } from './types';

export function joinAppleCreditProducts(
  backendProducts: BackendAppleCreditProduct[] | undefined,
  storeKitProducts: { id: string; title: string; localizedPrice: string }[] | undefined
): AppleCreditDisplayProduct[] {
  const storeKitById = new Map((storeKitProducts ?? []).map(product => [product.id, product]));
  return (backendProducts ?? []).flatMap(product => {
    const storeKitProduct = storeKitById.get(product.id);
    if (!storeKitProduct) {
      return [];
    }
    return [
      {
        ...product,
        title: storeKitProduct.title,
        localizedPrice: storeKitProduct.localizedPrice,
      },
    ];
  });
}

export function useAppleCreditProducts() {
  const trpc = useTRPC();
  const isIos = Platform.OS === 'ios';

  const backendProducts = useQuery(
    trpc.user.getAppleCreditProducts.queryOptions(undefined, {
      enabled: isIos,
      staleTime: 5 * 60_000,
    })
  );
  const productIds = backendProducts.data?.products.map(product => product.id) ?? [];

  const storeKitProducts = useQuery({
    queryKey: ['apple-credit-storekit-products', productIds],
    queryFn: async () => {
      const products = await fetchStoreKitProducts(productIds);
      return products;
    },
    enabled: isIos && productIds.length > 0,
    staleTime: 5 * 60_000,
  });

  return {
    products: isIos ? joinAppleCreditProducts(backendProducts.data?.products, storeKitProducts.data) : [],
    isLoading: isIos && (backendProducts.isLoading || storeKitProducts.isLoading),
    isFetching: isIos && (backendProducts.isFetching || storeKitProducts.isFetching),
    isError: isIos && (backendProducts.isError || storeKitProducts.isError),
    refetch: async () => {
      await backendProducts.refetch();
      await storeKitProducts.refetch();
    },
  };
}
