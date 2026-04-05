import { signJwt, verifyJwt, validateAuthCookie, type JwtPayload } from './jwt';
import type { PasswordRecord } from './password';

describe('JWT signing and verification', () => {
  const testSecret = 'test-secret-key-for-jwt';
  const sessionDuration = 7 * 24 * 60 * 60; // 7 days in seconds
  const testPayload: JwtPayload = {
    worker: 'my-worker',
    passwordSetAt: Date.now(),
  };

  describe('signJwt', () => {
    it('includes correct worker and passwordSetAt in payload', () => {
      const token = signJwt(testPayload, testSecret, sessionDuration);
      const payload = verifyJwt(token, testSecret);

      expect(payload).not.toBeNull();
      expect(payload!.worker).toBe(testPayload.worker);
      expect(payload!.passwordSetAt).toBe(testPayload.passwordSetAt);
    });
  });

  describe('verifyJwt', () => {
    it('returns null for invalid signature (wrong secret)', () => {
      const token = signJwt(testPayload, testSecret, sessionDuration);
      const payload = verifyJwt(token, 'wrong-secret');

      expect(payload).toBeNull();
    });

    it('returns null for expired token', () => {
      // Create a token that expires immediately
      const token = signJwt(testPayload, testSecret, 0);

      const payload = verifyJwt(token, testSecret);

      expect(payload).toBeNull();
    });
  });
});

describe('validateAuthCookie', () => {
  const testSecret = 'test-secret-key-for-jwt';
  const sessionDuration = 7 * 24 * 60 * 60;
  const workerName = 'test-worker';
  const passwordCreatedAt = Date.now();

  const passwordRecord: PasswordRecord = {
    passwordHash: 'some-hash',
    salt: 'some-salt',
    createdAt: passwordCreatedAt,
  };

  function createValidToken(): string {
    return signJwt(
      { worker: workerName, passwordSetAt: passwordCreatedAt },
      testSecret,
      sessionDuration
    );
  }

  it('returns true for valid cookie matching password record', () => {
    const token = createValidToken();
    const result = validateAuthCookie(token, testSecret, workerName, passwordRecord);

    expect(result).toBe(true);
  });

  it('returns false when cookie is undefined', () => {
    const result = validateAuthCookie(undefined, testSecret, workerName, passwordRecord);

    expect(result).toBe(false);
  });

  it('returns false when cookie is empty string', () => {
    const result = validateAuthCookie('', testSecret, workerName, passwordRecord);

    expect(result).toBe(false);
  });

  it('returns false when JWT verification fails (wrong secret)', () => {
    const token = signJwt(
      { worker: workerName, passwordSetAt: passwordCreatedAt },
      'different-secret',
      sessionDuration
    );
    const result = validateAuthCookie(token, testSecret, workerName, passwordRecord);

    expect(result).toBe(false);
  });

  it('returns false when worker name does not match', () => {
    const token = signJwt(
      { worker: 'different-worker', passwordSetAt: passwordCreatedAt },
      testSecret,
      sessionDuration
    );
    const result = validateAuthCookie(token, testSecret, workerName, passwordRecord);

    expect(result).toBe(false);
  });

  it('returns false when password record is null', () => {
    const token = createValidToken();
    const result = validateAuthCookie(token, testSecret, workerName, null);

    expect(result).toBe(false);
  });

  it('returns false when passwordSetAt does not match record createdAt', () => {
    const token = signJwt(
      { worker: workerName, passwordSetAt: passwordCreatedAt - 1000 },
      testSecret,
      sessionDuration
    );
    const result = validateAuthCookie(token, testSecret, workerName, passwordRecord);

    expect(result).toBe(false);
  });

  it('returns false when token is expired', () => {
    const token = signJwt(
      { worker: workerName, passwordSetAt: passwordCreatedAt },
      testSecret,
      0 // expires immediately
    );
    const result = validateAuthCookie(token, testSecret, workerName, passwordRecord);

    expect(result).toBe(false);
  });
});
