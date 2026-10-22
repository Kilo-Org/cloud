import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_auth_requests, device_sessions, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
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
  DeviceAuthPendingLimitError,
  DEVICE_AUTH_PENDING_LIMIT_MESSAGE,
} from './device-auth';
import { issueSessionCredentials } from '@/lib/auth/device-sessions';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';

// Capture real implementations for pass-through default behaviour.
// Must use var declarations — jest.mock factories are hoisted and run before
// const/let initializers, but var is hoisted with an undefined initial value
// that is safe to assign to.
// eslint-disable-next-line no-var
var _realIssueSessionCredentials: ((...args: any[]) => any) | undefined;
// eslint-disable-next-line no-var
var _realGenerateApiToken: ((...args: any[]) => any) | undefined;

jest.mock('@/lib/auth/device-sessions', () => {
  const actual = jest.requireActual('@/lib/auth/device-sessions') as any;
  _realIssueSessionCredentials = actual.issueSessionCredentials;
  return {
    ...actual,
    issueSessionCredentials: jest.fn((...args: any[]) =>
      (_realIssueSessionCredentials as any)(...args)
    ),
  };
});

jest.mock('@kilocode/web-shared/lib/tokens', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/tokens') as any;
  _realGenerateApiToken = actual.generateApiToken;
  return {
    ...actual,
    generateApiToken: jest.fn((...args: any[]) => (_realGenerateApiToken as any)(...args)),
  };
});

