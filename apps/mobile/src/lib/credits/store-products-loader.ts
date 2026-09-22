import {
  type BackendStoreCreditProductsResponse,
  joinStoreCreditProducts,
  type StoreCreditProduct,
  type StoreCreditProductListing,
} from './store-products';

export const NO_MATCHING_CREDIT_PRODUCTS_KEY = 'credits.noMatchingProducts';
export const NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY = 'credits.noMatchingProductsPlay';

/**
 * Carries the catalog key of a message this app wrote. The store SDK throws its
 * own errors with internal wording ("Failed to query product"), which must never
 * reach the screen, so the screen only ever translates a key from this class.
 */
export class StoreCreditProductsError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(key);
    this.key = key;
  }
}

/**
 * Catalog key for the user, or null when the store SDK failed for its own
 * reasons. Null lets the screen render its own localized copy instead of SDK
 * wording.
 */
export function getAuthoredProductsErrorMessageKey(error: unknown): string | null {
  return error instanceof StoreCreditProductsError ? error.key : null;
}

function noMatchingProductsKey(storefront: 'app_store' | 'play'): string {
  return storefront === 'play'
    ? NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY
    : NO_MATCHING_CREDIT_PRODUCTS_KEY;
}

export async function loadStoreCreditProducts(params: {
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreCreditProductListing[]>;
  loadBackendProducts: () => Promise<BackendStoreCreditProductsResponse>;
  storefront: 'app_store' | 'play';
}): Promise<StoreCreditProduct[]> {
  const backendResponse = await params.loadBackendProducts();
  const backendProducts = backendResponse.products;
  const productSkus = backendProducts.map(product =>
    params.storefront === 'play' ? product.googleProductId : product.appleProductId
  );

  if (productSkus.length === 0) {
    return [];
  }

  let storeProducts: readonly StoreCreditProductListing[] = [];
  try {
    storeProducts = await params.fetchStoreProducts(productSkus);
  } catch {
    // The store SDK's wording is not for the screen: surface a catalog key.
    throw new StoreCreditProductsError(noMatchingProductsKey(params.storefront));
  }

  const products = joinStoreCreditProducts({
    appAccountToken: backendResponse.appAccountToken,
    backendProducts,
    storeProducts,
    storefront: params.storefront,
  });

  // A partial match is not an error: the unmatched packs still render. Only a
  // store answer that prices no pack at all is treated as unavailable.
  if (!products.some(product => product.storeProductId !== null)) {
    throw new StoreCreditProductsError(noMatchingProductsKey(params.storefront));
  }

  return products;
}
