import { NextRequest } from 'next/server';
import { findUserById } from '@/lib/user';
import { getUserFromAuth } from '@/lib/user/server';
import { getUserDeletionRequestById } from '@/lib/user/deletion';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { DeletionRefusalCode } from '@/lib/user/deletion-queue/deletion-intake';
import { setAdminAccessSinkForTest, type AdminAccessEvent } from '@/lib/admin/admin-access-log';
import { defineTestUser } from '@/tests/helpers/user.helper';

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
  findUserById: jest.fn(),
}));

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/user/deletion', () => ({
  getUserDeletionRequestById: jest.fn(),
}));

jest.mock('@/lib/user/deletion-queue/deletion-enqueue', () => ({
  enqueueUserDeletionTargets: jest.fn(),
}));

import { GET, POST } from './route';

const mockedFindUserById = jest.mocked(findUserById);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetUserDeletionRequestById = jest.mocked(getUserDeletionRequestById);
const mockedEnqueueUserDeletionTargets = jest.mocked(enqueueUserDeletionTargets);

const SUPPORT_SECRET = 'mock-support-api-secret';
const ACTOR_EMAIL = 'alice@kilocode.ai';
const CSA_REQUEST_ID = 'csa-req-del-1';
const CLOUD_REQUEST_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function postRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/internal/support/users/gdpr-removal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPPORT_SECRET}`,
      'X-Actor-Email': ACTOR_EMAIL,
      'X-Request-Id': CSA_REQUEST_ID,
      'Content-Type': 'application/json',
      'x-pathname': '/api/internal/support/users/gdpr-removal',
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getRequest(requestId: string | null, headers: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/internal/support/users/gdpr-removal');
  if (requestId !== null) url.searchParams.set('requestId', requestId);
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${SUPPORT_SECRET}`,
      'X-Actor-Email': ACTOR_EMAIL,
      'X-Request-Id': CSA_REQUEST_ID,
      'x-pathname': '/api/internal/support/users/gdpr-removal',
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
  });
}

