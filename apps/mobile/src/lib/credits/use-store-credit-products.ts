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

export type StoreCreditProductsOptions = {
  /** Whether the store connection (from the IAP owner) is established. */
  connected: boolean;
  /** Fetches store SKUs. Injected by the IAP owner so this module never imports `expo-iap`. */
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreCreditProductListing[]>;
};

/**
 * What the screen has settled on: the packs it renders, whether the store is
 * unavailable, and the message key for it. Kept across a retry so the screen
 * keeps showing this view instead of blanking back to the loading placeholders.
 */
type SettledStoreCreditProductsView = {
  products: readonly StoreCreditProduct[];
  isError: boolean;
  storeUnavailable: boolean;
  errorMessageKey: string | null;
};

/** One shared empty catalog, so an empty settled view keeps a stable reference. */
const EMPTY_STORE_PRODUCTS: StoreCreditProduct[] = [];

function sameSettledView(
  left: SettledStoreCreditProductsView,
  right: SettledStoreCreditProductsView
): boolean {
  return (
    left.products === right.products &&
    left.isError === right.isError &&
    left.storeUnavailable === right.storeUnavailable &&
    left.errorMessageKey === right.errorMessageKey
  );
}

export function useStoreCreditProducts(options: StoreCreditProductsOptions) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { userId } = useCurrentUserId();
  const [storeErrorMessage, setStoreErrorMessage] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  // Derived per render, from the same `Platform.OS` the screen reads, so the
  // storefront the loader asks and the store name the banner shows can never
  // come from two different platform branches.
  const storefront = Platform.OS === 'ios' ? 'app_store' : 'play';
  const storeConnectionTimeoutKey =
    Platform.OS === 'ios' ? APP_STORE_CONNECTION_TIMEOUT_KEY : PLAY_CONNECTION_TIMEOUT_KEY;

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
  }, [options.connected, connectionAttempt, storeConnectionTimeoutKey]);

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
    // Keep `storeErrorMessage` until the retry answers: clearing it here drops
    // the banner while the store is still unreachable. The success effect below
    // clears it once the retry succeeds.
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
  if (products.length === 0) {
    // A store failure must not blank the rows: fall back to the backend packs
    // with no store price, so the amounts stay on screen and each row shows the
    // price-unavailable note. An empty result keeps one shared reference, so the
    // settled-view comparison below is not restarted on every render.
    products = storeUnavailable ? unpricedBackendProducts : EMPTY_STORE_PRODUCTS;
  }

  const liveView = useMemo<SettledStoreCreditProductsView>(
    () => ({
      products,
      isError: productsState.isError,
      storeUnavailable,
      errorMessageKey:
        productsState.errorMessageKey ??
        // The loader authored no key because the failure was the backend catalog
        // itself, not the store; say so instead of blaming the store.
        (backendProductsQuery.isError ? 'common.somethingWentWrong' : null),
    }),
    [
      products,
      productsState.isError,
      productsState.errorMessageKey,
      storeUnavailable,
      backendProductsQuery.isError,
    ]
  );

  // A retry returns the store query to `pending` and drops the error it held, so
  // the live view has no products and no store-unavailable flag while the retry
  // runs. Keep the last settled view and render it until the retry answers; a
  // first load has settled nothing yet, so it still renders the placeholders.
  const settled = productsQuery.isSuccess || productsQuery.isError || storeErrorMessage !== null;
  const [settledView, setSettledView] = useState<SettledStoreCreditProductsView | null>(null);
  useEffect(() => {
    if (!settled) {
      return;
    }
    setSettledView(previous =>
      previous !== null && sameSettledView(previous, liveView) ? previous : liveView
    );
  }, [settled, liveView]);

  const view = !settled && settledView !== null ? settledView : liveView;
  const isLoading =
    settledView === null &&
    storeErrorMessage === null &&
    (productsQuery.isLoading || (isIapPlatform && !options.connected));

  return {
    products: view.products,
    isLoading,
    // A retry reports busy even though React Query's own `isRefetching` is
    // false while the query is back to `pending` with no data. A first load is
    // still loading, so it is never a refetch.
    isRefetching: productsQuery.isFetching && !isLoading,
    isError: view.isError,
    errorMessageKey: view.errorMessageKey,
    storeUnavailable: view.storeUnavailable,
    refetch,
  };
}
