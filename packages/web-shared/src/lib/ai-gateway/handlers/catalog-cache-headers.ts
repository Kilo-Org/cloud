/**
 * Cache directives for the model catalog routes.
 *
 * Each catalog route answers two bodies: one derived for the calling user or
 * organization, and one that does not vary between callers. Both stay out of
 * shared caches, and the per-caller body is not stored at all.
 */
export const CATALOG_CACHE_HEADERS = {
  /** A body derived for the calling user or organization. */
  perCaller: { 'Cache-Control': 'private, no-store' },
  /** A body that does not vary between callers. */
  shared: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
} as const;
