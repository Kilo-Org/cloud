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
