const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, len: number): string {
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    str = CROCKFORD[mod] + str;
    now = (now - mod) / 32;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < len; i++) {
    str += CROCKFORD[bytes[i] % 32];
  }
  return str;
}

/**
 * Generate a ULID. Optionally accepts a timestamp (ms) for testing.
 * 10-char timestamp (48-bit) + 16-char random (80-bit) = 26 chars.
 */
export function ulid(now?: number): string {
  return encodeTime(now ?? Date.now(), 10) + encodeRandom(16);
}
