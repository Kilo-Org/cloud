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

/** The two catalog keys the store-unavailable card renders, per storefront. */
export type StoreUnavailableCopyKeys = {
  /** Card title: `<store> products unavailable`. */
  titleKey: string;
  /** Card body for a store the loader found no products for. */
  bodyKey: string;
};

/**
 * The per-store copy for the store-unavailable card, from one place.
 *
 * The card's title and its body must name the same store; deriving them from
 * two separate per-OS branches is what let an iOS build show a Google Play
 * body under an App Store title. Callers pass the storefront they buy from,
 * so the store name is chosen exactly once.
 */
export function getStoreUnavailableCopyKeys(
  storefront: 'app_store' | 'play'
): StoreUnavailableCopyKeys {
  return storefront === 'play'
    ? {
        titleKey: 'kiloPass.productsUnavailablePlay',
        bodyKey: NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY,
      }
    : {
        titleKey: 'kiloPass.productsUnavailable',
        bodyKey: NO_MATCHING_CREDIT_PRODUCTS_KEY,
      };
}

function noMatchingProductsKey(storefront: 'app_store' | 'play'): string {
  return getStoreUnavailableCopyKeys(storefront).bodyKey;
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
