import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/**
 * Timing-safe string comparison.
 *
 * Uses node:crypto's timingSafeEqual under the hood, which works in both
 * Node.js and Cloudflare Workers (with nodejs_compat).
 *
 * The length guard is required because node:crypto's timingSafeEqual throws
 * when buffers differ in length. A dummy comparison is performed so that
 * timing does not leak the length mismatch.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    nodeTimingSafeEqual(bufA, bufA);
    return false;
  }

  return nodeTimingSafeEqual(bufA, bufB);
}
