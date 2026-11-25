import { z } from 'zod';

export const STS_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export const StsEnvironmentSchema = z.enum(STS_ENVIRONMENTS);
export type StsEnvironment = z.infer<typeof StsEnvironmentSchema>;

/** A workload name equals the Worker name or the policy file name. */
export const WorkloadNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export type WorkloadName = z.infer<typeof WorkloadNameSchema>;

/** Canonical secret names: `<SERVICE>_<PURPOSE>`, no environment suffix. */
export const SecretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export type SecretName = z.infer<typeof SecretNameSchema>;

export const BundleEtagSchema = z.string().regex(/^"[A-Za-z0-9_-]{16,96}"$/);

/** The client serves a bundle from memory for this long before it must revalidate. */
export const BUNDLE_CACHE_SECONDS = 300;
/** The client revalidates in the background after 80 % of the cache lifetime. */
export const BUNDLE_REVALIDATE_AFTER_SECONDS = 240;
/** The client serves its last good bundle, marked stale, for at most this long while STS fails. */
export const BUNDLE_MAX_STALE_SECONDS = 24 * 60 * 60;

export const STS_BUNDLE_HTTP_PATH = '/v1/bundle';

export const BundleSecretSchema = z.strictObject({
  value: z.string(),
  version: z.number().int().nonnegative(),
});
export type BundleSecret = z.infer<typeof BundleSecretSchema>;

export const BundleRequestSchema = z.strictObject({
  ifNoneMatch: BundleEtagSchema.optional(),
});
export type BundleRequest = z.infer<typeof BundleRequestSchema>;

const OkBundleSchema = z.strictObject({
  status: z.literal('ok'),
  workload: WorkloadNameSchema,
  environment: StsEnvironmentSchema,
  etag: BundleEtagSchema,
  /** True when the manager was unreachable at the last refresh and STS serves its last-known copy. */
  stale: z.boolean(),
  fetchedAt: z.iso.datetime(),
  secrets: z.record(SecretNameSchema, BundleSecretSchema),
  /** Names the policy grants that the manager does not hold. */
  missing: z.array(SecretNameSchema),
});

const NotModifiedBundleSchema = z.strictObject({
  status: z.literal('not_modified'),
  etag: BundleEtagSchema,
  stale: z.boolean(),
  fetchedAt: z.iso.datetime(),
});

/** Non-retryable: the caller cannot get a bundle until its identity or policy changes. */
export const BUNDLE_DENIED_REASONS = [
  'identity_rejected',
  'unknown_workload',
  'environment_mismatch',
] as const;

/** Retryable: the caller should retry after `retryAfterSeconds` and keep serving its last good copy. */
export const BUNDLE_UNAVAILABLE_REASONS = [
  'manager_unreachable_no_copy',
  'audit_write_failed',
  'internal',
] as const;

const DeniedBundleSchema = z.strictObject({
  status: z.literal('denied'),
  reason: z.enum(BUNDLE_DENIED_REASONS),
});

const UnavailableBundleSchema = z.strictObject({
  status: z.literal('unavailable'),
  reason: z.enum(BUNDLE_UNAVAILABLE_REASONS),
  retryAfterSeconds: z.number().int().positive().max(3600),
});

export const BundleResultSchema = z.discriminatedUnion('status', [
  OkBundleSchema,
  NotModifiedBundleSchema,
  DeniedBundleSchema,
  UnavailableBundleSchema,
]);
export type BundleResult = z.infer<typeof BundleResultSchema>;
export type OkBundle = z.infer<typeof OkBundleSchema>;

/**
 * HTTP mapping for `POST /v1/bundle`, used by callers outside the Cloudflare account.
 * ok -> 200 with the JSON body, not_modified -> 304 with `ETag`, denied -> 401 (identity) or 403,
 * unavailable -> 503 with `Retry-After`. Every non-304 response carries a `BundleResult` JSON body.
 */
export function bundleResultHttpStatus(result: BundleResult): 200 | 304 | 401 | 403 | 503 {
  switch (result.status) {
    case 'ok':
      return 200;
    case 'not_modified':
      return 304;
    case 'denied':
      return result.reason === 'identity_rejected' ? 401 : 403;
    case 'unavailable':
      return 503;
  }
}
