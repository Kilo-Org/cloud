const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64-encode `bytes` for a consumer that takes the standard alphabet and
 * padding: the config archive the server decodes and the terminal module's
 * input. Neither `btoa` nor `Buffer` is guaranteed on every runtime the app
 * runs on, so the encoding lives here instead of at each call site.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const triple =
      (bytes[index] ?? 0) * 65536 + (bytes[index + 1] ?? 0) * 256 + (bytes[index + 2] ?? 0);
    output += ALPHABET.charAt(Math.floor(triple / 262144) % 64);
    output += ALPHABET.charAt(Math.floor(triple / 4096) % 64);
    output += index + 1 < bytes.length ? ALPHABET.charAt(Math.floor(triple / 64) % 64) : '=';
    output += index + 2 < bytes.length ? ALPHABET.charAt(triple % 64) : '=';
  }
  return output;
}
