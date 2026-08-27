import { i18n } from '@/i18n';

import {
  type AppStoreKiloPassProduct,
  type BackendStoreKiloPassProduct,
  joinAppStoreKiloPassProducts,
  type StoreKiloPassProduct,
} from './store-products';

export const NO_MATCHING_KILO_PASS_PRODUCTS_KEY = 'kiloPass.noMatchingProducts';
export const NO_MATCHING_KILO_PASS_PRODUCTS_PLAY_KEY = 'kiloPass.noMatchingProductsPlay';

export async function loadAppStoreKiloPassProducts(params: {
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreKiloPassProduct[]>;
  loadBackendProducts: () => Promise<{
    appAccountToken: string;
    products: readonly BackendStoreKiloPassProduct[];
  }>;
  storefront: 'app_store' | 'play';
}): Promise<AppStoreKiloPassProduct[]> {
  const backendResponse = await params.loadBackendProducts();
  const backendProducts = backendResponse.products;
  const productSkus = backendProducts.map(product =>
    params.storefront === 'play' ? product.googleProductId : product.appleProductId
  );

  if (productSkus.length === 0) {
    return [];
  }

  const storeProducts = await params.fetchStoreProducts(productSkus);
  const products = joinAppStoreKiloPassProducts({
    appAccountToken: backendResponse.appAccountToken,
    backendProducts,
    storeProducts,
    storefront: params.storefront,
  });

  if (products.length === 0) {
    throw new Error(
      i18n.t(
        params.storefront === 'play'
          ? NO_MATCHING_KILO_PASS_PRODUCTS_PLAY_KEY
          : NO_MATCHING_KILO_PASS_PRODUCTS_KEY
      )
    );
  }

  return products;
}
