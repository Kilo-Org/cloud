import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTRPC } from '@/lib/trpc';
import {
  getStoreCreditProductsState,
  type StoreCreditProduct,
  type StoreCreditProductListing,
} from './store-products';
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

  // The backend catalog on its own, so a store that failed to answer still has
  // the pack amounts to render. The loader reads the same query through the
  // cache, so this is a subscription, not a second fetch.
  const backendProductsQuery = useQuery({
    ...trpc.credits.getMobileStoreProducts.queryOptions(),
    enabled: isIapPlatform && userId != null,
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

  // The backend catalog answered with nothing to sell. That is the empty
  // state, not a store failure: the store is never asked for a price when the
  // catalog is empty, so its absence of prices must not read as unavailable.
  const catalogEmpty =
    backendProductsQuery.isSuccess && backendProductsQuery.data.products.length === 0;
  // A failed backend catalog fetch surfaces the same retryable banner as a
  // failed store fetch, so a network failure never reads as "nothing for sale".
  const storeUnavailable =
    !catalogEmpty && (productsState.storeUnavailable || backendProductsQuery.isError);

  // A store failure must not blank the rows: keep the backend packs with no
  // store price, so the amounts stay on screen and each row shows the
  // price-unavailable note instead of disappearing.
  const unpricedBackendProducts = useMemo<StoreCreditProduct[]>(
    () =>
      (backendProductsQuery.data?.products ?? []).map(backend => ({
        backend,
        storeProductId: null,
        displayPrice: null,
      })),
    [backendProductsQuery.data]
  );
  let products = productsState.products;
  if (products.length === 0 && storeUnavailable) {
    products = unpricedBackendProducts;
  }

  return {
    products,
    isLoading:
      storeErrorMessage === null &&
      (productsQuery.isLoading || (isIapPlatform && !options.connected)),
    isRefetching: productsQuery.isRefetching,
    isError: productsState.isError,
    errorMessageKey:
      productsState.errorMessageKey ??
      // The loader authored no key because the failure was the backend catalog
      // itself, not the store; say so instead of blaming the store.
      (backendProductsQuery.isError ? 'common.somethingWentWrong' : null),
    storeUnavailable,
    refetch,
  };
}
