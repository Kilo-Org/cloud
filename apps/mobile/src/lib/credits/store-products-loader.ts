import { z } from 'zod';

import { isStoreDeadlineError, withStoreDeadline } from '@/lib/iap/store-call-deadline';
import { TELEMETRY_DESCRIPTION_KEY, type TelemetryDescription } from '@/lib/telemetry/error-sink';

import {
  type BackendStoreCreditProductsResponse,
  joinStoreCreditProducts,
  type StoreCreditProduct,
  type StoreCreditProductListing,
  type StoreProductFetchOptions,
} from './store-products';

export const NO_MATCHING_CREDIT_PRODUCTS_KEY = 'credits.noMatchingProducts';
export const NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY = 'credits.noMatchingProductsPlay';
/**
 * The card body for a store call that failed, per storefront.
 *
 * Catalog keys, not copy: the screen translates them, and the Kilo Pass copy is
 * identical, so reusing its keys keeps `check:i18n` free of a duplicate string.
 * The screen's own connection bound renders these too, so both paths say the
 * same thing: the store did not answer.
 */
export const STORE_FAILURE_KEY = 'kiloPass.couldNotConnectToAppStore';
export const STORE_FAILURE_PLAY_KEY = 'kiloPass.couldNotConnectToPlay';
/** The card body for a store call that missed the deadline, per storefront. */
export const STORE_TIMEOUT_KEY = 'credits.storeTimedOut';
export const STORE_TIMEOUT_PLAY_KEY = 'credits.storeTimedOutPlay';

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
 * The store SDK's own failure identity. The cause is whatever the SDK rejected
 * with, so only the two name-shaped fields are read: a store error message is
 * internal SDK wording that can embed an account or a product id, so it must
 * never reach a report or an issue title. Each field is validated on its own,
 * so an odd name cannot erase a code that is there.
 */
const StoreFailureFieldsSchema = z.object({
  name: z.unknown().optional(),
  code: z.unknown().optional(),
});

/** One SDK-provided field, bounded before it becomes a report token. */
const StoreFailureFieldSchema = z.string().max(120);

/** The longest identity token a report carries. */
const STORE_FAILURE_TOKEN_LIMIT = 48;
const STORE_FAILURE_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The bounded identity one store failure reports. */
type StoreFailureIdentity = { name: string; code: string };

/** One bounded lowercase token from an SDK-provided name or code, or undefined. */
function storeFailureToken(value: unknown): string | undefined {
  const parsed = StoreFailureFieldSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const slug = parsed.data
    .replaceAll(/\[[^\]]*\]/gu, ' ')
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, STORE_FAILURE_TOKEN_LIMIT)
    .replace(/-+$/u, '');
  return STORE_FAILURE_TOKEN_PATTERN.test(slug) ? slug : undefined;
}

/**
 * The store failure's name and code, or the placeholders that say the SDK gave
 * neither. Total: a non-object rejection, a cause shaped like nothing, or a
 * value that is not a bounded token keeps the report readable and its
 * cardinality bounded. The SDK's `[package]: PurchaseError` name slugs to
 * `purchase-error`.
 */
function storeFailureIdentity(cause: unknown): StoreFailureIdentity {
  const fields = StoreFailureFieldsSchema.safeParse(cause);
  const name = fields.success ? storeFailureToken(fields.data.name) : undefined;
  const code = fields.success ? storeFailureToken(fields.data.code) : undefined;
  return { name: name ?? 'unknown', code: code ?? 'uncoded' };
}

/** The length at which the report scrubber treats an unbroken run as a token. */
const STORE_FAILURE_REDACTION_LIMIT = 20;
/** A title chunk short enough that the scrubber keeps it. */
const STORE_FAILURE_TITLE_CHUNK = /[\s\S]{1,16}/gu;

