import { z } from 'zod';

import {
  captureTelemetry,
  TELEMETRY_DESCRIPTION_KEY,
  type TelemetryDescription,
} from '@/lib/telemetry/error-sink';

export type KiloPassStorefront = 'app_store' | 'play';

export type KiloPassProductQueryPlatform = 'ios' | 'android';

/**
 * Which side of the query broke. `store-unavailable` is the store rejecting the
 * whole request (connection, billing library, or an identifier that fails on
 * its own); `unresolved-identifiers` is the store answering for the other tiers
 * while specific identifiers stay unresolvable, which leaves the paywall usable.
 */
type KiloPassProductQueryFailureKind = 'store-unavailable' | 'unresolved-identifiers';

export type KiloPassProductQueryFailure = {
  cause: unknown;
  kind: KiloPassProductQueryFailureKind;
  productIds: readonly string[];
  storefront: KiloPassStorefront;
};

export type KiloPassProductQueryAudit = {
  code: string | null;
  kind: KiloPassProductQueryFailureKind;
  platform: KiloPassProductQueryPlatform;
  productIds: readonly string[];
  responseCode: number | null;
  storefront: KiloPassStorefront;
};

type StoreProductQueryCauseDetails = {
  code: string | null;
  responseCode: number | null;
};

type KiloPassProductQueryTags = {
  'error.operation': string;
  'error.subsystem': string;
  'kilo_pass.failure_kind': string;
  'kilo_pass.platform': string;
  'kilo_pass.store_code': string;
  'kilo_pass.storefront': string;
};

type KiloPassProductQueryContext = {
  code: string | null;
  kind: KiloPassProductQueryFailureKind;
  platform: KiloPassProductQueryPlatform;
  productIds: string[];
  responseCode: number | null;
  storefront: KiloPassStorefront;
};

// The store SDK rejects a query with its own error object (expo-iap's
// `PurchaseError`): a `code` such as `query-product` and, on Android, the Play
// `responseCode`. Only these two scalar fields are ever read — never the
// message, which can quote the store payload. The code is a string in the SDK;
// a raw bridge rejection can carry a number.
const storeProductQueryCauseSchema = z.looseObject({
  code: z.union([z.string(), z.number()]).optional(),
  responseCode: z.number().optional(),
});

function getKiloPassPlatform(storefront: KiloPassStorefront): KiloPassProductQueryPlatform {
  return storefront === 'play' ? 'android' : 'ios';
}

function readStoreProductQueryCause(cause: unknown): StoreProductQueryCauseDetails {
  const parsed = storeProductQueryCauseSchema.safeParse(cause);
  if (!parsed.success) {
    return { code: null, responseCode: null };
  }
  const code = parsed.data.code;
  return {
    code: code === undefined || code === '' ? null : String(code),
    responseCode: parsed.data.responseCode ?? null,
  };
}

export function auditKiloPassProductQueryFailure(
  failure: KiloPassProductQueryFailure
): KiloPassProductQueryAudit {
  const details = readStoreProductQueryCause(failure.cause);
  return {
    code: details.code,
    kind: failure.kind,
    platform: getKiloPassPlatform(failure.storefront),
    productIds: [...failure.productIds],
    responseCode: details.responseCode,
    storefront: failure.storefront,
  };
}

/**
 * The stable fingerprint one failed store product query files under. It never
 * carries an identifier, so the same platform and store answer group into one
 * issue no matter which tier failed.
 */
export function getKiloPassProductQueryFingerprint(audit: KiloPassProductQueryAudit): string[] {
  return [
    'kilo-pass-product-query',
    audit.kind,
    audit.platform,
    audit.storefront,
    audit.code ?? 'unknown',
  ];
}

function getKiloPassProductQueryTags(audit: KiloPassProductQueryAudit): KiloPassProductQueryTags {
  return {
    'error.subsystem': 'kilo-pass',
    'error.operation': 'store-product-query',
    'kilo_pass.platform': audit.platform,
    'kilo_pass.storefront': audit.storefront,
    'kilo_pass.failure_kind': audit.kind,
    'kilo_pass.store_code': audit.code ?? 'unknown',
  };
}

function getKiloPassProductQueryContext(
  audit: KiloPassProductQueryAudit
): KiloPassProductQueryContext {
  return {
    code: audit.code,
    kind: audit.kind,
    platform: audit.platform,
    // The identifiers are the point of the report: they establish which tier
    // failed to resolve. They are product ids, never a receipt or a token.
    productIds: [...audit.productIds],
    responseCode: audit.responseCode,
    storefront: audit.storefront,
  };
}

/** The one-line diagnostic the paywall scenario quotes: platform, code, ids. */
export function formatKiloPassProductQueryLogLine(failure: KiloPassProductQueryFailure): string {
  const audit = auditKiloPassProductQueryFailure(failure);
  return `[kilo-pass] store product query ${audit.kind} platform=${audit.platform} storefront=${audit.storefront} code=${audit.code ?? 'unknown'} productIds=[${audit.productIds.join(', ')}]`;
}

/**
 * Log the decisive line at the store boundary. It names the platform and the
 * identifiers that failed to resolve and carries no receipt, token, or
 * credential — see the paywall proof.
 */
export function logKiloPassProductQueryFailure(failure: KiloPassProductQueryFailure): void {
  // eslint-disable-next-line no-console -- the paywall proof quotes this line
  console.warn(formatKiloPassProductQueryLogLine(failure));
}

/**
 * A failed store product query as a typed, handled outcome. The products query
 * throws it instead of the store SDK's raw error, so the screen keeps its own
 * localized retry copy and the query cache files the failure under this
 * module's stable fingerprint rather than the generic `app-error` one.
 */
export class KiloPassProductQueryError extends Error {
  readonly platform: KiloPassProductQueryPlatform;
  readonly productIds: readonly string[];
  readonly responseCode: number | null;
  readonly storeCode: string | null;
  readonly storefront: KiloPassStorefront;
  readonly [TELEMETRY_DESCRIPTION_KEY]: TelemetryDescription;

  constructor(failure: KiloPassProductQueryFailure) {
    const audit = auditKiloPassProductQueryFailure(failure);
    super(`Kilo Pass product query failed on ${audit.platform} (${audit.code ?? 'unknown'})`);
    this.name = 'KiloPassProductQueryError';
    this.platform = audit.platform;
    this.productIds = audit.productIds;
    this.responseCode = audit.responseCode;
    this.storeCode = audit.code;
    this.storefront = audit.storefront;
    this.cause = failure.cause;
    this[TELEMETRY_DESCRIPTION_KEY] = {
      fingerprint: getKiloPassProductQueryFingerprint(audit),
      tags: getKiloPassProductQueryTags(audit),
      contexts: { kiloPassProductQuery: getKiloPassProductQueryContext(audit) },
    };
  }
}

/**
 * Report identifiers the store could not resolve on their own while the rest of
 * the paywall loaded. Warning level: the resolved tiers still sell, so this is
 * a degradation to investigate, not a broken purchase path.
 */
export function reportUnresolvedKiloPassProductIdentifiers(
  failure: KiloPassProductQueryFailure
): void {
  const audit = auditKiloPassProductQueryFailure(failure);
  captureTelemetry({
    level: 'warning',
    error: failure.cause,
    tags: getKiloPassProductQueryTags(audit),
    contexts: { kiloPassProductQuery: getKiloPassProductQueryContext(audit) },
    fingerprint: getKiloPassProductQueryFingerprint(audit),
  });
}
