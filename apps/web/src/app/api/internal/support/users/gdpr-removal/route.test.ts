import { NextRequest } from 'next/server';
import {
  assertUserCanBeSoftDeleted,
  findUserById,
  softDeleteUser,
  SoftDeletePreconditionError,
} from '@/lib/user';
import { getUserFromAuth } from '@/lib/user/server';
import { softDeleteUserExternalServices } from '@/lib/external-services';
import {
  listAllActiveInstanceRows,
  markActiveInstanceBatchDestroyedForGdpr,
  restoreGdprDestroyedInstanceBatch,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { createKiloClawAdminAuditLog } from '@/lib/kiloclaw/admin-audit-log';
import { captureException } from '@sentry/nextjs';
import { setAdminAccessSinkForTest, type AdminAccessEvent } from '@/lib/admin/admin-access-log';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
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

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@/lib/user');
jest.mock('@/lib/external-services');
jest.mock('@/lib/kiloclaw/instance-registry');
jest.mock('@/lib/kiloclaw/admin-audit-log', () => ({
  createKiloClawAdminAuditLog: jest.fn().mockResolvedValue({}),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const destroy = jest.fn();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({ destroy })),
}));

import { POST } from './route';

const mockedFindUserById = jest.mocked(findUserById);
const mockedAssertUserCanBeSoftDeleted = jest.mocked(assertUserCanBeSoftDeleted);
const mockedSoftDeleteUser = jest.mocked(softDeleteUser);
const mockedSoftDeleteUserExternalServices = jest.mocked(softDeleteUserExternalServices);
const mockedListAllActiveInstanceRows = jest.mocked(listAllActiveInstanceRows);
const mockedMarkActiveInstanceBatchDestroyedForGdpr = jest.mocked(
  markActiveInstanceBatchDestroyedForGdpr
);
const mockedRestoreGdprDestroyedInstanceBatch = jest.mocked(restoreGdprDestroyedInstanceBatch);
const mockedWorkerInstanceId = jest.mocked(workerInstanceId);
const mockedCaptureException = jest.mocked(captureException);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCreateKiloClawAdminAuditLog = jest.mocked(createKiloClawAdminAuditLog);

const SUPPORT_SECRET = 'mock-support-api-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_EMAIL = 'customer@example.com';
const ACTOR_EMAIL = 'alice@kilocode.ai';
const REQUEST_ID = 'csa-req-delete-1';

const activeInstances = [
  {
    id: 'instance-one',
    userId: USER_ID,
    sandboxId: 'ki_one',
    organizationId: null,
    name: null,
    inboundEmailEnabled: false,
  },
  {
    id: 'instance-two',
    userId: USER_ID,
    sandboxId: 'legacy-user-derived-sandbox',
    organizationId: null,
    name: null,
    inboundEmailEnabled: false,
  },
] as const;

function targetUser(overrides: Parameters<typeof defineTestUser>[0] = {}) {
  return defineTestUser({
    id: USER_ID,
    google_user_email: CUSTOMER_EMAIL,
    google_user_name: 'Ada',
    is_admin: false,
    is_super_admin: false,
    is_bot: false,
    hosted_domain: null,
    blocked_reason: null,
    ...overrides,
  });
}

function request(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest('http://localhost:3000/api/internal/support/users/gdpr-removal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPPORT_SECRET}`,
      'x-pathname': '/api/internal/support/users/gdpr-removal',
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
    body: JSON.stringify({
      userId: USER_ID,
      email: CUSTOMER_EMAIL,
      actorEmail: ACTOR_EMAIL,
      requestId: REQUEST_ID,
      ...body,
    }),
  });
}

