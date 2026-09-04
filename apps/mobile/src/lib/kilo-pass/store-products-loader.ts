import { i18n } from '@/i18n';

import {
  type AppStoreKiloPassProduct,
  type BackendStoreKiloPassProduct,
  joinAppStoreKiloPassProducts,
  type StoreKiloPassProduct,
} from './store-products';

export const NO_MATCHING_KILO_PASS_PRODUCTS_KEY = 'kiloPass.noMatchingProducts';
export const NO_MATCHING_KILO_PASS_PRODUCTS_PLAY_KEY = 'kiloPass.noMatchingProductsPlay';

/**
 * Carries a message this app wrote and translated. The store SDK throws its own
 * errors with internal wording ("Failed to query product"), which must never
 * reach the screen, so only this class's message is shown to the user.
 */
export class KiloPassProductsError extends Error {}

/**
 * Message for the user, or null when the store SDK failed for its own reasons.
 * Null lets the screen render its own localized copy instead of SDK wording.
 */
export function getAuthoredProductsErrorMessage(error: unknown): string | null {
  return error instanceof KiloPassProductsError ? error.message : null;
}

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
    throw new KiloPassProductsError(
      i18n.t(
        params.storefront === 'play'
          ? NO_MATCHING_KILO_PASS_PRODUCTS_PLAY_KEY
          : NO_MATCHING_KILO_PASS_PRODUCTS_KEY
      )
    );
  }

  return products;
}
