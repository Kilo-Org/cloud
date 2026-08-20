import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import {
  findUserByEmail,
  findUserByEmailCaseInsensitive,
  findUserByNormalizedEmail,
} from '@/lib/user';
import { getUserFromAuth } from '@/lib/user/server';
import { setAdminAccessSinkForTest, type AdminAccessEvent } from '@/lib/admin/admin-access-log';
import { defineTestUser } from '@/tests/helpers/user.helper';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';

const mockSecrets = {
  SUPPORT_API_SECRET: 'mock-support-api-secret',
};

jest.mock('@/lib/config.server', () => {
  const actual = jest.requireActual('@/lib/config.server') as Record<string, unknown>;
  return {
    ...actual,
    get SUPPORT_API_SECRET() {
      return mockSecrets.SUPPORT_API_SECRET;
    },
  };
});

jest.mock('@/lib/user', () => ({
  findUserByEmailCaseInsensitive: jest.fn(),
  findUserByEmail: jest.fn(),
  findUserByNormalizedEmail: jest.fn(),
}));

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

import { GET } from './route';

const mockedFindUserByEmailCaseInsensitive = jest.mocked(findUserByEmailCaseInsensitive);
const mockedFindUserByEmail = jest.mocked(findUserByEmail);
const mockedFindUserByNormalizedEmail = jest.mocked(findUserByNormalizedEmail);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const SUPPORT_SECRET = 'mock-support-api-secret';
const ACTOR_EMAIL = 'alice@kilocode.ai';
const REQUEST_ID = 'csa-req-lookup-1';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function expectedEmailHash(email: string): string {
  return createHmac('sha256', SUPPORT_SECRET).update(email).digest('hex');
}

