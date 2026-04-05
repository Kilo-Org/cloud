import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { device_auth_requests, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  generateDeviceCode,
  createDeviceAuthRequest,
  getDeviceAuthRequest,
  approveDeviceAuthRequest,
  denyDeviceAuthRequest,
  pollDeviceAuthRequest,
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

  describe('generateDeviceCode', () => {
    test('generates a 9-character code with hyphen (XXXX-XXXX format)', () => {
      const code = generateDeviceCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    test('generates unique codes', () => {
      const codes = new Set();
      for (let i = 0; i < 100; i++) {
        codes.add(generateDeviceCode());
      }
      expect(codes.size).toBe(100);
    });
  });

  describe('createDeviceAuthRequest', () => {
    test('creates a new device auth request', async () => {
      const result = await createDeviceAuthRequest({
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1',
      });

      expect(result.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const request = await getDeviceAuthRequest(result.code);
      expect(request).toBeDefined();
      expect(request?.status).toBe('pending');
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

  describe('pollDeviceAuthRequest', () => {
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

    describe('Security Features', () => {
      test('enforces single-use token - second poll returns expired', async () => {
        const { code } = await createDeviceAuthRequest({});
        await approveDeviceAuthRequest(code, testUserId);

        // First poll should succeed
        const firstResult = await pollDeviceAuthRequest(code);
        expect(firstResult.status).toBe('approved');
        expect(firstResult.token).toBeDefined();

        // Second poll should return expired (consumed)
        const secondResult = await pollDeviceAuthRequest(code);
        expect(secondResult.status).toBe('expired');
        expect(secondResult.token).toBeUndefined();
      });

      test('normalizes responses - non-existent code returns expired', async () => {
        const result = await pollDeviceAuthRequest('FAKE-CODE');
        expect(result.status).toBe('expired');
      });

      test('normalizes responses - consumed code returns expired', async () => {
        const { code } = await createDeviceAuthRequest({});
        await approveDeviceAuthRequest(code, testUserId);

        // Consume the code
        await pollDeviceAuthRequest(code);

        // Polling again should return expired, not consumed
        const result = await pollDeviceAuthRequest(code);
        expect(result.status).toBe('expired');
      });

      test('code entropy increased - generates 8 character codes', () => {
        const code = generateDeviceCode();
        // Remove hyphen and check length
        const codeWithoutHyphen = code.replace('-', '');
        expect(codeWithoutHyphen.length).toBe(8);
      });
    });
  });
});
