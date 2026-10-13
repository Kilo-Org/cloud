import {
  decodeBase32Secret,
  generateTotpCode,
  normalizeTotpSecret,
} from '@/lib/user/deletion-queue/substack-totp';

// RFC 6238 Appendix B: secret is the ASCII string "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('normalizeTotpSecret', () => {
  it('uppercases and strips separators and padding', () => {
    expect(normalizeTotpSecret('gezd gnbv-gy3tqojq==')).toBe('GEZDGNBVGY3TQOJQ');
  });

  it('rejects non-base32 characters and impossible lengths', () => {
    expect(normalizeTotpSecret('0189')).toBeNull();
    expect(normalizeTotpSecret('A')).toBeNull();
    expect(normalizeTotpSecret('AAA')).toBeNull();
    expect(normalizeTotpSecret('AAAAAA')).toBeNull();
    expect(normalizeTotpSecret('')).toBeNull();
  });

  it('rejects non-zero unused trailing bits', () => {
    expect(normalizeTotpSecret('AA')).toBe('AA');
    expect(normalizeTotpSecret('AB')).toBeNull();
  });
});

describe('decodeBase32Secret', () => {
  it('decodes the RFC 6238 ASCII secret', () => {
    expect(Buffer.from(decodeBase32Secret(RFC_SECRET) ?? []).toString('ascii')).toBe(
      '12345678901234567890'
    );
  });

  it('rejects non-zero trailing bits', () => {
    expect(decodeBase32Secret('AA')).toEqual(Uint8Array.from([0]));
    expect(decodeBase32Secret('AB')).toBeNull();
  });
});

describe('generateTotpCode', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches RFC 6238 SHA-1 at %i seconds', (seconds, code) => {
    expect(generateTotpCode(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('uses a 64-bit counter beyond the 32-bit range', () => {
    expect(generateTotpCode(RFC_SECRET, 5_000_000_000 * 30 * 1000)).toMatch(/^\d{6}$/);
  });

  it('returns null for a malformed secret', () => {
    expect(generateTotpCode('not base32!', 59_000)).toBeNull();
  });
});
