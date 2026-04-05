/**
 * Derive a deterministic sandbox ID from a user ID.
 *
 * Identical logic to kiloclaw/src/auth/sandbox-id.ts — base64url encoding
 * of the UTF-8 bytes of the userId. Used by the Next.js backend to
 * pre-generate sandbox_id when inserting the instance row into Postgres.
 *
 * Must stay in sync with the worker's sandboxIdFromUserId.
 */

const MAX_SANDBOX_ID_LENGTH = 63;

function bytesToBase64url(bytes: Uint8Array): string {
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

// ─── Instance-scoped identity ───────────────────────────────────────
// Canonical implementation lives in @kilocode/worker-utils/instance-id.
// Inlined here because Next.js moduleResolution can't resolve the
// worker-utils subpath export. Keep in sync with worker-utils/src/instance-id.ts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidInstanceId(id: string): boolean {
  return UUID_RE.test(id);
}

export function sandboxIdFromInstanceId(instanceId: string): string {
  if (!isValidInstanceId(instanceId)) {
    throw new Error('Invalid instanceId: must be a UUID');
  }
  const hex = instanceId.replace(/-/g, '');
  const prefixed = `ki_${hex}`;
  if (prefixed.length > MAX_SANDBOX_ID_LENGTH) {
    throw new Error(
      `instanceId too long: prefixed sandboxId would be ${prefixed.length} chars (max ${MAX_SANDBOX_ID_LENGTH})`
    );
  }
  return prefixed;
}
