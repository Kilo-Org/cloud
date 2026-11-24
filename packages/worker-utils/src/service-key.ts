/**
 * Label naming one same-service use of a deployable's secret, in the form
 * `<deployable>/<use>/v<version>`, for example `web/turnstile-cookie/v1`.
 * Each use must have its own fixed label; bump the version to retire every
 * token minted under the previous key.
 */
export type ServiceKeyPurpose = `${string}/${string}/v${number}`;

const SERVICE_KEY_PURPOSE_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/v[1-9]\d*$/;

const SERVICE_KEY_LENGTH_BYTES = 32;

/**
 * Derives a 32-byte subkey of a deployable's secret for one purpose with
 * HKDF-SHA256, so a token minted for one purpose never verifies as another.
 * The result can key HMAC-SHA256, JWT HS256 and A256GCM.
 */
export async function deriveServiceKey(
  secret: string,
  purpose: ServiceKeyPurpose
): Promise<Uint8Array<ArrayBuffer>> {
  if (secret.trim().length === 0) {
    throw new Error('Service key secret must be configured and non-empty');
  }
  if (!SERVICE_KEY_PURPOSE_PATTERN.test(purpose)) {
    throw new Error(`Invalid service key purpose: ${purpose}`);
  }

  const encoder = new TextEncoder();
  const inputKey = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode(purpose) },
    inputKey,
    SERVICE_KEY_LENGTH_BYTES * 8
  );
  return new Uint8Array(bits);
}
