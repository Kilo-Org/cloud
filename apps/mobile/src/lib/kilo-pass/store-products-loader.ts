import { i18n } from '@/i18n';

import {
  KiloPassProductQueryError,
  type KiloPassProductQueryFailure,
  type KiloPassStorefront,
  logKiloPassProductQueryFailure,
  reportUnresolvedKiloPassProductIdentifiers,
} from './product-query-failure';
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
 * A `KiloPassProductQueryError` is the store's own failure and yields null.
 */
export function getAuthoredProductsErrorMessage(error: unknown): string | null {
  return error instanceof KiloPassProductsError ? error.message : null;
}

type StoreProductsFetch = (productSkus: string[]) => Promise<readonly StoreKiloPassProduct[]>;

type StoreProductProbe = {
  failure: unknown;
  productSku: string;
  products: readonly StoreKiloPassProduct[];
};

/**
 * Ask the store for one identifier alone: a combined answer cannot say which
 * identifier the store failed to resolve. An empty answer counts as
 * unresolvable, because iOS omits an unknown identifier instead of rejecting.
 */
async function probeStoreProductSku(
  fetchStoreProducts: StoreProductsFetch,
  productSku: string
): Promise<StoreProductProbe> {
  try {
    return { failure: null, productSku, products: await fetchStoreProducts([productSku]) };
  } catch (error) {
    return { failure: error, productSku, products: [] };
  }
}

function isUnresolvedProbe(probe: StoreProductProbe): boolean {
  return probe.failure !== null || probe.products.length === 0;
}

function throwStoreUnavailable(failure: KiloPassProductQueryFailure): never {
  logKiloPassProductQueryFailure(failure);
  throw new KiloPassProductQueryError(failure);
}

/**
 * Probe the identifiers the store did not answer for, one at a time. The tiers
 * that resolve are kept next to the ones already resolved; the identifiers that
 * still answer nothing are logged and reported as a typed failure. Only a store
 * that answers for none of them fails the whole query.
 */
async function resolveProbedStoreKiloPassProducts(params: {
  fetchStoreProducts: StoreProductsFetch;
  productSkus: readonly string[];
  resolvedProducts: readonly StoreKiloPassProduct[];
  storefront: KiloPassStorefront;
}): Promise<readonly StoreKiloPassProduct[]> {
  const probePromises: Promise<StoreProductProbe>[] = [];
  for (const productSku of params.productSkus) {
    probePromises.push(probeStoreProductSku(params.fetchStoreProducts, productSku));
  }
  const probes = await Promise.all(probePromises);
  const resolvedProducts = [
    ...params.resolvedProducts,
    ...probes.flatMap(probe => [...probe.products]),
  ];
  const unresolvedProductIds = probes
    .filter(probe => isUnresolvedProbe(probe))
    .map(probe => probe.productSku);

  if (unresolvedProductIds.length === 0) {
    // Every identifier answers on its own, so the combined request hit a
    // transient store fault. The probes are the answer, not a failure.
    return resolvedProducts;
  }

  const firstFailure = probes.find(probe => probe.failure !== null)?.failure;
  const failure: KiloPassProductQueryFailure = {
    cause:
      firstFailure ??
      new Error(`store returned no product for identifiers: ${unresolvedProductIds.join(', ')}`),
    kind: resolvedProducts.length === 0 ? 'store-unavailable' : 'unresolved-identifiers',
    productIds: unresolvedProductIds,
    storefront: params.storefront,
  };
  if (failure.kind === 'store-unavailable') {
    throwStoreUnavailable(failure);
  }

  logKiloPassProductQueryFailure(failure);
  reportUnresolvedKiloPassProductIdentifiers(failure);
  return resolvedProducts;
}

/**
 * Fetch the store's products for the identifiers the backend advertises.
 *
 * A store that cannot resolve one identifier either rejects the whole request
 * or answers for the rest and omits it. Either way a single stale tier must not
 * take the paywall down: the identifiers the store did not answer for are
 * probed on their own, the tiers that do resolve are kept, and the
 * unresolvable ones are reported as a typed, handled failure. Only a store that
 * answers for none of them fails the query.
 */
async function fetchStoreKiloPassProducts(params: {
  fetchStoreProducts: StoreProductsFetch;
  productSkus: readonly string[];
  storefront: KiloPassStorefront;
}): Promise<readonly StoreKiloPassProduct[]> {
  let combinedProducts: readonly StoreKiloPassProduct[] = [];
  try {
    combinedProducts = await params.fetchStoreProducts([...params.productSkus]);
  } catch (error) {
    if (params.productSkus.length < 2) {
      throwStoreUnavailable({
        cause: error,
        kind: 'store-unavailable',
        productIds: params.productSkus,
        storefront: params.storefront,
      });
    }

    return resolveProbedStoreKiloPassProducts({
      fetchStoreProducts: params.fetchStoreProducts,
      productSkus: params.productSkus,
      resolvedProducts: [],
      storefront: params.storefront,
    });
  }

  // A successful answer can still omit an identifier the store cannot resolve
  // (iOS drops an unknown product instead of rejecting), so the omission needs
  // the same probe and report as a rejection. An empty answer is different: the
  // store resolved nothing, which the caller reports as no matching products.
  const resolvedProductIds = new Set(combinedProducts.map(product => product.id));
  const omittedProductIds = params.productSkus.filter(sku => !resolvedProductIds.has(sku));
  if (omittedProductIds.length === 0 || combinedProducts.length === 0) {
    return combinedProducts;
  }

  return resolveProbedStoreKiloPassProducts({
    fetchStoreProducts: params.fetchStoreProducts,
    productSkus: omittedProductIds,
    resolvedProducts: combinedProducts,
    storefront: params.storefront,
  });
}

function getNoMatchingProductsKey(storefront: KiloPassStorefront): string {
  return storefront === 'play'
    ? NO_MATCHING_KILO_PASS_PRODUCTS_PLAY_KEY
    : NO_MATCHING_KILO_PASS_PRODUCTS_KEY;
}

export async function loadAppStoreKiloPassProducts(params: {
  fetchStoreProducts: StoreProductsFetch;
  loadBackendProducts: () => Promise<{
    appAccountToken: string;
    products: readonly BackendStoreKiloPassProduct[];
  }>;
  storefront: KiloPassStorefront;
}): Promise<AppStoreKiloPassProduct[]> {
  const backendResponse = await params.loadBackendProducts();
  const backendProducts = backendResponse.products;
  const productSkus = backendProducts.map(product =>
    params.storefront === 'play' ? product.googleProductId : product.appleProductId
  );

  if (productSkus.length === 0) {
    return [];
  }

  const storeProducts = await fetchStoreKiloPassProducts({
    fetchStoreProducts: params.fetchStoreProducts,
    productSkus,
    storefront: params.storefront,
  });
  const products = joinAppStoreKiloPassProducts({
    appAccountToken: backendResponse.appAccountToken,
    backendProducts,
    storeProducts,
    storefront: params.storefront,
  });

  if (products.length === 0) {
    throw new KiloPassProductsError(i18n.t(getNoMatchingProductsKey(params.storefront)));
  }

  return products;
}