describe('/api/internal/support/users/gdpr-removal', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecrets.SUPPORT_API_SECRET = SUPPORT_SECRET;
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
  });

  afterEach(() => {
    setAdminAccessSinkForTest(null);
  });

  describe('POST (start deletion job)', () => {
    describe('auth', () => {
      test('returns 401 when Authorization is missing', async () => {
        const res = await POST(
          postRequest(
            {
              userId: USER_ID,
              email: 'customer@example.com',
              actorEmail: ACTOR_EMAIL,
              requestId: CSA_REQUEST_ID,
            },
            { Authorization: '' }
          )
        );
        expect(res.status).toBe(401);
        expect(mockedFindUserById).not.toHaveBeenCalled();
        expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
      });

      test('returns 401 when the secret is wrong', async () => {
        const res = await POST(
          postRequest(
            {
              userId: USER_ID,
              email: 'customer@example.com',
              actorEmail: ACTOR_EMAIL,
              requestId: CSA_REQUEST_ID,
            },
            { Authorization: 'Bearer wrong' }
          )
        );
        expect(res.status).toBe(401);
        expect(mockedFindUserById).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
      });
    });

    describe('validation', () => {
      test('returns 400 when body is invalid JSON', async () => {
        const res = await POST(postRequest('{invalid-json'));
        expect(res.status).toBe(400);
        expect(mockedFindUserById).not.toHaveBeenCalled();
      });

      test('returns 400 when actorEmail is invalid', async () => {
        const res = await POST(
          postRequest({
            userId: USER_ID,
            email: 'customer@example.com',
            actorEmail: 'alice@gmail.com',
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(400);
        expect(mockedFindUserById).not.toHaveBeenCalled();
      });

      test('returns 400 when userId is not a UUID', async () => {
        const res = await POST(
          postRequest({
            userId: 'not-a-uuid',
            email: 'customer@example.com',
            actorEmail: ACTOR_EMAIL,
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(400);
        expect(mockedFindUserById).not.toHaveBeenCalled();
      });
    });

    describe('business logic', () => {
      test('returns 404 when user does not exist', async () => {
        mockedFindUserById.mockResolvedValue(undefined);
        const res = await POST(
          postRequest({
            userId: USER_ID,
            email: 'customer@example.com',
            actorEmail: ACTOR_EMAIL,
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({
          error: 'User not found',
          code: 'USER_NOT_FOUND',
        });
        expect(events[0]).toMatchObject({ outcome: 'not_found' });
      });

      test('returns 409 when user email does not match requested email', async () => {
        mockedFindUserById.mockResolvedValue(
          defineTestUser({ id: USER_ID, google_user_email: 'other@example.com' })
        );
        const res = await POST(
          postRequest({
            userId: USER_ID,
            email: 'customer@example.com',
            actorEmail: ACTOR_EMAIL,
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'Email does not match user' });
        expect(events[0]).toMatchObject({ outcome: 'conflict' });
        expect(mockedEnqueueUserDeletionTargets).not.toHaveBeenCalled();
      });

      test('returns 202 already_deleted when the user is already soft-deleted', async () => {
        mockedFindUserById.mockResolvedValue(
          defineTestUser({
            id: USER_ID,
            google_user_email: `deleted+${USER_ID}@deleted.invalid`,
            blocked_reason: 'soft-deleted at 2026-08-13T00:00:00.000Z',
          })
        );
        const res = await POST(
          postRequest({
            userId: USER_ID,
            email: 'customer@example.com',
            actorEmail: ACTOR_EMAIL,
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ status: 'already_deleted' });
        expect(mockedEnqueueUserDeletionTargets).not.toHaveBeenCalled();
        expect(events[0]).toMatchObject({ outcome: 'already_deleted' });
      });

      test('returns 403 when user is protected (staff or admin)', async () => {
        mockedFindUserById.mockResolvedValue(
          defineTestUser({ id: USER_ID, google_user_email: 'staff@kilo.ai', is_admin: true })
        );
        const res = await POST(
          postRequest({
            userId: USER_ID,
            email: 'staff@kilo.ai',
            actorEmail: ACTOR_EMAIL,
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Support API cannot delete this account' });
        expect(events[0]).toMatchObject({ outcome: 'refused' });
      });

      test('returns 400 when enqueue returns refused', async () => {
        mockedFindUserById.mockResolvedValue(
          defineTestUser({ id: USER_ID, google_user_email: 'customer@example.com' })
        );
        mockedEnqueueUserDeletionTargets.mockResolvedValue([
          { status: 'refused', code: DeletionRefusalCode.ProtectedAdmin },
        ]);
        const res = await POST(
          postRequest({
            userId: USER_ID,
            email: 'customer@example.com',
            actorEmail: ACTOR_EMAIL,
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(400);
        expect(events[0]).toMatchObject({ outcome: 'refused' });
      });

      test('returns 202 with requestId when enqueued successfully', async () => {
        mockedFindUserById.mockResolvedValue(
          defineTestUser({ id: USER_ID, google_user_email: 'customer@example.com' })
        );
        mockedEnqueueUserDeletionTargets.mockResolvedValue([
          { status: 'enqueued', requestId: CLOUD_REQUEST_ID },
        ]);
        const res = await POST(
          postRequest({
            userId: USER_ID,
            email: 'customer@example.com',
            actorEmail: ACTOR_EMAIL,
            requestId: CSA_REQUEST_ID,
          })
        );
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({
          requestId: CLOUD_REQUEST_ID,
          status: 'enqueued',
        });
        expect(events[0]).toMatchObject({
          event: 'admin_access',
          kind: 'support_service',
          outcome: 'enqueued',
          target: `user:${USER_ID}`,
        });
      });
    });
  });

  describe('GET (poll status)', () => {
    test('returns 401 when Authorization is missing', async () => {
      const res = await GET(getRequest(CLOUD_REQUEST_ID, { Authorization: '' }));
      expect(res.status).toBe(401);
      expect(mockedGetUserDeletionRequestById).not.toHaveBeenCalled();
    });

    test('returns 400 when requestId query param is missing', async () => {
      const res = await GET(getRequest(null));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid requestId' });
      expect(mockedGetUserDeletionRequestById).not.toHaveBeenCalled();
    });

    test('returns 400 when requestId is not a UUID', async () => {
      const res = await GET(getRequest(CSA_REQUEST_ID));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid requestId' });
      expect(mockedGetUserDeletionRequestById).not.toHaveBeenCalled();
    });

    test('returns 404 when deletion request is not found', async () => {
      mockedGetUserDeletionRequestById.mockResolvedValue(null);
      const res = await GET(getRequest(CLOUD_REQUEST_ID));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: 'Deletion request not found',
        code: 'DELETION_REQUEST_NOT_FOUND',
      });
      expect(events[0]).toMatchObject({ outcome: 'not_found' });
    });

    test('returns job status when in_progress', async () => {
      mockedGetUserDeletionRequestById.mockResolvedValue({
        request: {
          id: CLOUD_REQUEST_ID,
          status: 'in_progress',
          created_at: '2026-08-13T09:45:00.000Z',
          completed_at: null,
        } as never,
        steps: [],
      });
      const res = await GET(getRequest(CLOUD_REQUEST_ID));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'in_progress',
        startedAt: '2026-08-13T09:45:00.000Z',
        completedAt: null,
      });
      expect(events[0]).toMatchObject({ outcome: 'found' });
    });

    test('returns job status when completed', async () => {
      mockedGetUserDeletionRequestById.mockResolvedValue({
        request: {
          id: CLOUD_REQUEST_ID,
          status: 'completed',
          created_at: '2026-08-13T09:45:00.000Z',
          completed_at: '2026-08-13T09:50:00.000Z',
        } as never,
        steps: [],
      });
      const res = await GET(getRequest(CLOUD_REQUEST_ID));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'completed',
        startedAt: '2026-08-13T09:45:00.000Z',
        completedAt: '2026-08-13T09:50:00.000Z',
      });
      expect(events[0]).toMatchObject({ outcome: 'found' });
    });
  });
});
