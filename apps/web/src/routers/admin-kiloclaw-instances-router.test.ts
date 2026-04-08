import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { kiloclaw_admin_audit_logs, kiloclaw_cli_runs, kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetDebugStatus: jest.Mock<any, any> = jest.fn();
const mockDestroyFlyMachine: jest.Mock<any, any> = jest.fn();
const mockGetKiloCliRunStatus: jest.Mock<any, any> = jest.fn();

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    getDebugStatus: mockGetDebugStatus,
    destroyFlyMachine: mockDestroyFlyMachine,
    getKiloCliRunStatus: mockGetKiloCliRunStatus,
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
let cliRunUser: User;
let cliRunInstanceId: string;
let cliRunId: string;

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

  cliRunUser = await insertTestUser({
    google_user_email: 'admin-cli-run-target@example.com',
    is_admin: false,
  });

  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({
      id: crypto.randomUUID(),
      user_id: cliRunUser.id,
      sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
    })
    .returning({ id: kiloclaw_instances.id });

  cliRunInstanceId = instance.id;

  const [run] = await db
    .insert(kiloclaw_cli_runs)
    .values({
      user_id: cliRunUser.id,
      instance_id: cliRunInstanceId,
      prompt: 'older admin-target run',
      status: 'running',
      started_at: '2026-04-08T12:00:00.000Z',
      initiated_by: 'admin',
    })
    .returning({ id: kiloclaw_cli_runs.id });

  cliRunId = run.id;
});

beforeEach(async () => {
  mockGetDebugStatus.mockReset();
  mockDestroyFlyMachine.mockReset();
  mockGetKiloCliRunStatus.mockReset();
  // Clean audit logs between tests so counts are accurate
  await db
    .delete(kiloclaw_admin_audit_logs)
    .where(eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id));

  await db
    .update(kiloclaw_cli_runs)
    .set({
      status: 'running',
      exit_code: null,
      output: null,
      completed_at: null,
    })
    .where(eq(kiloclaw_cli_runs.id, cliRunId));
});

/* eslint-disable drizzle/enforce-delete-with-where */
afterAll(async () => {
  try {
    await db
      .delete(kiloclaw_admin_audit_logs)
      .where(eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id));
    await db.delete(kiloclaw_cli_runs).where(eq(kiloclaw_cli_runs.id, cliRunId));
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, cliRunInstanceId));
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
    expect(mockGetDebugStatus).toHaveBeenCalledWith(testUserId, undefined);
    expect(mockDestroyFlyMachine).toHaveBeenCalledWith(
      testUserId,
      testAppName,
      testMachineId,
      undefined
    );
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

describe('admin.kiloclawInstances.getKiloCliRunStatus', () => {
  it('does not overwrite a stored run when controller status belongs to a newer run', async () => {
    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'completed',
      output: 'newer admin run output',
      exitCode: 0,
      startedAt: '2026-04-08T12:05:00Z',
      completedAt: '2026-04-08T12:06:00Z',
      prompt: 'newer admin run',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.getKiloCliRunStatus({
      userId: cliRunUser.id,
      instanceId: cliRunInstanceId,
      runId: cliRunId,
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('newer admin run output');

    const [row] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, cliRunId));

    expect(row.status).toBe('running');
    expect(row.output).toBeNull();
    expect(row.completed_at).toBeNull();
  });
});