/**
 * One identity token as the issue title reads it. The report scrubber blanks
 * any 20-character unbroken run in an exception message as a possible
 * credential (see `redactString` in the Sentry scrubber), so a token that long
 * is spelled in short words; the tags and the fingerprint keep the exact token.
 */
function storeFailureTitleText(token: string): string {
  if (token.length < STORE_FAILURE_REDACTION_LIMIT) {
    return token;
  }
  return token
    .split('-')
    .flatMap(part => part.match(STORE_FAILURE_TITLE_CHUNK) ?? [part])
    .join(' ');
}

type StoreProductsOutcome = 'store-unavailable' | 'store-timeout' | 'store-error';

/**
 * Three outcomes, told apart by what the store did. No cause: it answered and
 * priced nothing. A deadline: it never answered. Any other cause: it answered
 * with a failure. The message, the level and the fingerprint all read this, so
 * they cannot disagree.
 */
function storeProductsOutcome(cause: unknown): StoreProductsOutcome {
  if (cause === undefined) {
    return 'store-unavailable';
  }
  return isStoreDeadlineError(cause) ? 'store-timeout' : 'store-error';
}

/**
 * The report and issue title for one outcome. It names what the store did,
 * never the catalog key: the key is this app's copy handle, not a defect name.
 */
function storeProductsMessage(outcome: StoreProductsOutcome, cause: unknown): string {
  if (outcome === 'store-unavailable') {
    return 'Store answered with no matching credit pack';
  }
  if (outcome === 'store-timeout') {
    return 'Store did not answer the credit pack lookup in time';
  }
  const identity = storeFailureIdentity(cause);
  const name = storeFailureTitleText(identity.name);
  const code = storeFailureTitleText(identity.code);
  return `Store credit pack lookup failed: ${name} (${code})`;
}

/**
 * Carries the catalog key of the message the screen renders, and the catalog
 * shape behind the failure. The store SDK throws its own errors with internal
 * wording ("Failed to query product"), which must never reach the screen, so
 * the screen only ever translates a key from this class.
 *
 * The catalog key is `key`, not the message: the message is the report and
 * issue title, so it names what the store did.
 *
 * The error also declares its own telemetry: a store failure files under an
 * error-level fingerprint that carries the store SDK failure's own name and
 * code, so one storefront's distinct failures stay separate issues; the store
 * answering without pricing any pack, and a store that missed the call
 * deadline — both expected, handled outcomes the screen shows a card for —
 * file as warnings under their own outcome. Each carries
 * {@link StoreCreditProductsDiagnostics} so a report distinguishes a store-side
 * pricing gap from a catalog id mismatch, a store failure, or a hung SDK, and
 * the caught store error rides along as `cause`.
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
    const cause = options?.cause;
    const outcome = storeProductsOutcome(cause);
    super(storeProductsMessage(outcome, cause), options);
    this.name = 'StoreCreditProductsError';
    this.key = key;
    this.diagnostics = diagnostics;
    this[TELEMETRY_DESCRIPTION_KEY] = StoreCreditProductsError.telemetry(key, diagnostics, cause);
  }

  private static telemetry(
    key: string,
    diagnostics: StoreCreditProductsDiagnostics,
    cause: unknown
  ): TelemetryDescription {
    const outcome = storeProductsOutcome(cause);
    // A store that answered with a failure is the one real error here, and the
    // store SDK's own name and code are that defect's identity: without them
    // every failure of one storefront merged into one issue. The expected
    // answers keep their own outcome and level.
    const identity = outcome === 'store-error' ? storeFailureIdentity(cause) : undefined;
    return {
      level: outcome === 'store-error' ? 'error' : 'warning',
      fingerprint: [
        'credit-catalog-query',
        outcome,
        diagnostics.storefront,
        ...(identity === undefined ? [] : [identity.name, identity.code]),
      ],
      tags: {
        'error.subsystem': 'credits',
        'error.operation': 'load-store-products',
        'credits.storefront': diagnostics.storefront,
        'credits.outcome': outcome,
        ...(identity === undefined
          ? {}
          : {
              'credits.store-error-name': identity.name,
              'credits.store-error-code': identity.code,
            }),
      },
      contexts: {
        creditCatalogQuery: {
          catalogKey: key,
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

/** The catalog keys the store-unavailable card renders, per storefront. */
export type StoreUnavailableCopyKeys = {
  /** Card title: `<store> products unavailable`. */
  titleKey: string;
  /** Card body for a store the loader found no products for. */
  bodyKey: string;
  /** Card body for a store call that failed for the store's own reasons. */
  failureBodyKey: string;
  /** Card body for a store call that missed the deadline. */
  timeoutBodyKey: string;
};

