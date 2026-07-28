import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import {
  assertUserCanBeSoftDeleted,
  softDeleteUser,
  SoftDeletePreconditionError,
  findUserById,
} from '@/lib/user';
import { softDeleteUserExternalServices } from '@/lib/external-services';
import {
  listAllActiveInstanceRows,
  markActiveInstanceBatchDestroyedForGdpr,
  restoreGdprDestroyedInstanceBatch,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { captureException } from '@sentry/nextjs';
import { POST } from './route';

jest.mock('@/lib/user/server');
jest.mock('@/lib/user');
jest.mock('@/lib/external-services');
jest.mock('@/lib/kiloclaw/instance-registry');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const destroy = jest.fn();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({ destroy })),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
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

const USER_ID = 'user-id';
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

function request() {
  return new NextRequest('http://localhost:3000/admin/api/users/gdpr-removal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER_ID }),
  });
}

describe('POST /admin/api/users/gdpr-removal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'admin-id' },
      authFailedResponse: null,
    } as never);
    mockedFindUserById.mockResolvedValue({ id: USER_ID } as never);
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

  test('groups duplicate legacy rows into one worker destroy and processes instance-keyed rows separately', async () => {
    mockedListAllActiveInstanceRows.mockResolvedValue([
      activeInstances[1],
      { ...activeInstances[1], id: 'legacy-duplicate' },
      activeInstances[0],
      { ...activeInstances[0], id: 'instance-three', sandboxId: 'ki_three' },
    ]);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).toHaveBeenNthCalledWith(1, USER_ID, [
      'instance-two',
      'legacy-duplicate',
    ]);
    expect(destroy).toHaveBeenNthCalledWith(1, USER_ID, undefined, {
      reason: 'admin_request',
    });
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).toHaveBeenNthCalledWith(2, USER_ID, [
      'instance-one',
    ]);
    expect(destroy).toHaveBeenNthCalledWith(2, USER_ID, 'instance-one', {
      reason: 'admin_request',
    });
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).toHaveBeenNthCalledWith(3, USER_ID, [
      'instance-three',
    ]);
    expect(destroy).toHaveBeenNthCalledWith(3, USER_ID, 'instance-three', {
      reason: 'admin_request',
    });
    expect(
      mockedMarkActiveInstanceBatchDestroyedForGdpr.mock.invocationCallOrder[1]
    ).toBeGreaterThan(destroy.mock.invocationCallOrder[0] ?? 0);
    expect(mockedSoftDeleteUser).toHaveBeenCalledWith(USER_ID);
    expect(mockedSoftDeleteUser.mock.invocationCallOrder[0]).toBeGreaterThan(
      destroy.mock.invocationCallOrder[2] ?? 0
    );
  });

  test('soft-deletes users with no active instances', async () => {
    mockedListAllActiveInstanceRows.mockResolvedValue([]);

    const noInstancesResponse = await POST(request());

    expect(noInstancesResponse.status).toBe(200);
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(mockedSoftDeleteUser).toHaveBeenCalledWith(USER_ID);
  });

  test('restores the failed batch and does not soft-delete when worker destruction fails', async () => {
    destroy.mockRejectedValueOnce(new Error('worker unavailable'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mockedRestoreGdprDestroyedInstanceBatch).toHaveBeenCalledWith({
      userId: USER_ID,
      instanceIds: ['instance-one'],
      destroyedAt: '2026-07-21T12:00:00.000Z',
    });
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });

  test('reports a rollback failure without masking the worker destruction error', async () => {
    const destroyError = new Error('worker unavailable');
    const rollbackError = new Error('instance batch changed concurrently');
    destroy.mockRejectedValueOnce(destroyError);
    mockedRestoreGdprDestroyedInstanceBatch.mockRejectedValueOnce(rollbackError);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mockedCaptureException).toHaveBeenNthCalledWith(1, rollbackError, {
      tags: { source: 'gdpr-removal', operation: 'restore-instance-batch' },
      extra: { userId: USER_ID, instanceIds: ['instance-one'] },
    });
    expect(mockedCaptureException).toHaveBeenNthCalledWith(2, destroyError, {
      tags: { source: 'gdpr-removal' },
      extra: { userId: USER_ID },
    });
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
  });

  test('returns subscription precondition failures before destructive calls', async () => {
    mockedAssertUserCanBeSoftDeleted.mockRejectedValue(
      new SoftDeletePreconditionError('active subscription')
    );

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mockedListAllActiveInstanceRows).not.toHaveBeenCalled();
    expect(mockedMarkActiveInstanceBatchDestroyedForGdpr).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(mockedSoftDeleteUser).not.toHaveBeenCalled();
  });

  test('returns the authentication failure without looking up the target user', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });
});
