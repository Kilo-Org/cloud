/**
 * Derive a deterministic sandbox ID from a user ID and town name.
 *
 * Similar to kiloclaw/sandbox-id.ts but incorporates the town name
 * so each user can have multiple towns with unique sandbox IDs.
 */

const MAX_SANDBOX_ID_LENGTH = 63;

function bytesToBase64url(bytes: Uint8Array): string {
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function gastownSandboxId(userId: string, townName: string): string {
  const input = `gastown:${userId}:${townName}`;
  const bytes = new TextEncoder().encode(input);
  const encoded = bytesToBase64url(bytes);
  if (encoded.length > MAX_SANDBOX_ID_LENGTH) {
    throw new Error(
      `sandbox ID too long: encoded would be ${encoded.length} chars (max ${MAX_SANDBOX_ID_LENGTH})`
    );
  }
  return encoded;
}
