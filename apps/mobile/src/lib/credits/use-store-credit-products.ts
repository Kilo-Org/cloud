import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTRPC } from '@/lib/trpc';
import { getStoreCreditProductsState, type StoreCreditProductListing } from './store-products';
import {
  getAuthoredProductsErrorMessageKey,
  loadStoreCreditProducts,
} from './store-products-loader';

const STORE_CREDIT_PRODUCTS_STALE_TIME_MS = 5 * 60 * 1000;
// Fixed bound on the store connection handshake — raise if real
// devices routinely need longer than this to connect.
const STORE_CONNECTION_TIMEOUT_MS = 8000;
// Catalog keys, not copy: the screen translates them, and the Kilo Pass copy is
// identical, so reusing its keys keeps `check:i18n` free of a duplicate string.
const APP_STORE_CONNECTION_TIMEOUT_KEY = 'kiloPass.couldNotConnectToAppStore';
const PLAY_CONNECTION_TIMEOUT_KEY = 'kiloPass.couldNotConnectToPlay';

const isIapPlatform = Platform.OS === 'ios' || Platform.OS === 'android';
const storefront = Platform.OS === 'ios' ? 'app_store' : 'play';
const storeConnectionTimeoutKey =
  Platform.OS === 'ios' ? APP_STORE_CONNECTION_TIMEOUT_KEY : PLAY_CONNECTION_TIMEOUT_KEY;

export type StoreCreditProductsOptions = {
  /** Whether the store connection (from the IAP owner) is established. */
  connected: boolean;
  /** Fetches store SKUs. Injected by the IAP owner so this module never imports `expo-iap`. */
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreCreditProductListing[]>;
};

export function useStoreCreditProducts(options: StoreCreditProductsOptions) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { userId } = useCurrentUserId();
  const [storeErrorMessage, setStoreErrorMessage] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  // Bounded wait for the store connection — without this, a stuck
  // connection leaves the screen showing loading skeletons forever.
  useEffect(() => {
    if (!isIapPlatform || options.connected) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setStoreErrorMessage(current => current ?? storeConnectionTimeoutKey);
    }, STORE_CONNECTION_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [options.connected, connectionAttempt]);

  const productsQuery = useQuery({
    queryKey: ['credits', 'store-products', userId],
    queryFn: async () => {
      const loadedProducts = await loadStoreCreditProducts({
        fetchStoreProducts: options.fetchStoreProducts,
        loadBackendProducts: async () => {
          const backendResponse = await queryClient.fetchQuery(
            trpc.credits.getMobileStoreProducts.queryOptions()
          );
          return backendResponse;
        },
        storefront,
      });
      return loadedProducts;
    },
    enabled: isIapPlatform && options.connected && userId != null,
    staleTime: STORE_CREDIT_PRODUCTS_STALE_TIME_MS,
  });

  const { refetch: refetchProducts } = productsQuery;
  const refetch = useCallback(async () => {
    setStoreErrorMessage(null);
    setConnectionAttempt(attempt => attempt + 1);
    await refetchProducts();
  }, [refetchProducts]);

  const queryErrorMessage = getAuthoredProductsErrorMessageKey(productsQuery.error);

  useEffect(() => {
    if (productsQuery.isSuccess) {
      setStoreErrorMessage(null);
    }
  }, [productsQuery.isSuccess]);

  const productsState = getStoreCreditProductsState({
    data: productsQuery.data,
    isError: productsQuery.isError,
    storeErrorMessage,
    queryErrorMessage,
  });

  return {
    products: productsState.products,
    isLoading:
      storeErrorMessage === null &&
      (productsQuery.isLoading || (isIapPlatform && !options.connected)),
    isRefetching: productsQuery.isRefetching,
    isError: productsState.isError,
    errorMessageKey: productsState.errorMessageKey,
    storeUnavailable: productsState.storeUnavailable,
    refetch,
  };
}
