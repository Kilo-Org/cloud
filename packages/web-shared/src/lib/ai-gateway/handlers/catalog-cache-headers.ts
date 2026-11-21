/**
 * Cache directives for the model catalog routes.
 *
 * Each catalog route answers two bodies: one derived for the calling user or
 * organization, and one that is the same for the callers it serves. Both stay
 * out of shared caches, and the per-caller body is not stored at all.
 *
 * Use the bucket that names every request dimension the body depends on. A
 * `shared` body is identical for the same request whatever its caller, account
 * or country. A body that is built from a request attribute uses that
 * attribute's bucket, which declares it in `Vary`, so a stored entry is reused
 * only for a request with the same value.
 */
export const CATALOG_CACHE_HEADERS = {
  /** A body derived for the calling user or organization. */
  perCaller: { 'Cache-Control': 'private, no-store' },
  /** A body that does not vary between callers, accounts or request countries. */
  shared: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
  /**
   * A body that is the same for every caller in one request country, and is
   * built from the request country before it is stored.
   */
  sharedByCountry: {
    'Cache-Control': 'private, max-age=0, must-revalidate',
    Vary: 'x-vercel-ip-country',
  },
} as const;
