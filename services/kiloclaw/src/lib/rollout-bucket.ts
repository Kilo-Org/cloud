/**
 * Map an arbitrary string key to a deterministic bucket value in [0, 99].
 *
 * Used by both provider rollout (`providers/rollout.ts`) and image-version
 * rollout (`lib/version-rollout.ts`) to decide whether a given subject
 * (instance, user, org) falls inside a percentage cohort.
 *
 * SHA-256 → take the first 4 bytes as a uint32 → modulo 100. The output is
 * uniform across the input space, so for any percent threshold P, roughly P%
 * of distinct keys fall below P. The same key always maps to the same bucket.
 */
export async function rolloutBucket(key: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return new DataView(digest).getUint32(0) % 100;
}