/**
 * The per-store copy for the store-unavailable card, from one place.
 *
 * The card's title and its body must name the same store; deriving them from
 * two separate per-OS branches is what let an iOS build show a Google Play
 * body under an App Store title. Callers pass the storefront they buy from,
 * so the store name is chosen exactly once.
 *
 * The three bodies keep the three outcomes apart: a store that priced no pack
 * is a catalog answer, a store that failed to answer is a failure, and a store
 * that never answered inside the deadline is a timeout. A timeout must not
 * read as a catalog claim, and the failure copy is shared with the screen's
 * own connection bound, which means "the store did not answer" too.
 */
export function getStoreUnavailableCopyKeys(
  storefront: 'app_store' | 'play'
): StoreUnavailableCopyKeys {
  return storefront === 'play'
    ? {
        titleKey: 'kiloPass.productsUnavailablePlay',
        bodyKey: NO_MATCHING_CREDIT_PRODUCTS_PLAY_KEY,
        failureBodyKey: STORE_FAILURE_PLAY_KEY,
        timeoutBodyKey: STORE_TIMEOUT_PLAY_KEY,
      }
    : {
        titleKey: 'kiloPass.productsUnavailable',
        bodyKey: NO_MATCHING_CREDIT_PRODUCTS_KEY,
        failureBodyKey: STORE_FAILURE_KEY,
        timeoutBodyKey: STORE_TIMEOUT_KEY,
      };
}

/**
 * The authored body key for a store call that did not answer. A store that
 * missed the deadline gets the timeout copy and a store that answered with a
 * failure gets the failure copy; neither is a catalog claim — only an answer
 * that priced no pack is, and that path never reaches here.
 */
function storeCallFailureKey(storefront: Storefront, storeError: unknown): string {
  const copy = getStoreUnavailableCopyKeys(storefront);
  return isStoreDeadlineError(storeError) ? copy.timeoutBodyKey : copy.failureBodyKey;
}

export async function loadStoreCreditProducts(params: {
  fetchStoreProducts: (
    productSkus: string[],
    options?: StoreProductFetchOptions
  ) => Promise<readonly StoreCreditProductListing[]>;
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
  // Aborted as soon as this call settles without an answer, so a store that
  // already missed the deadline is not asked again by whatever retries inside
  // `fetchStoreProducts`: the SDK has no cancellation, and a hung store stays
  // hung for every further call.
  const storeCall = new AbortController();
  try {
    // A store that never answers is worse than one that fails: the screen would
    // stay on its placeholders and offer no retry. The same deadline the rest of
    // the flow uses bounds this call, so a hung SDK reads as unavailable.
    storeProducts = await withStoreDeadline(
      params.fetchStoreProducts(productSkus, { signal: storeCall.signal }),
      'the credit pack price lookup'
    );
  } catch (storeError) {
    storeCall.abort();
    // The store SDK's wording is not for the screen: surface a catalog key and
    // keep the store failure as the cause so reporting can tell a store-side
    // outage from a catalog mismatch. A deadline keeps its own copy and its own
    // report outcome instead of reading as a catalog that priced nothing.
    throw new StoreCreditProductsError(
      storeCallFailureKey(params.storefront, storeError),
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
