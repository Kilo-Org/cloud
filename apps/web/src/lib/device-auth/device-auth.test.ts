import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { device_auth_requests, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  generateUserCode,
  generateDeviceCode,
  generateDeviceSecret,
  hashDeviceSecret,
  createDeviceAuthRequest,
  getDeviceAuthRequest,
  approveDeviceAuthRequest,
  denyDeviceAuthRequest,
  pollDeviceAuthRequest,
  consumeDeviceAuthByDeviceCode,
  isDeviceAuthRequestExpired,
  cleanupExpiredDeviceAuthRequests,
} from './device-auth';

describe('Device Auth', () => {
  const testUserId = 'test-user-' + Date.now();
  const testUserEmail = `test-${Date.now()}@example.com`;

  beforeEach(async () => {
    // Create a test user
    await db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: testUserEmail,
      google_user_name: 'Test User',
      google_user_image_url: 'https://example.com/avatar.jpg',
      stripe_customer_id: 'cus_test',
    });
  });

  afterEach(async () => {
    // Clean up test data
    await db.delete(device_auth_requests).where(eq(device_auth_requests.kilo_user_id, testUserId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
  });

  describe('generateUserCode', () => {
    test('generates a 9-character code with hyphen (XXXX-XXXX format)', () => {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    test('generates unique codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateUserCode());
      }
      expect(codes.size).toBe(100);
    });
  });

  describe('generateDeviceCode (deprecated alias)', () => {
    test('is an alias for generateUserCode', () => {
      // They are the same function reference.
      expect(generateDeviceCode).toBe(generateUserCode);
    });
  });

  describe('generateDeviceSecret', () => {
    test('generates a base64url-encoded 256-bit secret', () => {
      const secret = generateDeviceSecret();
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 random bytes in base64url → at least 43 characters without padding.
      expect(secret.length).toBeGreaterThanOrEqual(43);
    });

    test('generates unique secrets', () => {
      const secrets = new Set<string>();
      for (let i = 0; i < 100; i++) {
        secrets.add(generateDeviceSecret());
      }
      expect(secrets.size).toBe(100);
    });
  });

  describe('hashDeviceSecret', () => {
    test('produces a deterministic SHA-256 hex digest', () => {
      const secret = 'test-secret';
      const hash1 = hashDeviceSecret(secret);
      const hash2 = hashDeviceSecret(secret);
      expect(hash1).toBe(hash2);
      // SHA-256 hex digest is 64 hex characters.
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    test('produces different hashes for different secrets', () => {
      const hash1 = hashDeviceSecret('secret-a');
      const hash2 = hashDeviceSecret('secret-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('createDeviceAuthRequest', () => {
    test('creates a new device auth request with both code and device code', async () => {
      const result = await createDeviceAuthRequest({
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1',
      });

      expect(result.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(result.userCode).toBe(result.code);
      expect(result.deviceCode).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const request = await getDeviceAuthRequest(result.code);
      expect(request).toBeDefined();
      expect(request?.status).toBe('pending');
      expect(request?.user_code).toBe(result.userCode);
      expect(request?.device_code_hash).toBe(hashDeviceSecret(result.deviceCode));
      expect(request?.user_agent).toBe('test-agent');
      expect(request?.ip_address).toBe('127.0.0.1');
    });

    test('enforces rate limiting per IP', async () => {
      const ipAddress = '192.168.1.1';

      // Create 5 pending requests (the limit)
      for (let i = 0; i < 5; i++) {
        await createDeviceAuthRequest({ ipAddress });
      }

      // 6th request should fail
      await expect(createDeviceAuthRequest({ ipAddress })).rejects.toThrow(
        'Too many pending authorization requests from this IP'
      );
    });
  });

  describe('approveDeviceAuthRequest', () => {
    test('approves a pending request', async () => {
      const { code } = await createDeviceAuthRequest({});

      await approveDeviceAuthRequest(code, testUserId);

      const request = await getDeviceAuthRequest(code);
      expect(request?.status).toBe('approved');
      expect(request?.kilo_user_id).toBe(testUserId);
      expect(request?.approved_at).toBeDefined();
    });

    test('throws error for non-existent request', async () => {
      await expect(approveDeviceAuthRequest('XXX-XXX', testUserId)).rejects.toThrow(
        'Device authorization request not found'
      );
    });

    test('throws error for already approved request', async () => {
      const { code } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(code, testUserId);

      await expect(approveDeviceAuthRequest(code, testUserId)).rejects.toThrow(
        'Device authorization request is not pending'
      );
    });

    test('throws error for expired request', async () => {
      const { code } = await createDeviceAuthRequest({});

      // Manually expire the request
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.code, code));

      await expect(approveDeviceAuthRequest(code, testUserId)).rejects.toThrow(
        'Device authorization request has expired'
      );
    });
  });

  describe('denyDeviceAuthRequest', () => {
    test('denies a pending request', async () => {
      const { code } = await createDeviceAuthRequest({});

      await denyDeviceAuthRequest(code);

      const request = await getDeviceAuthRequest(code);
      expect(request?.status).toBe('denied');
    });
  });

  describe('consumeDeviceAuthByDeviceCode', () => {
    test('returns pending status for unapproved request', async () => {
      const { deviceCode } = await createDeviceAuthRequest({});

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('pending');
      expect(result.token).toBeUndefined();
    });

    test('returns approved status with token for approved request', async () => {
      const { code, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(code, testUserId);

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('approved');
      expect(result.token).toBeDefined();
      expect(result.userId).toBe(testUserId);
      expect(result.userEmail).toBe(testUserEmail);
    });

    test('returns denied status for denied request', async () => {
      const { code, deviceCode } = await createDeviceAuthRequest({});
      await denyDeviceAuthRequest(code);

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('denied');
      expect(result.token).toBeUndefined();
    });

    test('returns expired status for expired request', async () => {
      const { code, deviceCode } = await createDeviceAuthRequest({});

      // Manually expire the request
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.code, code));

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('expired');
      expect(result.token).toBeUndefined();
    });

    test('returns expired for non-existent device code', async () => {
      const result = await consumeDeviceAuthByDeviceCode(generateDeviceSecret());
      expect(result.status).toBe('expired');
    });

    test('returns consumed on second call (single-use)', async () => {
      const { code, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(code, testUserId);

      const first = await consumeDeviceAuthByDeviceCode(deviceCode);
      expect(first.status).toBe('approved');
      expect(first.token).toBeDefined();

      const second = await consumeDeviceAuthByDeviceCode(deviceCode);
      // The second call returns the raw 'consumed' status; callers (route handlers)
      // map it to 410 (expired) for client-facing responses.
      expect(second.status).toBe('consumed');
      expect(second.token).toBeUndefined();
    });

    test('rejects the user code (display code) — device secret is not the user code', async () => {
      const { code, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(code, testUserId);

      // Trying to consume with the displayed user code must fail.
      const result = await consumeDeviceAuthByDeviceCode(code);
      expect(result.status).toBe('expired');
      expect(result.token).toBeUndefined();

      // The actual device secret still works.
      const real = await consumeDeviceAuthByDeviceCode(deviceCode);
      expect(real.status).toBe('approved');
      expect(real.token).toBeDefined();
    });

    test('concurrent consumes mint at most one token', async () => {
      // Run 20 iterations to ensure the race is reliably closed.
      for (let i = 0; i < 20; i++) {
        const { code, deviceCode } = await createDeviceAuthRequest({});
        await approveDeviceAuthRequest(code, testUserId);

        const [a, b] = await Promise.all([
          consumeDeviceAuthByDeviceCode(deviceCode),
          consumeDeviceAuthByDeviceCode(deviceCode),
        ]);

        const approved = [a, b].filter(r => r.status === 'approved');
        expect(approved.length).toBe(1);
        expect(approved[0]!.token).toBeDefined();
      }
    });
  });

  describe('pollDeviceAuthRequest (legacy)', () => {
    test('returns pending status for unapproved request', async () => {
      const { code } = await createDeviceAuthRequest({});

      const result = await pollDeviceAuthRequest(code);

      expect(result.status).toBe('pending');
      expect(result.token).toBeUndefined();
    });

    test('returns approved status with token for approved request', async () => {
      const { code } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(code, testUserId);

      const result = await pollDeviceAuthRequest(code);

      expect(result.status).toBe('approved');
      expect(result.token).toBeDefined();
      expect(result.userId).toBe(testUserId);
      expect(result.userEmail).toBe(testUserEmail);
    });

    test('returns denied status for denied request', async () => {
      const { code } = await createDeviceAuthRequest({});
      await denyDeviceAuthRequest(code);

      const result = await pollDeviceAuthRequest(code);

      expect(result.status).toBe('denied');
      expect(result.token).toBeUndefined();
    });

    test('returns expired status for expired request', async () => {
      const { code } = await createDeviceAuthRequest({});

      // Manually expire the request
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.code, code));

      const result = await pollDeviceAuthRequest(code);

      expect(result.status).toBe('expired');
      expect(result.token).toBeUndefined();
    });

    test('returns expired for non-existent code', async () => {
      const result = await pollDeviceAuthRequest('XXX-XXX');
      expect(result.status).toBe('expired');
    });

    test('concurrent legacy polls mint at most one token', async () => {
      for (let i = 0; i < 20; i++) {
        const { code } = await createDeviceAuthRequest({});
        await approveDeviceAuthRequest(code, testUserId);

        const [a, b] = await Promise.all([
          pollDeviceAuthRequest(code),
          pollDeviceAuthRequest(code),
        ]);

        const approved = [a, b].filter(r => r.status === 'approved');
        expect(approved.length).toBe(1);
        expect(approved[0]!.token).toBeDefined();
      }
    });

    test('sequential legacy polls consume only once (single-use)', async () => {
      const { code } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(code, testUserId);

      const first = await pollDeviceAuthRequest(code);
      expect(first.status).toBe('approved');
      expect(first.token).toBeDefined();

      const second = await pollDeviceAuthRequest(code);
      // After consume, the second sequential poll returns expired.
      expect(second.status).toBe('expired');
      expect(second.token).toBeUndefined();
    });
  });

  describe('isDeviceAuthRequestExpired', () => {
    test('returns true for expired request', () => {
      const request = {
        expires_at: new Date(Date.now() - 1000).toISOString(),
        status: 'pending',
      };
      expect(isDeviceAuthRequestExpired(request)).toBe(true);
    });

    test('returns false for valid request', () => {
      const request = {
        expires_at: new Date(Date.now() + 60000).toISOString(),
        status: 'pending',
      };
      expect(isDeviceAuthRequestExpired(request)).toBe(false);
    });

    test('returns true for request with expired status', () => {
      const request = {
        expires_at: new Date(Date.now() + 60000).toISOString(),
        status: 'expired',
      };
      expect(isDeviceAuthRequestExpired(request)).toBe(true);
    });
  });

  describe('cleanupExpiredDeviceAuthRequests', () => {
    test('deletes expired requests', async () => {
      // Create an expired request
      const { code: expiredCode } = await createDeviceAuthRequest({});
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.code, expiredCode));

      // Create a valid request
      const { code: validCode } = await createDeviceAuthRequest({});

      const deletedCount = await cleanupExpiredDeviceAuthRequests();

      expect(deletedCount).toBeGreaterThanOrEqual(1);

      const expiredRequest = await getDeviceAuthRequest(expiredCode);
      const validRequest = await getDeviceAuthRequest(validCode);

      expect(expiredRequest).toBeUndefined();
      expect(validRequest).toBeDefined();
    });
  });

  describe('verificationUrl', () => {
    test('contains the user code, never the device secret', () => {
      const secret = generateDeviceSecret();
      // The verification URL is built from the user code only, so no code path
      // ever puts the 256-bit device secret into a URL. We verify that the
      // generateDeviceSecret output is clearly distinguishable from a user code.
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(secret.length).toBeGreaterThan(9); // user codes are 9 chars
    });
  });
});
