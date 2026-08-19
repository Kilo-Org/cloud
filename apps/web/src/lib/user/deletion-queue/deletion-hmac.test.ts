import {
  deletionAdvisoryLockKey,
  hmacDeletionEmail,
  parseDeletionHmacKey,
} from '@/lib/user/deletion-queue/deletion-hmac';

const key = Buffer.alloc(32, 7).toString('base64');

describe('deletion HMAC key', () => {
  it('parses a base64 key of at least 32 bytes', () => {
    expect(parseDeletionHmacKey(key)).toHaveLength(32);
  });

  it('computes a stable HMAC', () => {
    const hmac = hmacDeletionEmail('user@example.com', parseDeletionHmacKey(key));
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacDeletionEmail('user@example.com', parseDeletionHmacKey(key))).toBe(hmac);
    expect(hmacDeletionEmail('other@example.com', parseDeletionHmacKey(key))).not.toBe(hmac);
  });

  it('derives a signed int8 advisory lock from SHA-256', () => {
    const lock = deletionAdvisoryLockKey('user@example.com');
    expect(typeof lock).toBe('bigint');
    const maxInt8 = BigInt('9223372036854775807');
    const minInt8 = BigInt('-9223372036854775808');
    expect(lock <= maxInt8).toBe(true);
    expect(lock >= minInt8).toBe(true);
    expect(deletionAdvisoryLockKey('user@example.com') === lock).toBe(true);
    expect(deletionAdvisoryLockKey('other@example.com') === lock).toBe(false);
  });

  it('rejects a short key', () => {
    expect(() => parseDeletionHmacKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(
      /at least 32 bytes/
    );
  });
});
