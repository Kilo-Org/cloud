import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** The backend response for one storefront's credit-pack catalog. */
export type BackendStoreCreditProductsResponse = RouterOutputs['credits']['getMobileStoreProducts'];

export type BackendStoreCreditProduct = BackendStoreCreditProductsResponse['products'][number];

/**
 * A store product as the native SDK returns it: the store's product id plus its
 * localized price. This app never reads the SDK's own title or description for
 * credits — the screen renders backend copy.
 */
export type StoreCreditProductListing = {
  id: string;
  displayPrice: string;
};

/**
 * Options for one store product fetch.
 *
 * `signal` aborts once the caller's bounded call has settled without an answer.
 * A store that already missed the deadline stays silent for every further call,
 * and the SDK has no cancellation, so whoever would retry has to check this
 * before asking again.
 */
export type StoreProductFetchOptions = { signal?: AbortSignal };

/**
 * One backend credit pack joined with the store product that sells it. The
 * store fields are `null` when the store does not sell that pack: unlike the
 * Kilo Pass join, every backend pack is kept so the four preset amounts always
 * render.
 */
export type StoreCreditProduct = {
  backend: BackendStoreCreditProduct;
  storeProductId: string | null;
  displayPrice: string | null;
};

export function getStoreCreditExpiryMessageKey(
  product: BackendStoreCreditProduct,
  storefront: 'app_store' | 'play'
) {
  if (storefront === 'app_store') {
    return 'credits.appStoreExpiry';
  }
  if (product.creditExpiryPolicy === 'one_year') {
    return 'credits.playOneYearExpiry';
  }
  if (product.creditExpiryPolicy === 'never') {
    return 'credits.playNonexpiring';
  }
  return undefined;
}

/**
 * The one credit-expiry policy the pack group states below its rows, or
 * `undefined` when the screen already says it once.
 *
 * A catalog response is uniform — every pack is `never` or every pack is
 * `one_year` — so deduping leaves at most one policy. The balance card above
 * the packs states non-expiry itself, so a non-expiring catalog adds no
 * caption and only an expiring policy is restated here. Each row's accessible
 * label still carries its own policy sentence.
 */
export function getStoreCreditGroupExpiryMessageKey(
  products: readonly BackendStoreCreditProduct[],
  storefront: 'app_store' | 'play'
): 'credits.playOneYearExpiry' | undefined {
  const stated = products.map(product => getStoreCreditExpiryMessageKey(product, storefront));
  // Only a policy the balance card cannot state earns a caption: the card says
  // the account's credits never expire, and the two non-expiring keys restate
  // that.
  return stated.includes('credits.playOneYearExpiry') ? 'credits.playOneYearExpiry' : undefined;
}

export function joinStoreCreditProducts(params: {
  /**
   * Part of the loader contract this mirrors from the Kilo Pass join. The
   * joined row intentionally omits it: the purchase flow reads the account
   * token from the backend query response, not from each pack.
   */
  appAccountToken: string;
  backendProducts: readonly BackendStoreCreditProduct[];
  storeProducts: readonly StoreCreditProductListing[];
  /** Which storefront the SKUs came from; the join key differs per store. */
  storefront: 'app_store' | 'play';
}): StoreCreditProduct[] {
  const storeById = new Map(params.storeProducts.map(product => [product.id, product]));
  const joinKey = params.storefront === 'play' ? 'googleProductId' : 'appleProductId';

  return params.backendProducts.map(backend => {
    const storeProduct = storeById.get(backend[joinKey]);

    return {
      backend,
      storeProductId: storeProduct?.id ?? null,
      displayPrice: storeProduct?.displayPrice ?? null,
    };
  });
}

/**
 * Both error inputs are catalog keys, never translated text: the screen
 * translates them. `storeErrorMessage` is the store-connection bound the hook
 * arms; `queryErrorMessage` is the loader's authored key.
 */
export function getStoreCreditProductsState(params: {
  data: readonly StoreCreditProduct[] | undefined;
  isError: boolean;
  storeErrorMessage: string | null;
  queryErrorMessage: string | null;
}) {
  const isError = params.storeErrorMessage !== null || params.isError;
  const hasStorePrices = (params.data ?? []).some(product => product.storeProductId !== null);

  return {
    products: isError ? [] : (params.data ?? []),
    isError,
    errorMessageKey: params.storeErrorMessage ?? params.queryErrorMessage,
    // True when the store failed to answer or priced no pack at all. A partial
    // answer leaves the packs renderable, so it is not unavailable.
    storeUnavailable:
      params.storeErrorMessage !== null ||
      params.queryErrorMessage !== null ||
      (params.data !== undefined && !hasStorePrices),
  };
}
