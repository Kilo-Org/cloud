/**
 * Reversible base64url encoding of userId into sandboxId.
 *
 * NOT the cloud-agent-next SHA-256 pattern -- we need to recover userId
 * from sandboxId in lifecycle hooks without a DB lookup.
 *
 * Uses TextEncoder/TextDecoder so non-Latin1 userIds (e.g. Unicode from
 * some IdPs) don't throw at runtime. ASCII userIds encode identically
 * to the old btoa() approach.
 *
 * No prefix -- the full 63-char sandboxId limit is available.
 */

import { bytesToBase64url, base64urlToBytes } from './base64url';

const MAX_SANDBOX_ID_LENGTH = 63;

export function sandboxIdFromUserId(userId: string): string {
  const bytes = new TextEncoder().encode(userId);
  const encoded = bytesToBase64url(bytes);
  if (encoded.length > MAX_SANDBOX_ID_LENGTH) {
    throw new Error(
      `userId too long: encoded sandboxId would be ${encoded.length} chars (max ${MAX_SANDBOX_ID_LENGTH})`
    );
  }
  return encoded;
}

export function userIdFromSandboxId(sandboxId: string): string {
  const bytes = base64urlToBytes(sandboxId);
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
}

// ─── Instance-scoped identity ───────────────────────────────────────
// Canonical implementation lives in ./instance-id; re-exported here for
// convenience so callers get both shapes from one module.

export { isValidInstanceId, sandboxIdFromInstanceId } from './instance-id';
