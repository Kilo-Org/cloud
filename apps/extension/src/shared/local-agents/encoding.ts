/*
 * Base64url and HMAC-SHA256 helpers for the loopback pairing handshake.
 * SPEC "Loopback pairing / Encoding (fixed)" fixes the wire form: the key is 32
 * bytes, both nonces are 16 bytes, everything is base64url without padding, and
 * the MAC is HMAC-SHA256 over the UTF-8 bytes of `ext|<nonceH>|<nonceE>` or
 * `hub|<nonceE>|<nonceH>` using the base64url nonce strings verbatim.
 *
 * Web Crypto only: the extension builds for Chrome MV3 service workers and
 * Firefox MV3 background pages, where `crypto.subtle` is the one HMAC provider
 * both expose.
 */

export const PAIRING_KEY_BYTES = 32;
export const PAIRING_NONCE_BYTES = 16;

/** Web Crypto's `BufferSource` rejects the `SharedArrayBuffer`-backed variant. */
export type LocalAgentBytes = Uint8Array<ArrayBuffer>;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

export const base64UrlEncode = (bytes: LocalAgentBytes): string => {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

/** Strict decoder: rejects padding, foreign alphabets, and impossible lengths. */
export const base64UrlDecode = (value: string): LocalAgentBytes | null => {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return null;
  }

  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const withPadding = padded + '='.repeat((4 - (value.length % 4)) % 4);

  try {
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
  } catch {
    return null;
  }
};

export const decodePairingKey = (value: string): LocalAgentBytes | null => {
  const bytes = base64UrlDecode(value);

  return bytes?.length === PAIRING_KEY_BYTES ? bytes : null;
};

export const decodePairingNonce = (value: string): LocalAgentBytes | null => {
  const bytes = base64UrlDecode(value);

  return bytes?.length === PAIRING_NONCE_BYTES ? bytes : null;
};

export const createPairingNonce = (): string => {
  const bytes = new Uint8Array(PAIRING_NONCE_BYTES);
  crypto.getRandomValues(bytes);

  return base64UrlEncode(bytes);
};

/** Wire-visible MAC input; the CLI side must build the identical string. */
export const extensionMacMessage = (nonceH: string, nonceE: string): string =>
  `ext|${nonceH}|${nonceE}`;

/** Wire-visible MAC input for `auth_ok`; the CLI side must build the identical string. */
export const hubMacMessage = (nonceE: string, nonceH: string): string => `hub|${nonceE}|${nonceH}`;

const importHmacKey = (key: LocalAgentBytes): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', key, { hash: 'SHA-256', name: 'HMAC' }, false, ['sign', 'verify']);

const messageBytes = (message: string): LocalAgentBytes => new TextEncoder().encode(message);

const computeMac = async (key: LocalAgentBytes, message: string): Promise<string> => {
  const cryptoKey = await importHmacKey(key);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageBytes(message));

  return base64UrlEncode(new Uint8Array(signature));
};

export const computeExtensionMac = (
  key: LocalAgentBytes,
  nonceH: string,
  nonceE: string
): Promise<string> => computeMac(key, extensionMacMessage(nonceH, nonceE));

export const computeHubMac = (
  key: LocalAgentBytes,
  nonceE: string,
  nonceH: string
): Promise<string> => computeMac(key, hubMacMessage(nonceE, nonceH));

/** Constant-time verification: `crypto.subtle.verify` compares the MAC itself. */
export const verifyHubMac = async ({
  key,
  mac,
  nonceE,
  nonceH,
}: {
  key: LocalAgentBytes;
  mac: string;
  nonceE: string;
  nonceH: string;
}): Promise<boolean> => {
  const signature = base64UrlDecode(mac);

  if (signature === null) {
    return false;
  }

  const cryptoKey = await importHmacKey(key);

  return crypto.subtle.verify(
    'HMAC',
    cryptoKey,
    signature,
    messageBytes(hubMacMessage(nonceE, nonceH))
  );
};