function lookupRequest(email: string | null, headers: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/internal/support/users');
  if (email !== null) url.searchParams.set('email', email);
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SUPPORT_SECRET}`,
      'X-Actor-Email': ACTOR_EMAIL,
      'X-Request-Id': REQUEST_ID,
      'x-pathname': '/api/internal/support/users',
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
  });
}

describe('GET /api/internal/support/users', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecrets.SUPPORT_API_SECRET = SUPPORT_SECRET;
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
    mockedFindUserByEmailCaseInsensitive.mockResolvedValue([]);
  });

  afterEach(() => {
    setAdminAccessSinkForTest(null);
  });

  describe('auth', () => {
    test('returns 401 when Authorization is missing', async () => {
      const res = await GET(lookupRequest('customer@example.com', { Authorization: '' }));
      expect(res.status).toBe(401);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when the secret is wrong', async () => {
      const res = await GET(
        lookupRequest('customer@example.com', { Authorization: 'Bearer wrong' })
      );
      expect(res.status).toBe(401);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when SUPPORT_API_SECRET is empty', async () => {
      mockSecrets.SUPPORT_API_SECRET = '';
      const res = await GET(lookupRequest('customer@example.com'));
      expect(res.status).toBe(401);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when SUPPORT_API_SECRET is only whitespace', async () => {
      mockSecrets.SUPPORT_API_SECRET = '   \n';
      const res = await GET(lookupRequest('customer@example.com'));
      expect(res.status).toBe(401);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('accepts a secret with surrounding whitespace from env or bearer', async () => {
      mockSecrets.SUPPORT_API_SECRET = ` ${SUPPORT_SECRET}\n`;
      mockedFindUserByEmailCaseInsensitive.mockResolvedValue([
        defineTestUser({
          id: USER_ID,
          google_user_email: 'customer@example.com',
          created_at: '2026-04-29T01:16:12.945Z',
        }),
      ]);
      const res = await GET(
        lookupRequest('customer@example.com', { Authorization: `Bearer  ${SUPPORT_SECRET}  ` })
      );
      expect(res.status).toBe(200);
    });

    test('returns 401 when the bearer token is empty', async () => {
      const res = await GET(lookupRequest('customer@example.com', { Authorization: 'Bearer ' }));
      expect(res.status).toBe(401);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 for a JWT-shaped bearer and does not call getUserFromAuth', async () => {
      const res = await GET(
        lookupRequest('customer@example.com', {
          Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig',
        })
      );
      expect(res.status).toBe(401);
      expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when INTERNAL_API_SECRET is sent as the bearer', async () => {
      const res = await GET(
        lookupRequest('customer@example.com', {
          Authorization: 'Bearer mock-secret',
        })
      );
      expect(res.status).toBe(401);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
  });

  describe('validation', () => {
    test('returns 400 when email is missing', async () => {
      const res = await GET(lookupRequest(null));
      expect(res.status).toBe(400);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 400 when email is invalid', async () => {
      const res = await GET(lookupRequest('not-an-email'));
      expect(res.status).toBe(400);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 400 when actorEmail is missing', async () => {
      const res = await GET(lookupRequest('customer@example.com', { 'X-Actor-Email': '' }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid actorEmail' });
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 400 when actorEmail is not a kilo staff domain', async () => {
      const res = await GET(
        lookupRequest('customer@example.com', { 'X-Actor-Email': 'alice@gmail.com' })
      );
      expect(res.status).toBe(400);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 400 when requestId is missing', async () => {
      const res = await GET(lookupRequest('customer@example.com', { 'X-Request-Id': '' }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid requestId' });
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 400 when requestId is longer than 128 characters', async () => {
      const res = await GET(
        lookupRequest('customer@example.com', { 'X-Request-Id': 'r'.repeat(129) })
      );
      expect(res.status).toBe(400);
      expect(mockedFindUserByEmailCaseInsensitive).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test.each(['bob@kilo.ai', 'carol@corp.kilocode.ai', 'Dave@KiloCode.ai'])(
      'accepts staff actorEmail %s',
      async actorEmail => {
        mockedFindUserByEmailCaseInsensitive.mockResolvedValue([
          defineTestUser({
            id: USER_ID,
            google_user_email: 'customer@example.com',
            created_at: '2026-04-29T01:16:12.945Z',
          }),
        ]);
        const res = await GET(
          lookupRequest('customer@example.com', { 'X-Actor-Email': actorEmail })
        );
        expect(res.status).toBe(200);
        expect(events[0]?.claimedActorEmail).toBe(actorEmail.toLowerCase());
      }
    );
  });

  describe('lookup', () => {
    test('returns JSON 404 for an unknown email', async () => {
      const res = await GET(lookupRequest('missing@example.com'));
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      expect(events[0]).toMatchObject({ outcome: 'not_found', target: null });
    });

    test('returns JSON 404 for a soft-deleted user', async () => {
      mockedFindUserByEmailCaseInsensitive.mockResolvedValue([
        defineTestUser({
          id: USER_ID,
          google_user_email: `deleted+${USER_ID}@deleted.invalid`,
          blocked_reason: createSoftDeletedBlockedReason(),
        }),
      ]);

      const res = await GET(lookupRequest('customer@example.com'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
      expect(events[0]).toMatchObject({
        outcome: 'not_found',
        target: `user:${USER_ID}`,
      });
    });

    test('returns a slim DTO with no extra fields', async () => {
      mockedFindUserByEmailCaseInsensitive.mockResolvedValue([
        defineTestUser({
          id: USER_ID,
          google_user_email: 'customer@example.com',
          google_user_name: 'Ada',
          created_at: '2026-04-29 01:16:12.945+00',
          blocked_reason: null,
          stripe_customer_id: 'cus_secret',
        }),
      ]);

      const res = await GET(lookupRequest('customer@example.com'));
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toEqual({
        id: USER_ID,
        email: 'customer@example.com',
        name: 'Ada',
        createdAt: '2026-04-29T01:16:12.945Z',
        isBlocked: false,
      });
      expect(Object.keys(json).sort()).toEqual(['createdAt', 'email', 'id', 'isBlocked', 'name']);
      expect(json).not.toHaveProperty('stripe_customer_id');
    });

    test('matches mixed-case stored emails case-insensitively', async () => {
      mockedFindUserByEmailCaseInsensitive.mockResolvedValue([
        defineTestUser({
          id: USER_ID,
          google_user_email: 'Foo@Example.com',
          google_user_name: 'Foo',
          created_at: '2026-04-29T01:16:12.945Z',
        }),
      ]);

      const res = await GET(lookupRequest('Foo@Example.com'));
      expect(res.status).toBe(200);
      expect(mockedFindUserByEmailCaseInsensitive).toHaveBeenCalledWith('foo@example.com');
      expect(mockedFindUserByEmail).not.toHaveBeenCalled();
      const json = (await res.json()) as { email: string };
      expect(json.email).toBe('Foo@Example.com');
    });

    test('does not use findUserByNormalizedEmail for plus aliases', async () => {
      const res = await GET(lookupRequest('a+x@gmail.com'));
      expect(res.status).toBe(404);
      expect(mockedFindUserByEmailCaseInsensitive).toHaveBeenCalledWith('a+x@gmail.com');
      expect(mockedFindUserByNormalizedEmail).not.toHaveBeenCalled();
      expect(mockedFindUserByEmail).not.toHaveBeenCalled();
    });

    test('does not match a substring or similar email', async () => {
      const res = await GET(lookupRequest('user@example.com'));
      expect(res.status).toBe(404);
      expect(mockedFindUserByEmailCaseInsensitive).toHaveBeenCalledTimes(1);
      expect(mockedFindUserByEmailCaseInsensitive).toHaveBeenCalledWith('user@example.com');
    });

    test('returns 409 when more than one row matches', async () => {
      mockedFindUserByEmailCaseInsensitive.mockResolvedValue([
        defineTestUser({ id: USER_ID, google_user_email: 'dup@example.com' }),
        defineTestUser({
          id: '22222222-2222-4222-8222-222222222222',
          google_user_email: 'Dup@example.com',
        }),
      ]);

      const res = await GET(lookupRequest('dup@example.com'));
      expect(res.status).toBe(409);
      expect(events[0]).toMatchObject({ outcome: 'conflict' });
    });

    test('emits one admin_access event with support_service fields', async () => {
      mockedFindUserByEmailCaseInsensitive.mockResolvedValue([
        defineTestUser({
          id: USER_ID,
          google_user_email: 'customer@example.com',
          google_user_name: 'Ada',
          created_at: '2026-04-29T01:16:12.945Z',
        }),
      ]);

      const res = await GET(lookupRequest('Customer@Example.com'));
      expect(res.status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'admin_access',
        kind: 'support_service',
        email: 'support-automation',
        kiloUserId: 'support-automation',
        claimedActorEmail: ACTOR_EMAIL,
        tokenSource: 'support-automation',
        authVia: 'token',
        target: `user:${USER_ID}`,
        targetEmailHash: expectedEmailHash('customer@example.com'),
        correlationId: REQUEST_ID,
        outcome: 'found',
        method: 'GET',
        route: '/api/internal/support/users',
        ip: '203.0.113.7',
        adminTier: 'platform_admin',
      });
    });
  });
});
