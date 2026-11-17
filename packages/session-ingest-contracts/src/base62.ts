// One random byte becomes one base62 character. Every identifier pattern in
// this package accepts exactly these 62 characters ([0-9A-Za-z]), and a random
// suffix carries no ordering, so both id families share one alphabet.
const BASE62_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function encodeBase62(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += BASE62_ALPHABET[byte % BASE62_ALPHABET.length];
  }
  return result;
}
