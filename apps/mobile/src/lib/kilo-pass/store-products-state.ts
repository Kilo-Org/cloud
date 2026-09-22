import { type AppStoreKiloPassProduct } from './store-products';

export function getStoreKiloPassProductsState(params: {
  data: readonly AppStoreKiloPassProduct[] | undefined;
  isError: boolean;
  storeErrorMessage: string | null;
  queryErrorMessage: string | null;
}) {
  const isError = params.storeErrorMessage !== null || params.isError;

  return {
    products: isError ? [] : (params.data ?? []),
    isError,
    errorMessage: params.storeErrorMessage ?? params.queryErrorMessage,
  };
}

/**
 * True while the screen has nothing to paint and the store-product chain has
 * not settled. A cached product list paints immediately on a re-entry, so the
 * wait for the store connection only gates an empty surface — otherwise every
 * entry showed the tier skeletons again for products the app already had.
 * Without that wait a query still disabled for the missing connection would
 * read as "products unavailable" before the store answered.
 */
export function isStoreKiloPassProductsLoading(params: {
  data: readonly AppStoreKiloPassProduct[] | undefined;
  queryIsLoading: boolean;
  isIapPlatform: boolean;
  isStoreConnected: boolean;
  storeErrorMessage: string | null;
}): boolean {
  return (
    params.storeErrorMessage === null &&
    (params.queryIsLoading ||
      (params.isIapPlatform && !params.isStoreConnected && params.data === undefined))
  );
}
