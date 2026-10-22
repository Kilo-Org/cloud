import { withStoreDeadline } from '@/lib/iap/store-call-deadline';
import { TELEMETRY_DESCRIPTION_KEY, type TelemetryDescription } from '@/lib/telemetry/error-sink';

import {
  type BackendStoreCreditProductsResponse,
  joinStoreCreditProducts,
  type StoreCreditProduct,
  type StoreCreditProductListing,
} from './store-products';

export const NO_MATCHING_CREDIT_PRODUCTS_KEY = 'credits.noMatchingProducts';
export const NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY = 'credits.noMatchingProductsPlay';

/** The storefront the loader asked, echoed in diagnostics and reports. */
type Storefront = 'app_store' | 'play';

/**
 * The catalog shape behind one failure: how many packs the backend offered,
 * how many listings the store answered with, and both sides' product ids. The
 * join key differs per storefront, so the requested ids are the ones this
 * loader actually asked the store for.
 */
export type StoreCreditProductsDiagnostics = {
  storefront: Storefront;
  backendPackCount: number;
  storeListingCount: number;
  matchedCount: number;
  requestedProductIds: readonly string[];
  returnedProductIds: readonly string[];
};

/**
 * Carries the catalog key of a message this app wrote. The store SDK throws its
 * own errors with internal wording ("Failed to query product"), which must never
 * reach the screen, so the screen only ever translates a key from this class.
 *
 * The error also declares its own telemetry: a store failure files under an
 * error-level fingerprint, and the store answering without pricing any pack —
 * an expected, handled outcome the screen shows a card for — files as a warning.
 * Both carry {@link StoreCreditProductsDiagnostics} so a report distinguishes a
 * store-side pricing gap from a catalog id mismatch or a hung SDK, and the
 * caught store error rides along as `cause`.
 */
export class StoreCreditProductsError extends Error {
  readonly key: string;
  readonly diagnostics: StoreCreditProductsDiagnostics;
  [TELEMETRY_DESCRIPTION_KEY]: TelemetryDescription;

  constructor(
    key: string,
    diagnostics: StoreCreditProductsDiagnostics,
    options?: { cause?: unknown }
  ) {
    super(key, options);
    this.key = key;
    this.diagnostics = diagnostics;
    this[TELEMETRY_DESCRIPTION_KEY] = StoreCreditProductsError.telemetry(
      diagnostics,
      options?.cause
    );
  }

  private static telemetry(
    diagnostics: StoreCreditProductsDiagnostics,
    cause: unknown
  ): TelemetryDescription {
    const storeAnswered = cause === undefined;
    const fingerprint = storeAnswered ? 'store-unavailable' : 'store-error';
    return {
      level: storeAnswered ? 'warning' : 'error',
      fingerprint: ['credit-catalog-query', fingerprint, diagnostics.storefront],
      tags: {
        'error.subsystem': 'credits',
        'error.operation': 'load-store-products',
        'credits.storefront': diagnostics.storefront,
        'credits.outcome': fingerprint,
      },
      contexts: {
        creditCatalogQuery: {
          storefront: diagnostics.storefront,
          backendPackCount: diagnostics.backendPackCount,
          storeListingCount: diagnostics.storeListingCount,
          matchedCount: diagnostics.matchedCount,
          requestedProductIds: diagnostics.requestedProductIds,
          returnedProductIds: diagnostics.returnedProductIds,
        },
      },
    };
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

export async function loadStoreCreditProducts(params: {
  fetchStoreProducts: (productSkus: string[]) => Promise<readonly StoreCreditProductListing[]>;
  loadBackendProducts: () => Promise<BackendStoreCreditProductsResponse>;
  storefront: Storefront;
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
    // A store that never answers is worse than one that fails: the screen would
    // stay on its placeholders and offer no retry. The same deadline the rest of
    // the flow uses bounds this call, so a hung SDK reads as unavailable.
    storeProducts = await withStoreDeadline(
      params.fetchStoreProducts(productSkus),
      'the credit pack price lookup'
    );
  } catch (storeError) {
    // The store SDK's wording is not for the screen: surface a catalog key and
    // keep the store failure as the cause so reporting can tell a store-side
    // outage from a catalog mismatch.
    throw new StoreCreditProductsError(
      getStoreUnavailableCopyKeys(params.storefront).bodyKey,
      {
        storefront: params.storefront,
        backendPackCount: backendProducts.length,
        storeListingCount: 0,
        matchedCount: 0,
        requestedProductIds: productSkus,
        returnedProductIds: [],
      },
      { cause: storeError }
    );
  }

  const products = joinStoreCreditProducts({
    appAccountToken: backendResponse.appAccountToken,
    backendProducts,
    storeProducts,
    storefront: params.storefront,
  });

  // A partial match is not an error: the unmatched packs still render. Only a
  // store answer that prices no pack at all is treated as unavailable — an
  // expected outcome the screen handles, reported with both sides' ids so the
  // backend catalog and the store's answer can be compared after the fact.
  if (!products.some(product => product.storeProductId !== null)) {
    throw new StoreCreditProductsError(getStoreUnavailableCopyKeys(params.storefront).bodyKey, {
      storefront: params.storefront,
      backendPackCount: backendProducts.length,
      storeListingCount: storeProducts.length,
      matchedCount: 0,
      requestedProductIds: productSkus,
      returnedProductIds: storeProducts.map(product => product.id),
    });
  }

  return products;
}
