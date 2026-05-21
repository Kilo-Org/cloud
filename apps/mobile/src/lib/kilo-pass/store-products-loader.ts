import {
  type AppStoreKiloPassProduct,
  type BackendStoreKiloPassProduct,
  joinAppStoreKiloPassProducts,
  type StoreKiloPassProduct,
} from './store-products';

export const NO_MATCHING_KILO_PASS_PRODUCTS_MESSAGE =
  'No matching Kilo Pass products were returned by App Store.';

export async function loadAppStoreKiloPassProducts(params: {
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreKiloPassProduct[]>;
  loadBackendProducts: () => Promise<{
    appAccountToken: string;
    products: readonly BackendStoreKiloPassProduct[];
  }>;
}): Promise<AppStoreKiloPassProduct[]> {
  const backendResponse = await params.loadBackendProducts();
  const backendProducts = backendResponse.products;
  const productSkus = backendProducts.map(product => product.appleProductId);

  if (productSkus.length === 0) {
    return [];
  }

  const storeProducts = await params.fetchStoreProducts(productSkus);
  const products = joinAppStoreKiloPassProducts({
    appAccountToken: backendResponse.appAccountToken,
    backendProducts,
    storeProducts,
  });

  if (products.length === 0) {
    throw new Error(NO_MATCHING_KILO_PASS_PRODUCTS_MESSAGE);
  }

  return products;
}