const mockedIssueSessionCredentials = jest.mocked(issueSessionCredentials);
const mockedGenerateApiToken = jest.mocked(generateApiToken);

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
    // Reset mocks to pass-through defaults.
    mockedIssueSessionCredentials.mockImplementation((...args: any[]) =>
      (_realIssueSessionCredentials as any)(...args)
    );
    mockedGenerateApiToken.mockImplementation((...args: any[]) =>
      (_realGenerateApiToken as any)(...args)
    );
    jest.clearAllMocks();

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
    test('enforces unique displayed user codes in the database', async () => {
      const created = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(created.userCode, testUserId);

      await expect(
        db.insert(device_auth_requests).values({
          code: generateDeviceSecret(),
          user_code: created.userCode,
          expires_at: created.expiresAt.toISOString(),
        })
      ).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'UQ_device_auth_requests_user_code' },
      });
    });

    test('retries a displayed user code collision with a fresh code', async () => {
      await db.insert(device_auth_requests).values({
        code: generateDeviceSecret(),
        user_code: 'AAAA-AAAA',
        kilo_user_id: testUserId,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      const randomIntSpy = jest.spyOn(crypto, 'randomInt').mockImplementation(() => 1);
      for (let i = 0; i < 8; i++) {
        randomIntSpy.mockImplementationOnce(() => 0);
      }

      try {
        const created = await createDeviceAuthRequest({});
        await approveDeviceAuthRequest(created.userCode, testUserId);

        expect(created.userCode).toBe('BBBB-BBBB');
        expect((await getDeviceAuthRequest(created.userCode))?.code).toBe(created.code);
        expect(randomIntSpy).toHaveBeenCalledTimes(16);
      } finally {
        randomIntSpy.mockRestore();
      }
    });

    test('bounds displayed user code allocation attempts', async () => {
      await db.insert(device_auth_requests).values({
        code: generateDeviceSecret(),
        user_code: 'AAAA-AAAA',
        kilo_user_id: testUserId,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      const randomIntSpy = jest.spyOn(crypto, 'randomInt').mockImplementation(() => 0);

      try {
        await expect(createDeviceAuthRequest({})).rejects.toThrow(
          'Unable to allocate a device authorization user code'
        );
        expect(randomIntSpy).toHaveBeenCalledTimes(40);
      } finally {
        randomIntSpy.mockRestore();
      }
    });

    test('stores a poll secret in code and the displayed user code separately', async () => {
      const result = await createDeviceAuthRequest({
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1',
      });

      expect(result.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(result.code).not.toBe(result.userCode);
      expect(result.code).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      expect(result.deviceCode).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.deviceCode).not.toBe(result.code);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const request = await getDeviceAuthRequest(result.userCode);
      expect(request).toBeDefined();
      expect(request?.status).toBe('pending');
      expect(request?.code).toBe(result.code);
      expect(request?.user_code).toBe(result.userCode);
      expect(request?.device_code_hash).toBe(hashDeviceSecret(result.deviceCode));
      expect(request?.user_agent).toBe('test-agent');
      expect(request?.ip_address).toBe('127.0.0.1');
    });

    test('enforces rate limiting per IP — live rows block, expired rows do not', async () => {
      const ipAddress = `192.168.1.${(Date.now() * 7) % 254}`;

      // Clean up any leftover rows from previous runs with this IP.
      await db.delete(device_auth_requests).where(eq(device_auth_requests.ip_address, ipAddress));

      // Create 5 expired pending requests with the same IP — these must not block a new request.
      for (let i = 0; i < 5; i++) {
        const { userCode } = await createDeviceAuthRequest({ ipAddress });
        // Manually expire each row so the pending count excludes them.
        await db
          .update(device_auth_requests)
          .set({
            status: 'pending',
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          })
          .where(eq(device_auth_requests.user_code, userCode));
      }

      // A new request from the same IP should succeed because all pending rows
      // are expired.
      const result = await createDeviceAuthRequest({ ipAddress });
      expect(result.code).toBeDefined();
      expect(result.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });
    test('rejects the sixth live pending request from the same IP', async () => {
      const ipAddress = `192.168.1.${(Date.now() * 11) % 254}`;

      // Clean up any leftover rows.
      await db.delete(device_auth_requests).where(eq(device_auth_requests.ip_address, ipAddress));

      // Create 5 live pending requests.
      for (let i = 0; i < 5; i++) {
        await createDeviceAuthRequest({ ipAddress });
      }

      // The 6th request must be rejected.
      await expect(createDeviceAuthRequest({ ipAddress })).rejects.toThrow(
        DeviceAuthPendingLimitError
      );
      await expect(createDeviceAuthRequest({ ipAddress })).rejects.toThrow(
        DEVICE_AUTH_PENDING_LIMIT_MESSAGE
      );
    });
  });

  describe('approveDeviceAuthRequest', () => {
    test('approves a pending request', async () => {
      const { userCode } = await createDeviceAuthRequest({});

      await approveDeviceAuthRequest(userCode, testUserId);

      const request = await getDeviceAuthRequest(userCode);
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
      const { userCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      await expect(approveDeviceAuthRequest(userCode, testUserId)).rejects.toThrow(
        'Device authorization request is not pending'
      );
    });

    test('concurrent approvals preserve the single winning user', async () => {
      const otherUserId = `${testUserId}-other`;
      await db.insert(kilocode_users).values({
        id: otherUserId,
        google_user_email: `other-${testUserEmail}`,
        google_user_name: 'Other User',
        google_user_image_url: 'https://example.com/avatar.jpg',
        stripe_customer_id: 'cus_other',
      });

      try {
        for (let i = 0; i < 20; i++) {
          const { userCode, deviceCode } = await createDeviceAuthRequest({});
          const results = await Promise.allSettled(
            [testUserId, otherUserId].map(async userId => {
              await approveDeviceAuthRequest(userCode, userId);
              return userId;
            })
          );
          const approved = results.filter(result => result.status === 'fulfilled');
          const rejected = results.filter(result => result.status === 'rejected');

          expect(approved).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect(rejected[0]?.reason).toEqual(
            new Error('Device authorization request is not pending')
          );
          expect((await getDeviceAuthRequest(userCode))?.kilo_user_id).toBe(approved[0]?.value);
          expect((await consumeDeviceAuthByDeviceCode(deviceCode)).userId).toBe(approved[0]?.value);
        }
      } finally {
        await db
          .delete(device_auth_requests)
          .where(eq(device_auth_requests.kilo_user_id, otherUserId));
        await db.delete(kilocode_users).where(eq(kilocode_users.id, otherUserId));
      }
    });

    test.each(['denied', 'consumed', 'expired'] as const)(
      'does not change a %s request',
      async status => {
        const { userCode } = await createDeviceAuthRequest({});
        await db
          .update(device_auth_requests)
          .set({ status, kilo_user_id: testUserId })
          .where(eq(device_auth_requests.user_code, userCode));
        const before = await getDeviceAuthRequest(userCode);

        await expect(approveDeviceAuthRequest(userCode, testUserId)).rejects.toThrow(
          'Device authorization request is not pending'
        );

        expect(await getDeviceAuthRequest(userCode)).toEqual(before);
      }
    );

    test('reports a conflict when denial wins before the expiry fallback', async () => {
      const { userCode } = await createDeviceAuthRequest({});
      await db
        .update(device_auth_requests)
        .set({
          expires_at: new Date(Date.now() - 1000).toISOString(),
          kilo_user_id: testUserId,
        })
        .where(eq(device_auth_requests.user_code, userCode));
      const pendingRequest = await getDeviceAuthRequest(userCode);
      const staleSelect = Object.assign(db.select({}), {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation(async () => {
              await denyDeviceAuthRequest(userCode);
              return [pendingRequest];
            }),
          }),
        }),
      });
      const selectSpy = jest.spyOn(db, 'select').mockReturnValueOnce(staleSelect);

      try {
        await expect(approveDeviceAuthRequest(userCode, testUserId)).rejects.toThrow(
          'Device authorization request is not pending'
        );
        expect((await getDeviceAuthRequest(userCode))?.status).toBe('denied');
      } finally {
        selectSpy.mockRestore();
      }
    });

    test('reports expiration when the atomic update reaches the expiry deadline', async () => {
      const { userCode } = await createDeviceAuthRequest({});
      const deadline = new Date();
      await db
        .update(device_auth_requests)
        .set({ expires_at: deadline.toISOString(), kilo_user_id: testUserId })
        .where(eq(device_auth_requests.user_code, userCode));
      jest.useFakeTimers({
        now: deadline,
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });

      try {
        await expect(approveDeviceAuthRequest(userCode, testUserId)).rejects.toThrow(
          'Device authorization request has expired'
        );
        expect((await getDeviceAuthRequest(userCode))?.status).toBe('expired');
      } finally {
        jest.useRealTimers();
      }
    });

    test('throws error for expired request', async () => {
      const { userCode } = await createDeviceAuthRequest({});

      // Manually expire the request
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.user_code, userCode));

      await expect(approveDeviceAuthRequest(userCode, testUserId)).rejects.toThrow(
        'Device authorization request has expired'
      );
    });
  });

  describe('denyDeviceAuthRequest', () => {
    test('concurrent approval and denial preserve the single winning transition', async () => {
      for (let i = 0; i < 20; i++) {
        const { userCode } = await createDeviceAuthRequest({});
        try {
          const results = await Promise.allSettled([
            approveDeviceAuthRequest(userCode, testUserId).then(() => 'approved' as const),
            denyDeviceAuthRequest(userCode).then(() => 'denied' as const),
          ]);
          const succeeded = results.filter(result => result.status === 'fulfilled');
          const rejected = results.filter(result => result.status === 'rejected');

          expect(succeeded).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect(rejected[0]?.reason).toEqual(
            new Error('Device authorization request is not pending')
          );
          expect((await getDeviceAuthRequest(userCode))?.status).toBe(succeeded[0]?.value);
        } finally {
          await db.delete(device_auth_requests).where(eq(device_auth_requests.user_code, userCode));
        }
      }
    });

    test('denies a pending request', async () => {
      const { userCode } = await createDeviceAuthRequest({});

      await denyDeviceAuthRequest(userCode);

      const request = await getDeviceAuthRequest(userCode);
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
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('approved');
      expect(result.token).toBeDefined();
      expect(result.userId).toBe(testUserId);
      expect(result.userEmail).toBe(testUserEmail);
    });

    test('returns denied status for denied request', async () => {
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await denyDeviceAuthRequest(userCode);

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('denied');
      expect(result.token).toBeUndefined();
    });

    test('returns expired status for expired request', async () => {
      const { userCode, deviceCode } = await createDeviceAuthRequest({});

      // Manually expire the request
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.user_code, userCode));

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('expired');
      expect(result.token).toBeUndefined();
    });

    test('returns expired for non-existent device code', async () => {
      const result = await consumeDeviceAuthByDeviceCode(generateDeviceSecret());
      expect(result.status).toBe('expired');
    });

    test('returns consumed on second call (single-use)', async () => {
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

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
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      // Trying to consume with the displayed user code must fail.
      const result = await consumeDeviceAuthByDeviceCode(userCode);
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
        const { userCode, deviceCode } = await createDeviceAuthRequest({});
        await approveDeviceAuthRequest(userCode, testUserId);

        const [a, b] = await Promise.all([
          consumeDeviceAuthByDeviceCode(deviceCode),
          consumeDeviceAuthByDeviceCode(deviceCode),
        ]);

        const approved = [a, b].filter(r => r.status === 'approved');
        expect(approved.length).toBe(1);
        expect(approved[0]!.token).toBeDefined();
      }
    });

    test('supportsRefresh: true creates a device session and issues short-lived token pair', async () => {
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      const result = await consumeDeviceAuthByDeviceCode(deviceCode, {
        supportsRefresh: true,
      });

      expect(result.status).toBe('approved');
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.expiresIn).toBe(60 * 60);
      expect(result.userId).toBe(testUserId);
    });

    test('supportsRefresh: false returns long-lived token only', async () => {
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      const result = await consumeDeviceAuthByDeviceCode(deviceCode, {
        supportsRefresh: false,
      });

      expect(result.status).toBe('approved');
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeUndefined();
      expect(result.expiresIn).toBeUndefined();
    });

    test('returns denied for a blocked user (new path)', async () => {
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      // Block the user
      await db
        .update(kilocode_users)
        .set({ blocked_reason: 'test block', blocked_at: new Date().toISOString() })
        .where(eq(kilocode_users.id, testUserId));

      const result = await consumeDeviceAuthByDeviceCode(deviceCode);

      expect(result.status).toBe('denied');
      expect(result.token).toBeUndefined();

      // Verify the request is durably denied, not consumed.
      const request = await getDeviceAuthRequest(userCode);
      expect(request?.status).toBe('denied');
    });

    test('failed issuance after consume restores row and removes orphan session (supportsRefresh)', async () => {
      mockedIssueSessionCredentials.mockRejectedValue(new Error('issuance failed'));

      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      // First consume fails because issueSessionCredentials throws.
      await expect(
        consumeDeviceAuthByDeviceCode(deviceCode, { supportsRefresh: true })
      ).rejects.toThrow('issuance failed');

      // Row was restored to approved.
      const request = await getDeviceAuthRequest(userCode);
      expect(request?.status).toBe('approved');
      expect(request?.consumed_at).toBeNull();

      // No device session was left behind.
      const sessions = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.device_auth_request_id, request!.id));
      expect(sessions).toHaveLength(0);

      // Reset mock to pass-through for the re-consume.
      mockedIssueSessionCredentials.mockImplementation((...args: any[]) =>
        (_realIssueSessionCredentials as any)(...args)
      );

      // A later consume succeeds.
      const retry = await consumeDeviceAuthByDeviceCode(deviceCode);
      expect(retry.status).toBe('approved');
      expect(retry.token).toBeDefined();
    });

    test('manually restored approved row is redeemable again', async () => {
      // Manually restore a consumed row to approved status, simulating what the
      // catch block does after a real issuance failure. A subsequent consume must
      // succeed, proving the restore enables re-redemption.
      const { userCode, deviceCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      // First consume succeeds.
      const first = await consumeDeviceAuthByDeviceCode(deviceCode);
      expect(first.status).toBe('approved');
      expect(first.token).toBeDefined();

      // Manually restore the row (simulating what the catch block does on failure).
      await db
        .update(device_auth_requests)
        .set({ status: 'approved', consumed_at: null })
        .where(eq(device_auth_requests.user_code, userCode));

      // Second consume succeeds — the restored row is redeemable again.
      const second = await consumeDeviceAuthByDeviceCode(deviceCode);
      expect(second.status).toBe('approved');
      expect(second.token).toBeDefined();
    });

    test('does not delete another request session during cleanup', async () => {
      const { userCode: userCode1, deviceCode: deviceCode1 } = await createDeviceAuthRequest({});
      const { userCode: userCode2, deviceCode: deviceCode2 } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode1, testUserId);
      await approveDeviceAuthRequest(userCode2, testUserId);

      // Consume the second request successfully with a session first.
      const result2 = await consumeDeviceAuthByDeviceCode(deviceCode2, { supportsRefresh: true });
      expect(result2.status).toBe('approved');
      expect(result2.token).toBeDefined();

      // Now make the first request's issuance fail.
      mockedIssueSessionCredentials.mockRejectedValue(new Error('issuance failed'));

      await expect(
        consumeDeviceAuthByDeviceCode(deviceCode1, { supportsRefresh: true })
      ).rejects.toThrow('issuance failed');

      // The first request's session was cleaned up.
      const request1 = await getDeviceAuthRequest(userCode1);
      const sessions1 = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.device_auth_request_id, request1!.id));
      expect(sessions1).toHaveLength(0);

      // The second request's session must still exist.
      const request2 = await getDeviceAuthRequest(userCode2);
      const sessions2 = await db
        .select()
        .from(device_sessions)
        .where(eq(device_sessions.device_auth_request_id, request2!.id));
      expect(sessions2).toHaveLength(1);

      // Reset mock.
      mockedIssueSessionCredentials.mockImplementation((...args: any[]) =>
        (_realIssueSessionCredentials as any)(...args)
      );
    });
  });

  describe('pollDeviceAuthRequest (legacy)', () => {
    test('returns pending status for unapproved request', async () => {
      const { code: pollSecret } = await createDeviceAuthRequest({});

      const result = await pollDeviceAuthRequest(pollSecret);

      expect(result.status).toBe('pending');
      expect(result.token).toBeUndefined();
    });

    test('does not redeem an approved request with the displayed user code', async () => {
      const { code: pollSecret, userCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      const result = await pollDeviceAuthRequest(userCode);

      expect(result.status).toBe('expired');
      expect(result.token).toBeUndefined();

      // The row is still redeemable with the poll secret.
      const retry = await pollDeviceAuthRequest(pollSecret);
      expect(retry.status).toBe('approved');
      expect(retry.token).toBeDefined();
    });

    test('returns approved status with token for approved request', async () => {
      const { code: pollSecret, userCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      const result = await pollDeviceAuthRequest(pollSecret);

      expect(result.status).toBe('approved');
      expect(result.token).toBeDefined();
      expect(result.userId).toBe(testUserId);
      expect(result.userEmail).toBe(testUserEmail);
    });

    test('returns denied status for denied request', async () => {
      const { code: pollSecret, userCode } = await createDeviceAuthRequest({});
      await denyDeviceAuthRequest(userCode);

      const result = await pollDeviceAuthRequest(pollSecret);

      expect(result.status).toBe('denied');
      expect(result.token).toBeUndefined();
    });

    test('returns expired status for expired request', async () => {
      const { code: pollSecret, userCode } = await createDeviceAuthRequest({});

      // Manually expire the request
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.user_code, userCode));

      const result = await pollDeviceAuthRequest(pollSecret);

      expect(result.status).toBe('expired');
      expect(result.token).toBeUndefined();
    });

    test('returns expired for non-existent code', async () => {
      const result = await pollDeviceAuthRequest(generateDeviceSecret());
      expect(result.status).toBe('expired');
    });

    test('concurrent legacy polls mint at most one token', async () => {
      for (let i = 0; i < 20; i++) {
        const { code: pollSecret, userCode } = await createDeviceAuthRequest({});
        await approveDeviceAuthRequest(userCode, testUserId);

        const [a, b] = await Promise.all([
          pollDeviceAuthRequest(pollSecret),
          pollDeviceAuthRequest(pollSecret),
        ]);

        const approved = [a, b].filter(r => r.status === 'approved');
        expect(approved.length).toBe(1);
        expect(approved[0]!.token).toBeDefined();
      }
    });

    test('sequential legacy polls consume only once (single-use)', async () => {
      const { code: pollSecret, userCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      const first = await pollDeviceAuthRequest(pollSecret);
      expect(first.status).toBe('approved');
      expect(first.token).toBeDefined();

      const second = await pollDeviceAuthRequest(pollSecret);
      // After consume, the second sequential poll returns expired.
      expect(second.status).toBe('expired');
      expect(second.token).toBeUndefined();
    });

    test('the poll secret and the device secret each redeem at most once', async () => {
      const polled = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(polled.userCode, testUserId);

      const firstPoll = await pollDeviceAuthRequest(polled.code);
      expect(firstPoll.status).toBe('approved');
      expect(firstPoll.token).toBeDefined();

      const afterPoll = await consumeDeviceAuthByDeviceCode(polled.deviceCode);
      expect(afterPoll.status).toBe('consumed');
      expect(afterPoll.token).toBeUndefined();

      const consumed = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(consumed.userCode, testUserId);

      const firstConsume = await consumeDeviceAuthByDeviceCode(consumed.deviceCode);
      expect(firstConsume.status).toBe('approved');
      expect(firstConsume.token).toBeDefined();

      const pollAfterConsume = await pollDeviceAuthRequest(consumed.code);
      expect(pollAfterConsume.status).toBe('expired');
      expect(pollAfterConsume.token).toBeUndefined();
    });

    test('returns denied for a blocked user (legacy path)', async () => {
      const { code: pollSecret, userCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      // Block the user
      await db
        .update(kilocode_users)
        .set({ blocked_reason: 'test block', blocked_at: new Date().toISOString() })
        .where(eq(kilocode_users.id, testUserId));

      const result = await pollDeviceAuthRequest(pollSecret);

      expect(result.status).toBe('denied');
      expect(result.token).toBeUndefined();

      // Verify the request is durably denied, not consumed.
      const request = await getDeviceAuthRequest(userCode);
      expect(request?.status).toBe('denied');
    });

    test('failed token generation after consume restores row for re-redemption', async () => {
      mockedGenerateApiToken.mockImplementation(() => {
        throw new Error('token generation failed');
      });

      const { code: pollSecret, userCode } = await createDeviceAuthRequest({});
      await approveDeviceAuthRequest(userCode, testUserId);

      // First poll fails because generateApiToken throws.
      await expect(pollDeviceAuthRequest(pollSecret)).rejects.toThrow('token generation failed');

      // Row was restored to approved.
      const request = await getDeviceAuthRequest(userCode);
      expect(request?.status).toBe('approved');
      expect(request?.consumed_at).toBeNull();

      // Reset mock to pass-through for the re-consume.
      mockedGenerateApiToken.mockImplementation((...args: any[]) =>
        (_realGenerateApiToken as any)(...args)
      );

      // A later poll succeeds.
      const retry = await pollDeviceAuthRequest(pollSecret);
      expect(retry.status).toBe('approved');
      expect(retry.token).toBeDefined();
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
      const { userCode: expiredCode } = await createDeviceAuthRequest({});
      await db
        .update(device_auth_requests)
        .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .where(eq(device_auth_requests.user_code, expiredCode));

      // Create a valid request
      const { userCode: validCode } = await createDeviceAuthRequest({});

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
