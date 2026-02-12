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
