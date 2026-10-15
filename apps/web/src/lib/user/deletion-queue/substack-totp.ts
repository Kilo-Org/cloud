import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_MODULO = 10 ** TOTP_DIGITS;

export function normalizeTotpSecret(raw: string): string | null {
  const cleaned = raw.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  const remainder = cleaned.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) return null;
  if (!/^[A-Z2-7]+$/.test(cleaned)) return null;

  const unusedBits = (5 * remainder) % 8;
  const lastValue = BASE32_ALPHABET.indexOf(cleaned[cleaned.length - 1]);
  if ((lastValue & ((1 << unusedBits) - 1)) !== 0) return null;
  return cleaned;
}

export function decodeBase32Secret(secret: string): Uint8Array | null {
  const normalized = normalizeTotpSecret(secret);
  if (!normalized) return null;

  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const character of normalized) {
    bitBuffer = (bitBuffer << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bitBuffer >>> bitCount) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function generateTotpCode(secret: string, timestampMs = Date.now()): string | null {
  const key = decodeBase32Secret(secret);
  if (!key || key.length === 0) return null;

  const counter = BigInt(Math.floor(timestampMs / 1000 / TOTP_PERIOD_SECONDS));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const digest = createHmac('sha1', Buffer.from(key)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % TOTP_MODULO).padStart(TOTP_DIGITS, '0');
}
