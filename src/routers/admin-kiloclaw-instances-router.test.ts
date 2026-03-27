import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { kiloclaw_admin_audit_logs } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetDebugStatus: jest.Mock<any, any> = jest.fn();
const mockDestroyFlyMachine: jest.Mock<any, any> = jest.fn();

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    getDebugStatus: mockGetDebugStatus,
    destroyFlyMachine: mockDestroyFlyMachine,
  })),
  KiloClawApiError: class KiloClawApiError extends Error {
    statusCode: number;
    responseBody: string;
    constructor(statusCode: number, responseBody: string) {
      super(`KiloClawApiError: ${statusCode}`);
      this.statusCode = statusCode;
      this.responseBody = responseBody;
    }
  },
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

let regularUser: User;
let adminUser: User;

const testAppName = 'acct-abc123def456';
const testMachineId = 'd8901e123456';
const testUserId = 'test-target-user-id';

beforeAll(async () => {
  regularUser = await insertTestUser({
    google_user_email: 'regular-destroy-machine@example.com',
    is_admin: false,
  });
  adminUser = await insertTestUser({
    google_user_email: 'admin-destroy-machine@admin.example.com',
    is_admin: true,
  });
});

beforeEach(async () => {
  mockGetDebugStatus.mockReset();
  mockDestroyFlyMachine.mockReset();
  // Clean audit logs between tests so counts are accurate
  await db
    .delete(kiloclaw_admin_audit_logs)
    .where(eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id));
});

/* eslint-disable drizzle/enforce-delete-with-where */
afterAll(async () => {
  try {
    await db
      .delete(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id));
  } catch {
    // Test DB may already be torn down
  }
});
/* eslint-enable drizzle/enforce-delete-with-where */

describe('admin.kiloclawInstances.destroyFlyMachine', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyFlyMachine({
        userId: testUserId,
        appName: testAppName,
        machineId: testMachineId,
      })
    ).rejects.toThrow('Admin access required');

    expect(mockGetDebugStatus).not.toHaveBeenCalled();
  });

  it('destroys the Fly machine when appName/machineId match DO state', async () => {
    mockGetDebugStatus.mockResolvedValue({
      flyAppName: testAppName,
      flyMachineId: testMachineId,
      status: 'running',
    });
    mockDestroyFlyMachine.mockResolvedValue({ ok: true });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.destroyFlyMachine({
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });

    expect(result).toEqual({ ok: true });
    expect(mockGetDebugStatus).toHaveBeenCalledWith(testUserId);
    expect(mockDestroyFlyMachine).toHaveBeenCalledWith(testUserId, testAppName, testMachineId);
  });

  it('throws BAD_REQUEST when appName does not match DO state', async () => {
    mockGetDebugStatus.mockResolvedValue({
      flyAppName: 'acct-different',
      flyMachineId: testMachineId,
      status: 'running',
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyFlyMachine({
        userId: testUserId,
        appName: testAppName,
        machineId: testMachineId,
      })
    ).rejects.toThrow('Fly resource mismatch');

    expect(mockDestroyFlyMachine).not.toHaveBeenCalled();
  });

  it('throws BAD_REQUEST when machineId does not match DO state', async () => {
    mockGetDebugStatus.mockResolvedValue({
      flyAppName: testAppName,
      flyMachineId: 'differentmachineid',
      status: 'running',
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyFlyMachine({
        userId: testUserId,
        appName: testAppName,
        machineId: testMachineId,
      })
    ).rejects.toThrow('Fly resource mismatch');

    expect(mockDestroyFlyMachine).not.toHaveBeenCalled();
  });

  it('writes an audit log on success', async () => {
    mockGetDebugStatus.mockResolvedValue({
      flyAppName: testAppName,
      flyMachineId: testMachineId,
      status: 'running',
    });
    mockDestroyFlyMachine.mockResolvedValue({ ok: true });

    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.kiloclawInstances.destroyFlyMachine({
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });

    const logs = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        and(
          eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
          eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.machine.destroy_fly')
        )
      );

    expect(logs).toHaveLength(1);
    expect(logs[0].target_user_id).toBe(testUserId);
    expect(logs[0].actor_email).toBe(adminUser.google_user_email);
    expect(logs[0].message).toContain(testAppName);
    expect(logs[0].message).toContain(testMachineId);
    expect(logs[0].metadata).toEqual({ appName: testAppName, machineId: testMachineId });
  });

  it('wraps generic errors as INTERNAL_SERVER_ERROR', async () => {
    mockGetDebugStatus.mockResolvedValue({
      flyAppName: testAppName,
      flyMachineId: testMachineId,
      status: 'running',
    });
    mockDestroyFlyMachine.mockRejectedValue(new Error('Fly API timeout'));

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyFlyMachine({
        userId: testUserId,
        appName: testAppName,
        machineId: testMachineId,
      })
    ).rejects.toThrow('Failed to destroy Fly machine: Fly API timeout');
  });

  it('maps KiloClawApiError 404 to NOT_FOUND', async () => {
    const { KiloClawApiError } = jest.requireMock<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      KiloClawApiError: new (statusCode: number, responseBody: string) => any;
    }>('@/lib/kiloclaw/kiloclaw-internal-client');

    mockGetDebugStatus.mockResolvedValue({
      flyAppName: testAppName,
      flyMachineId: testMachineId,
      status: 'running',
    });
    mockDestroyFlyMachine.mockRejectedValue(
      new KiloClawApiError(404, JSON.stringify({ error: 'machine not found' }))
    );

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyFlyMachine({
        userId: testUserId,
        appName: testAppName,
        machineId: testMachineId,
      })
    ).rejects.toThrow('machine not found');
  });

  it('rejects invalid appName format', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyFlyMachine({
        userId: testUserId,
        appName: 'INVALID_APP_NAME',
        machineId: testMachineId,
      })
    ).rejects.toThrow('Invalid Fly app name');

    expect(mockGetDebugStatus).not.toHaveBeenCalled();
  });

  it('rejects invalid machineId format', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyFlyMachine({
        userId: testUserId,
        appName: testAppName,
        machineId: 'INVALID-MACHINE-ID',
      })
    ).rejects.toThrow('Invalid Fly machine ID');

    expect(mockGetDebugStatus).not.toHaveBeenCalled();
  });
});
