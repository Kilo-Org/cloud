import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTRPC } from '@/lib/trpc';
import { type StoreKiloPassProduct } from './store-products';
import { getStoreKiloPassProductsState } from './store-products-state';
import {
  getAuthoredProductsErrorMessage,
  loadAppStoreKiloPassProducts,
} from './store-products-loader';

const STORE_KILO_PASS_PRODUCTS_STALE_TIME_MS = 5 * 60 * 1000;
// Fixed bound on the store connection handshake — raise if real
// devices routinely need longer than this to connect.
const STORE_CONNECTION_TIMEOUT_MS = 8000;
// A retry the store refuses in a few milliseconds must still show that the tap
// registered. Without a floor the busy state lasts one frame: the button is
// back to "Try again" before the user (or a screenshot) can see it.
const MINIMUM_RETRY_BUSY_MS = 1000;
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

export function useStoreKiloPassProducts(options: StoreKiloPassProductsOptions) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { userId } = useCurrentUserId();
  const [storeErrorMessage, setStoreErrorMessage] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  // A manual retry keeps the button busy from the tap until the store answers
  // (the catalog fetch settles) or the bounded connection wait runs out. The
  // list itself stays on screen the whole time: clearing the store error at the
  // start of a retry unmounted the products-unavailable card and flashed the
  // loading skeletons plus a stale ownership error (UX-DEFECT, e7).
  const [retryInFlight, setRetryInFlight] = useState(false);
  const retryBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retrySettledRef = useRef(true);
  const retryFloorElapsedRef = useRef(true);
  // Read by the retry timers, which outlive the render that scheduled them.
  const connectedRef = useRef(options.connected);
  connectedRef.current = options.connected;

  const clearRetryBusyTimer = useCallback(() => {
    if (retryBusyTimerRef.current !== null) {
      clearTimeout(retryBusyTimerRef.current);
      retryBusyTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearRetryBusyTimer();
    },
    [clearRetryBusyTimer]
  );

  // Bounded wait for the store connection — without this, a stuck
  // connection leaves the screen showing loading skeletons forever.
  useEffect(() => {
    if (!isIapPlatform || options.connected) {
      return undefined;
    }
    const timer = setTimeout(() => {
      // The handshake this retry was waiting on is over, so its busy state is
      // too; the card below states the same failure.
      setRetryInFlight(false);
      setStoreErrorMessage(current => current ?? i18n.t(storeConnectionTimeoutMessage));
    }, STORE_CONNECTION_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [options.connected, connectionAttempt]);

  const productsQuery = useQuery({
    queryKey: ['kilo-pass', 'app-store-products', userId],
    queryFn: async () => {
      const loadedProducts = await loadAppStoreKiloPassProducts({
        fetchStoreProducts: options.fetchStoreProducts,
        loadBackendProducts: async () => {
          const backendResponse = await queryClient.fetchQuery(
            trpc.kiloPass.getMobileStoreProducts.queryOptions()
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

  // The retry ends when the catalog fetch settles AND the minimum busy time has
  // passed. While the store is not connected the bounded wait above owns the end
  // of the retry instead — the disabled query settles without fetching anything.
  const endRetryWhenSettled = useCallback(() => {
    if (connectedRef.current && retrySettledRef.current && retryFloorElapsedRef.current) {
      setRetryInFlight(false);
    }
  }, []);

  const refetch = useCallback(async () => {
    clearRetryBusyTimer();
    retrySettledRef.current = false;
    retryFloorElapsedRef.current = false;
    setRetryInFlight(true);
    setConnectionAttempt(attempt => attempt + 1);
    retryBusyTimerRef.current = setTimeout(() => {
      retryBusyTimerRef.current = null;
      retryFloorElapsedRef.current = true;
      endRetryWhenSettled();
    }, MINIMUM_RETRY_BUSY_MS);
    try {
      await refetchProducts();
    } finally {
      retrySettledRef.current = true;
      endRetryWhenSettled();
    }
  }, [clearRetryBusyTimer, endRetryWhenSettled, refetchProducts]);

  // The connection can land while a retry is still waiting on it (the bounded
  // wait above is cancelled then, and no fetch had started when the retry began).
  useEffect(() => {
    if (options.connected) {
      endRetryWhenSettled();
    }
  }, [endRetryWhenSettled, options.connected]);

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
    isLoading:
      storeErrorMessage === null &&
      !retryInFlight &&
      (productsQuery.isLoading || (isIapPlatform && !options.connected)),
    isRefetching: productsQuery.isRefetching || retryInFlight,
    isError: productsState.isError,
    errorMessage: productsState.errorMessage,
    refetch,
  };
}
