import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTRPC } from '@/lib/trpc';
import { type StoreKiloPassProduct } from './store-products';
import {
  getStoreKiloPassProductsState,
  isStoreKiloPassProductsLoading,
} from './store-products-state';
import {
  getAuthoredProductsErrorMessage,
  loadAppStoreKiloPassProducts,
} from './store-products-loader';

const STORE_KILO_PASS_PRODUCTS_STALE_TIME_MS = 5 * 60 * 1000;
// Fixed bound on the store connection handshake — raise if real
// devices routinely need longer than this to connect.
const STORE_CONNECTION_TIMEOUT_MS = 8000;
const APP_STORE_CONNECTION_TIMEOUT_MESSAGE = 'kiloPass.couldNotConnectToAppStore';
const PLAY_CONNECTION_TIMEOUT_MESSAGE = 'kiloPass.couldNotConnectToPlay';

const isIapPlatform = Platform.OS === 'ios' || Platform.OS === 'android';
const storefront = Platform.OS === 'ios' ? 'app_store' : 'play';
const storeConnectionTimeoutMessage =
  Platform.OS === 'ios' ? APP_STORE_CONNECTION_TIMEOUT_MESSAGE : PLAY_CONNECTION_TIMEOUT_MESSAGE;

export type StoreKiloPassProductsOptions = {
  /** Whether the store connection (from the IAP owner) is established. */
  connected: boolean;
  /** Fetches store SKUs. Injected by the IAP owner so this module never imports `expo-iap`. */
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreKiloPassProduct[]>;
};

type KiloPassTrpc = ReturnType<typeof useTRPC>;

/**
 * Query options for the backend store-product catalog, carrying the same
 * lifetime as the joined entry this module keeps. Every reader (this hook's
 * `loadBackendProducts` and the IAP owner's server-backed fallback) shares one
 * cache entry, so leaving Kilo Pass and returning inside the window reads the
 * catalog instead of issuing `getMobileStoreProducts` again.
 */
export function backendStoreKiloPassProductsQueryOptions(trpc: KiloPassTrpc) {
  return {
    ...trpc.kiloPass.getMobileStoreProducts.queryOptions(),
    staleTime: STORE_KILO_PASS_PRODUCTS_STALE_TIME_MS,
  };
}

export function useStoreKiloPassProducts(options: StoreKiloPassProductsOptions) {
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
      setStoreErrorMessage(current => current ?? i18n.t(storeConnectionTimeoutMessage));
    }, STORE_CONNECTION_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [options.connected, connectionAttempt]);

  // The bound above is a fallback for a store that never answers. A store that
  // connects after it fired — a slow but successful re-entry — makes that
  // message stale: the cached tier tiles are already painted, and the product
  // query is already successful from cache, so nothing else clears it and the
  // false "Could not connect" retry card would stay over the tiles. Drop it as
  // soon as the store connection lands; a later product failure still surfaces
  // through the query's own error below.
  useEffect(() => {
    if (options.connected) {
      setStoreErrorMessage(null);
    }
  }, [options.connected]);

  const productsQuery = useQuery({
    queryKey: ['kilo-pass', 'app-store-products', userId],
    queryFn: async () => {
      const loadedProducts = await loadAppStoreKiloPassProducts({
        fetchStoreProducts: options.fetchStoreProducts,
        loadBackendProducts: async () => {
          const backendResponse = await queryClient.fetchQuery(
            backendStoreKiloPassProductsQueryOptions(trpc)
          );
          return backendResponse;
        },
        storefront,
      });
      return loadedProducts;
    },
    enabled: isIapPlatform && options.connected && userId != null,
    staleTime: STORE_KILO_PASS_PRODUCTS_STALE_TIME_MS,
  });

  const { refetch: refetchProducts } = productsQuery;
  const refetch = useCallback(async () => {
    setStoreErrorMessage(null);
    setConnectionAttempt(attempt => attempt + 1);
    await refetchProducts();
  }, [refetchProducts]);

  const queryErrorMessage = getAuthoredProductsErrorMessage(productsQuery.error);

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
    isLoading: isStoreKiloPassProductsLoading({
      data: productsQuery.data,
      queryIsLoading: productsQuery.isLoading,
      isIapPlatform,
      isStoreConnected: options.connected,
      storeErrorMessage,
    }),
    isRefetching: productsQuery.isRefetching,
    isError: productsState.isError,
    errorMessage: productsState.errorMessage,
    refetch,
  };
}