describe('POST /api/internal/support/users/gdpr-removal', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecrets.SUPPORT_API_SECRET = SUPPORT_SECRET;
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
    mockedFindUserById.mockResolvedValue(targetUser());
    mockedAssertUserCanBeSoftDeleted.mockResolvedValue();
    mockedSoftDeleteUser.mockResolvedValue();
    mockedSoftDeleteUserExternalServices.mockResolvedValue([]);
    mockedListAllActiveInstanceRows.mockResolvedValue([...activeInstances]);
    mockedMarkActiveInstanceBatchDestroyedForGdpr.mockImplementation(
      async (_userId, instanceIds) => ({
        userId: USER_ID,
        instanceIds,
        destroyedAt: '2026-07-21T12:00:00.000Z',
      })
    );
    mockedWorkerInstanceId.mockImplementation(instance =>
      instance?.sandboxId?.startsWith('ki_') ? instance.id : undefined
    );
    destroy.mockResolvedValue({});
  });

  afterEach(() => {
    setAdminAccessSinkForTest(null);
  });

  describe('auth', () => {
    test('returns 401 when Authorization is missing', async () => {
      const res = await POST(request({}, { Authorization: '' }));
      expect(res.status).toBe(401);
      expect(mockedFindUserById).not.toHaveBeenCalled();
      expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when the secret is wrong', async () => {
      const res = await POST(request({}, { Authorization: 'Bearer wrong' }));
      expect(res.status).toBe(401);
      expect(destroy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when SUPPORT_API_SECRET is empty', async () => {
      mockSecrets.SUPPORT_API_SECRET = '';
      const res = await POST(request());
      expect(res.status).toBe(401);
      expect(destroy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when the bearer token is empty', async () => {
      const res = await POST(request({}, { Authorization: 'Bearer ' }));
      expect(res.status).toBe(401);
      expect(events).toHaveLength(0);
    });

    test('returns 401 for a JWT-shaped bearer and does not call getUserFromAuth', async () => {
      const res = await POST(
        request({}, { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig' })
      );
      expect(res.status).toBe(401);
      expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 401 when INTERNAL_API_SECRET is sent as the bearer', async () => {
      const res = await POST(request({}, { Authorization: 'Bearer mock-secret' }));
      expect(res.status).toBe(401);
      expect(events).toHaveLength(0);
    });
  });

  describe('validation', () => {
    test('returns 400 for an empty userId', async () => {
      const res = await POST(request({ userId: '   ' }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid body' });
      expect(mockedFindUserById).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    test('returns 400 for a non-staff actorEmail domain', async () => {
      const res = await POST(request({ actorEmail: 'alice@gmail.com' }));
      expect(res.status).toBe(400);
      expect(destroy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
  });

  test('accepts legacy oauth/google user ids', async () => {
    const legacyUserId = 'oauth/google:113825116714119418413';
    mockedFindUserById.mockResolvedValue(
      targetUser({ id: legacyUserId, google_user_email: CUSTOMER_EMAIL })
    );
    mockedListAllActiveInstanceRows.mockResolvedValue([]);
    mockedAssertUserCanBeSoftDeleted.mockResolvedValue(undefined);
    mockedSoftDeleteUser.mockResolvedValue(undefined as never);
    mockedSoftDeleteUserExternalServices.mockResolvedValue([]);

    const res = await POST(request({ userId: legacyUserId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      message: expect.stringContaining(legacyUserId),
    });
    expect(mockedFindUserById).toHaveBeenCalledWith(legacyUserId);
    expect(mockedSoftDeleteUser).toHaveBeenCalledWith(legacyUserId);
    expect(events[0]).toMatchObject({
      outcome: 'deleted',
      claimedActorEmail: ACTOR_EMAIL,
      correlationId: REQUEST_ID,
      target: `user:${legacyUserId}`,
    });
  });

  test('returns JSON 404 for an unknown user', async () => {
    mockedFindUserById.mockResolvedValue(undefined);

    const res = await POST(request());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'User not found' });
    expect(destroy).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      outcome: 'not_found',
      claimedActorEmail: ACTOR_EMAIL,
      correlationId: REQUEST_ID,
      target: null,
    });
  });

  test('returns JSON 500 when findUserById throws', async () => {
    mockedFindUserById.mockRejectedValue(new Error('db down'));

    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(destroy).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      outcome: 'error',
      claimedActorEmail: ACTOR_EMAIL,
      correlationId: REQUEST_ID,
      target: `user:${USER_ID}`,
    });
  });

  test('returns 200 for an already soft-deleted user and does not destroy', async () => {
    mockedFindUserById.mockResolvedValue(
      targetUser({
        google_user_email: `deleted+${USER_ID}@deleted.invalid`,
        blocked_reason: createSoftDeletedBlockedReason(),
      })
    );

    const res = await POST(request({ email: CUSTOMER_EMAIL }));
    expect(res.status).toBe(200);
    expect(destroy).not.toHaveBeenCalled();
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
    expect(mockedAssertUserCanBeSoftDeleted).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      outcome: 'already_deleted',
      target: `user:${USER_ID}`,
      claimedActorEmail: ACTOR_EMAIL,
      correlationId: REQUEST_ID,
    });
  });

  test('returns 409 on email mismatch and does not destroy', async () => {
    mockedFindUserById.mockResolvedValue(targetUser({ google_user_email: CUSTOMER_EMAIL }));

    const res = await POST(request({ email: 'other@example.com' }));
    expect(res.status).toBe(409);
    expect(destroy).not.toHaveBeenCalled();
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ outcome: 'conflict', target: `user:${USER_ID}` });
  });

  test.each([
    { name: 'admin', overrides: { is_admin: true } },
    { name: 'super_admin', overrides: { is_super_admin: true } },
    { name: 'bot', overrides: { is_bot: true } },
    { name: '@kilocode.ai email', overrides: { google_user_email: 'staff@kilocode.ai' } },
    { name: '@kilo.ai email', overrides: { google_user_email: 'staff@kilo.ai' } },
    {
      name: 'subdomain of kilocode.ai',
      overrides: { google_user_email: 'user@corp.kilocode.ai' },
    },
    {
      name: 'mixed-case KiloCode.ai',
      overrides: { google_user_email: 'Admin@KiloCode.ai' },
    },
    { name: 'hosted_domain kilocode.ai', overrides: { hosted_domain: 'kilocode.ai' } },
  ])('returns 403 for $name and does not destroy', async ({ overrides }) => {
    mockedFindUserById.mockResolvedValue(
      targetUser({
        google_user_email: (overrides.google_user_email as string | undefined) ?? CUSTOMER_EMAIL,
        ...overrides,
      })
    );

    const res = await POST(
      request({
        email: (
          (overrides.google_user_email as string | undefined) ?? CUSTOMER_EMAIL
        ).toLowerCase(),
      })
    );
    expect(res.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
    expect(mockedAssertUserCanBeSoftDeleted).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ outcome: 'refused', target: `user:${USER_ID}` });
  });

  test('does not refuse evilkilocode.ai', async () => {
    mockedFindUserById.mockResolvedValue(targetUser({ google_user_email: 'user@evilkilocode.ai' }));
    mockedListAllActiveInstanceRows.mockResolvedValue([]);

    const res = await POST(request({ email: 'user@evilkilocode.ai' }));
    expect(res.status).toBe(200);
    expect(mockedSoftDeleteUser).toHaveBeenCalledWith(USER_ID);
    expect(events[0]).toMatchObject({ outcome: 'deleted' });
  });

  test('returns subscription precondition failures before destructive calls', async () => {
    mockedAssertUserCanBeSoftDeleted.mockRejectedValue(
      new SoftDeletePreconditionError('active subscription')
    );

    const res = await POST(request());
    expect(res.status).toBe(400);
    expect(mockedListAllActiveInstanceRows).not.toHaveBeenCalled();
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ outcome: 'precondition' });
  });

  test('groups duplicate legacy rows into one worker destroy and processes instance-keyed rows separately', async () => {
    mockedListAllActiveInstanceRows.mockResolvedValue([
      activeInstances[1],
      { ...activeInstances[1], id: 'legacy-duplicate' },
      activeInstances[0],
      { ...activeInstances[0], id: 'instance-three', sandboxId: 'ki_three' },
    ]);

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).toHaveBeenNthCalledWith(1, USER_ID, [
      'instance-two',
      'legacy-duplicate',
    ]);
    expect(destroy).toHaveBeenNthCalledWith(1, USER_ID, undefined, {
      reason: 'admin_request',
    });
    expect(destroy).not.toHaveBeenCalledWith(
      USER_ID,
      expect.anything(),
      expect.objectContaining({ reason: 'support_request' })
    );
    expect(mockedCreateKiloClawAdminAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'kiloclaw.instance.destroy',
        actor_id: 'support-automation',
        actor_email: ACTOR_EMAIL,
        target_user_id: USER_ID,
      })
    );
    expect(mockedSoftDeleteUser).toHaveBeenCalledWith(USER_ID);
    expect(events[0]).toMatchObject({
      kind: 'support_service',
      email: 'support-automation',
      claimedActorEmail: ACTOR_EMAIL,
      outcome: 'deleted',
      target: `user:${USER_ID}`,
      correlationId: REQUEST_ID,
      targetEmailHash: null,
      method: 'POST',
      tokenSource: 'support-automation',
    });
  });

  test('soft-deletes users with no active instances', async () => {
    mockedListAllActiveInstanceRows.mockResolvedValue([]);

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(mockedSoftDeleteUser).toHaveBeenCalledWith(USER_ID);
  });

  test('restores the failed batch and does not soft-delete when worker destruction fails', async () => {
    destroy.mockRejectedValueOnce(new Error('worker unavailable'));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(mockedRestoreGdprDestroyedInstanceBatch).toHaveBeenCalledWith({
      userId: USER_ID,
      instanceIds: ['instance-one'],
      destroyedAt: '2026-07-21T12:00:00.000Z',
    });
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
    expect(events[0]).toMatchObject({ outcome: 'error' });
  });

  test('reports a rollback failure without masking the worker destruction error', async () => {
    const destroyError = new Error('worker unavailable');
    const rollbackError = new Error('instance batch changed concurrently');
    destroy.mockRejectedValueOnce(destroyError);
    mockedRestoreGdprDestroyedInstanceBatch.mockRejectedValueOnce(rollbackError);

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(mockedCaptureException).toHaveBeenNthCalledWith(1, rollbackError, {
      tags: { source: 'gdpr-removal', operation: 'restore-instance-batch' },
      extra: { userId: USER_ID, instanceIds: ['instance-one'] },
    });
    expect(mockedCaptureException).toHaveBeenNthCalledWith(2, destroyError, {
      tags: { source: 'support-gdpr-removal' },
      extra: { userId: USER_ID },
    });
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
  });
});
