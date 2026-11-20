import 'server-only';
import { createHash } from 'node:crypto';

/**
 * SHA-256 of an already-high-entropy secret, as lowercase hex.
 *
 * Both the pending-link secret and the device-auth secret are 256-bit random
 * values, so a plain digest is enough. Keeping one definition means the two
 * stored-digest formats cannot drift apart.
 */
export function hashOpaqueSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
