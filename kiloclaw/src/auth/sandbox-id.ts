/**
 * Reversible base64url encoding of userId into sandboxId.
 *
 * NOT the cloud-agent-next SHA-256 pattern -- we need to recover userId
 * from sandboxId in lifecycle hooks without a DB lookup.
 *
 * No prefix -- the full 63-char sandboxId limit is available.
 */

const MAX_SANDBOX_ID_LENGTH = 63;

export function sandboxIdFromUserId(userId: string): string {
  const encoded = btoa(userId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (encoded.length > MAX_SANDBOX_ID_LENGTH) {
    throw new Error(
      `userId too long: encoded sandboxId would be ${encoded.length} chars (max ${MAX_SANDBOX_ID_LENGTH})`
    );
  }
  return encoded;
}

export function userIdFromSandboxId(sandboxId: string): string {
  let encoded = sandboxId.replace(/-/g, '+').replace(/_/g, '/');
  while (encoded.length % 4 !== 0) {
    encoded += '=';
  }
  return atob(encoded);
}
