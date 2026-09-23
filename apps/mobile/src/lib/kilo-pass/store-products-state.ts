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
 * A cached empty catalog is an empty surface too: the loader returns `[]`
 * without querying the store when the backend SKU list is empty, and the entry
 * can still be refetched once the connection enables the query, so the store
 * answer can turn that empty catalog into products. Painting "products
 * unavailable" first would replace it with the tier tiles a moment later.
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
  const hasProductsToPaint = params.data !== undefined && params.data.length > 0;

  return (
    params.storeErrorMessage === null &&
    (params.queryIsLoading ||
      (params.isIapPlatform && !params.isStoreConnected && !hasProductsToPaint))
  );
}
