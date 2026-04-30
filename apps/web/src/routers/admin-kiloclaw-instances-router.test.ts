import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  kiloclaw_admin_audit_logs,
  kiloclaw_cli_runs,
  kiloclaw_image_catalog,
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kiloclaw_version_pins,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { UpstreamApiError } from '@/lib/trpc/init';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetDebugStatus: jest.Mock<any, any> = jest.fn();
const mockDestroyFlyMachine: jest.Mock<any, any> = jest.fn();
const mockGetKiloCliRunStatus: jest.Mock<any, any> = jest.fn();
const mockCancelKiloCliRun: jest.Mock<any, any> = jest.fn();
const mockStartKiloCliRun: jest.Mock<any, any> = jest.fn();
const mockStart: jest.Mock<any, any> = jest.fn();
const mockUserClientRestartMachine: jest.Mock<any, any> = jest.fn();
const startedResponse = {
  ok: true,
  started: true,
  previousStatus: 'stopped',
  currentStatus: 'running',
  startedAt: 1_776_885_000_000,
};

function mockKiloClawInternalClient() {
  const { KiloClawInternalClient } = jest.requireMock('@/lib/kiloclaw/kiloclaw-internal-client');
  KiloClawInternalClient.mockImplementation(() => ({
    getDebugStatus: mockGetDebugStatus,
    destroyFlyMachine: mockDestroyFlyMachine,
    getKiloCliRunStatus: mockGetKiloCliRunStatus,
    cancelKiloCliRun: mockCancelKiloCliRun,
    startKiloCliRun: mockStartKiloCliRun,
    start: mockStart,
  }));
}

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    getDebugStatus: mockGetDebugStatus,
    destroyFlyMachine: mockDestroyFlyMachine,
    getKiloCliRunStatus: mockGetKiloCliRunStatus,
    cancelKiloCliRun: mockCancelKiloCliRun,
    startKiloCliRun: mockStartKiloCliRun,
    start: mockStart,
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

jest.mock('@/lib/kiloclaw/kiloclaw-user-client', () => ({
  KiloClawUserClient: jest.fn().mockImplementation(() => ({
    restartMachine: mockUserClientRestartMachine,
  })),
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

function flyDebugStatus(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'fly',
    runtimeId: testMachineId,
    storageId: 'vol-test',
    region: 'iad',
    flyAppName: testAppName,
    flyMachineId: testMachineId,
    status: 'running',
    ...overrides,
  };
}

async function insertInboundEmailInstance() {
  const instanceId = crypto.randomUUID();
  const alias = `admin-test-${instanceId.slice(0, 8)}`;
  await db.insert(kiloclaw_instances).values({
    id: instanceId,
    user_id: regularUser.id,
    sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
  });
  await db.insert(kiloclaw_inbound_email_reserved_aliases).values({ alias });
  await db.insert(kiloclaw_inbound_email_aliases).values({ alias, instance_id: instanceId });
  return { instanceId, alias };
}

beforeEach(async () => {
  regularUser = await insertTestUser({
    google_user_email: `regular-destroy-machine-${Math.random()}@example.com`,
    is_admin: false,
  });
  adminUser = await insertTestUser({
    google_user_email: `admin-destroy-machine-${Math.random()}@admin.example.com`,
    is_admin: true,
  });

  cliRunUser = await insertTestUser({
    google_user_email: `admin-cli-run-target-${Math.random()}@example.com`,
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
      initiated_by_admin_id: adminUser.id,
    })
    .returning({ id: kiloclaw_cli_runs.id });

  cliRunId = run.id;
  mockGetDebugStatus.mockReset();
  mockDestroyFlyMachine.mockReset();
  mockGetKiloCliRunStatus.mockReset();
  mockCancelKiloCliRun.mockReset();
  mockStartKiloCliRun.mockReset();
  mockStart.mockReset();
  mockStart.mockResolvedValue(startedResponse);
  mockUserClientRestartMachine.mockReset();
  mockUserClientRestartMachine.mockResolvedValue({ success: true, message: 'restarting' });
  mockKiloClawInternalClient();
});

/* eslint-disable drizzle/enforce-delete-with-where */
afterEach(async () => {
  const userIds = [regularUser.id, adminUser.id, cliRunUser.id];
  await db
    .delete(kiloclaw_admin_audit_logs)
    .where(eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id));
  await db.delete(kiloclaw_subscriptions).where(inArray(kiloclaw_subscriptions.user_id, userIds));
  // Delete cli_runs before instances (cli_runs.instance_id FK → instances)
  await db.delete(kiloclaw_cli_runs).where(inArray(kiloclaw_cli_runs.user_id, userIds));
  // Deleting instances cascades to inbound email aliases
  await db.delete(kiloclaw_instances).where(inArray(kiloclaw_instances.user_id, userIds));
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
});
/* eslint-enable drizzle/enforce-delete-with-where */

describe('admin.kiloclawInstances.listKiloCliRuns', () => {
  it('returns all runs for a user when instanceId is omitted', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.listKiloCliRuns({
      userId: cliRunUser.id,
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ id: cliRunId });
  });

  it('scopes runs to a specific instance when instanceId is provided', async () => {
    const secondInstanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: secondInstanceId,
      user_id: cliRunUser.id,
      sandbox_id: `ki_${secondInstanceId.replace(/-/g, '')}`,
    });

    const [secondRun] = await db
      .insert(kiloclaw_cli_runs)
      .values({
        user_id: cliRunUser.id,
        instance_id: secondInstanceId,
        prompt: 'run on second instance',
        status: 'running',
        started_at: '2026-04-08T13:00:00.000Z',
      })
      .returning({ id: kiloclaw_cli_runs.id });

    try {
      const caller = await createCallerForUser(adminUser.id);

      // Without instanceId — returns both
      const allResult = await caller.admin.kiloclawInstances.listKiloCliRuns({
        userId: cliRunUser.id,
      });
      expect(allResult.runs).toHaveLength(2);

      // With first instanceId — returns only the first run
      const firstResult = await caller.admin.kiloclawInstances.listKiloCliRuns({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
      });
      expect(firstResult.runs).toHaveLength(1);
      expect(firstResult.runs[0]).toMatchObject({ id: cliRunId });

      // With second instanceId — returns only the second run
      const secondResult = await caller.admin.kiloclawInstances.listKiloCliRuns({
        userId: cliRunUser.id,
        instanceId: secondInstanceId,
      });
      expect(secondResult.runs).toHaveLength(1);
      expect(secondResult.runs[0]).toMatchObject({ id: secondRun.id });
    } finally {
      /* eslint-disable drizzle/enforce-delete-with-where */
      await db.delete(kiloclaw_cli_runs).where(eq(kiloclaw_cli_runs.id, secondRun.id));
      await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, secondInstanceId));
      /* eslint-enable drizzle/enforce-delete-with-where */
    }
  });
});

describe('admin.kiloclawInstances.list and stats', () => {
  it('separates inactive trial stopped instances from active instances', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const baselineStats = await caller.admin.kiloclawInstances.stats({ days: 7 });

    const [activeInstance, inactiveTrialStoppedInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          id: crypto.randomUUID(),
          user_id: regularUser.id,
          sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        },
        {
          id: crypto.randomUUID(),
          user_id: regularUser.id,
          sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
          inactive_trial_stopped_at: '2026-04-20T12:00:00.000Z',
        },
      ])
      .returning({
        id: kiloclaw_instances.id,
        inactive: kiloclaw_instances.inactive_trial_stopped_at,
      });

    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: regularUser.id,
        instance_id: activeInstance.id,
        plan: 'trial',
        status: 'trialing',
      },
      {
        user_id: regularUser.id,
        instance_id: inactiveTrialStoppedInstance.id,
        plan: 'trial',
        status: 'trialing',
      },
    ]);

    const activeList = await caller.admin.kiloclawInstances.list({
      offset: 0,
      limit: 20,
      sortBy: 'created_at',
      sortOrder: 'desc',
      status: 'active',
    });
    expect(activeList.instances.map(instance => instance.id)).toContain(activeInstance.id);
    expect(activeList.instances.map(instance => instance.id)).not.toContain(
      inactiveTrialStoppedInstance.id
    );

    const inactiveList = await caller.admin.kiloclawInstances.list({
      offset: 0,
      limit: 20,
      sortBy: 'created_at',
      sortOrder: 'desc',
      status: 'inactive_trial_stopped',
    });
    expect(inactiveList.instances).toHaveLength(1);
    expect(inactiveList.instances[0]).toMatchObject({
      id: inactiveTrialStoppedInstance.id,
      lifecycle_state: 'inactive_trial_stopped',
    });
    expect(
      new Date(String(inactiveList.instances[0].inactive_trial_stopped_at)).toISOString()
    ).toBe('2026-04-20T12:00:00.000Z');

    const stats = await caller.admin.kiloclawInstances.stats({ days: 7 });
    expect(stats.overview.activeInstances).toBe(baselineStats.overview.activeInstances + 1);
    expect(stats.overview.inactiveTrialStoppedInstances).toBe(
      baselineStats.overview.inactiveTrialStoppedInstances + 1
    );
  });
});

describe('admin.kiloclawInstances.machineStart', () => {
  it('clears the inactivity marker after an admin start on a personal trial instance', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        inactive_trial_stopped_at: '2026-04-20T12:00:00.000Z',
      })
      .returning({ id: kiloclaw_instances.id });

    await db.insert(kiloclaw_subscriptions).values({
      user_id: regularUser.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.machineStart({
      userId: regularUser.id,
      instanceId: instance.id,
    });

    expect(result).toEqual(startedResponse);
    expect(mockStart).toHaveBeenCalledWith(regularUser.id, instance.id, {
      skipCooldown: true,
      reason: 'admin_request',
    });

    const updatedInstance = await db.query.kiloclaw_instances.findFirst({
      where: eq(kiloclaw_instances.id, instance.id),
    });
    expect(updatedInstance?.inactive_trial_stopped_at).toBeNull();
  });

  it('does not clear the inactivity marker when admin start is a no-op', async () => {
    mockStart.mockResolvedValueOnce({
      ok: true,
      started: false,
      previousStatus: 'stopped',
      currentStatus: 'stopped',
      startedAt: null,
    });

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        inactive_trial_stopped_at: '2026-04-20T12:00:00.000Z',
      })
      .returning({ id: kiloclaw_instances.id });

    await db.insert(kiloclaw_subscriptions).values({
      user_id: regularUser.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.machineStart({
      userId: regularUser.id,
      instanceId: instance.id,
    });

    expect(result).toEqual({
      ok: true,
      started: false,
      previousStatus: 'stopped',
      currentStatus: 'stopped',
      startedAt: null,
    });

    const updatedInstance = await db.query.kiloclaw_instances.findFirst({
      where: eq(kiloclaw_instances.id, instance.id),
    });
    expect(new Date(String(updatedInstance?.inactive_trial_stopped_at)).toISOString()).toBe(
      '2026-04-20T12:00:00.000Z'
    );
  });
});

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
    mockGetDebugStatus.mockResolvedValue(flyDebugStatus());
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
    mockGetDebugStatus.mockResolvedValue(flyDebugStatus({ flyAppName: 'acct-different' }));

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
    mockGetDebugStatus.mockResolvedValue(flyDebugStatus({ flyMachineId: 'differentmachineid' }));

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
    mockGetDebugStatus.mockResolvedValue(flyDebugStatus());
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
    mockGetDebugStatus.mockResolvedValue(flyDebugStatus());
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

    mockGetDebugStatus.mockResolvedValue(flyDebugStatus());
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

describe('admin.kiloclawInstances.startKiloCliRun', () => {
  it('rejects an instance that belongs to a different user', async () => {
    const targetUser = await insertTestUser({
      google_user_email: `admin-cli-run-target-${Math.random()}@example.com`,
      is_admin: false,
    });
    const otherUser = await insertTestUser({
      google_user_email: `admin-cli-run-other-${Math.random()}@example.com`,
      is_admin: false,
    });
    const instanceId = crypto.randomUUID();

    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: targetUser.id,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
    });

    try {
      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawInstances.startKiloCliRun({
          userId: otherUser.id,
          instanceId,
          prompt: 'test prompt',
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Instance not found',
      });

      expect(mockStartKiloCliRun).not.toHaveBeenCalled();
    } finally {
      await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, instanceId));
    }
  });

  it('maps a missing active instance to tRPC NOT_FOUND', async () => {
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: '2026-04-08T12:02:00.000Z' })
      .where(eq(kiloclaw_instances.id, cliRunInstanceId));

    const caller = await createCallerForUser(adminUser.id);
    try {
      await caller.admin.kiloclawInstances.startKiloCliRun({
        userId: cliRunUser.id,
        prompt: 'test prompt',
      });
      throw new Error('Expected startKiloCliRun to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      if (!(err instanceof TRPCError)) throw err;
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('Instance not found');
      expect(err.cause).toBeInstanceOf(UpstreamApiError);
      if (!(err.cause instanceof UpstreamApiError)) throw err;
      expect(err.cause.upstreamCode).toBe('instance_not_found');
    }

    expect(mockStartKiloCliRun).not.toHaveBeenCalled();
  });

  it('maps worker 409 to tRPC CONFLICT', async () => {
    const { KiloClawApiError } = jest.requireMock<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      KiloClawApiError: new (statusCode: number, responseBody: string) => any;
    }>('@/lib/kiloclaw/kiloclaw-internal-client');

    mockStartKiloCliRun.mockRejectedValue(
      new KiloClawApiError(
        409,
        JSON.stringify({ error: 'A CLI run is already in progress', code: 'cli_run_in_progress' })
      )
    );

    const caller = await createCallerForUser(adminUser.id);
    try {
      await caller.admin.kiloclawInstances.startKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        prompt: 'test prompt',
      });
      throw new Error('Expected startKiloCliRun to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      if (!(err instanceof TRPCError)) throw err;
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toBe('A CLI run is already in progress');
      expect(err.cause).toBeInstanceOf(UpstreamApiError);
      if (!(err.cause instanceof UpstreamApiError)) throw err;
      expect(err.cause.upstreamCode).toBe('cli_run_in_progress');
    }
  });

  it('maps controller_route_unavailable to PRECONDITION_FAILED', async () => {
    const { KiloClawApiError } = jest.requireMock<{
      KiloClawApiError: new (statusCode: number, responseBody: string) => Error;
    }>('@/lib/kiloclaw/kiloclaw-internal-client');

    mockStartKiloCliRun.mockRejectedValue(
      new KiloClawApiError(
        404,
        JSON.stringify({ error: 'Route not found', code: 'controller_route_unavailable' })
      )
    );

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.startKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Instance needs redeploy to support recovery',
    });

    try {
      await caller.admin.kiloclawInstances.startKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        prompt: 'test prompt',
      });
      throw new Error('Expected startKiloCliRun to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      if (!(err instanceof TRPCError)) throw err;
      expect(err.cause).toBeInstanceOf(UpstreamApiError);
      if (!(err.cause instanceof UpstreamApiError)) throw err;
      expect(err.cause.upstreamCode).toBe('controller_route_unavailable');
    }
  });

  it('creates a running row with admin attribution and writes start audit metadata on success', async () => {
    mockStartKiloCliRun.mockResolvedValue({
      startedAt: '2026-04-08T12:10:00.000Z',
      status: 'running',
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.startKiloCliRun({
      userId: cliRunUser.id,
      instanceId: cliRunInstanceId,
      prompt: 'new admin run',
    });

    expect(result).toMatchObject({
      id: expect.any(String),
      startedAt: '2026-04-08T12:10:00.000Z',
      status: 'running',
    });

    const [row] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, result.id));

    expect(row).toMatchObject({
      user_id: cliRunUser.id,
      instance_id: cliRunInstanceId,
      initiated_by_admin_id: adminUser.id,
      prompt: 'new admin run',
      status: 'running',
      started_at: '2026-04-08 12:10:00+00',
      completed_at: null,
      output: null,
      exit_code: null,
    });

    const logs = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        and(
          eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
          eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.cli_run.start')
        )
      );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.target_user_id).toBe(cliRunUser.id);
    expect(logs[0]?.metadata).toEqual({
      runId: result.id,
      instanceId: cliRunInstanceId,
      promptLength: 'new admin run'.length,
    });

    await db.delete(kiloclaw_cli_runs).where(eq(kiloclaw_cli_runs.id, result.id));
  });

  it('maps worker 409 with empty body to CONFLICT with fallback message', async () => {
    const { KiloClawApiError } = jest.requireMock<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      KiloClawApiError: new (statusCode: number, responseBody: string) => any;
    }>('@/lib/kiloclaw/kiloclaw-internal-client');

    mockStartKiloCliRun.mockRejectedValue(new KiloClawApiError(409, ''));

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.startKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Failed to start kilo CLI run',
    });
  });
});

describe('admin.kiloclawInstances.getKiloCliRunStatus', () => {
  it('marks a running DB row failed when controller status belongs to a newer run', async () => {
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

    expect(result.status).toBe('failed');
    expect(result.output).toContain('controller has moved on to a newer run');
    expect(result.completedAt).not.toBeNull();

    const [row] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, cliRunId));

    expect(row.status).toBe('failed');
    expect(row.output).toContain('controller has moved on to a newer run');
    expect(row.completed_at).not.toBeNull();
  });

  it('marks a running DB row failed when the controller no longer has the run', async () => {
    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: false,
      status: null,
      output: null,
      exitCode: null,
      startedAt: null,
      completedAt: null,
      prompt: null,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.getKiloCliRunStatus({
      userId: cliRunUser.id,
      instanceId: cliRunInstanceId,
      runId: cliRunId,
    });

    expect(result.status).toBe('failed');
    expect(result.output).toContain('controller no longer has an active CLI run');
    expect(result.completedAt).not.toBeNull();

    const [row] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, cliRunId));

    expect(row.status).toBe('failed');
    expect(row.output).toContain('controller no longer has an active CLI run');
    expect(row.completed_at).not.toBeNull();
  });

  it('lists the initiating admin email for admin-started runs', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.listAllCliRuns({
      offset: 0,
      limit: 10,
      initiatedBy: 'admin',
      status: 'all',
    });

    const run = result.runs.find(row => row.id === cliRunId);

    expect(run?.initiated_by_admin_id).toBe(adminUser.id);
    expect(run?.initiated_by_admin_email).toBe(adminUser.google_user_email);
    expect(run).not.toHaveProperty('initiated_by_admin_name');
  });

  it('returns the instance_id on each run', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.listAllCliRuns({
      offset: 0,
      limit: 10,
      initiatedBy: 'all',
      status: 'all',
    });

    const run = result.runs.find(row => row.id === cliRunId);
    expect(run?.instance_id).toBe(cliRunInstanceId);
  });

  it('finds runs when searching by full instance_id', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.listAllCliRuns({
      offset: 0,
      limit: 10,
      initiatedBy: 'all',
      status: 'all',
      search: cliRunInstanceId,
    });

    expect(result.runs.map(r => r.id)).toContain(cliRunId);
  });

  it('finds runs when searching by a substring of the instance_id', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const fragment = cliRunInstanceId.slice(0, 8);
    const result = await caller.admin.kiloclawInstances.listAllCliRuns({
      offset: 0,
      limit: 10,
      initiatedBy: 'all',
      status: 'all',
      search: fragment,
    });

    expect(result.runs.map(r => r.id)).toContain(cliRunId);
  });

  it('returns no runs when searching by an instance_id that does not match', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.listAllCliRuns({
      offset: 0,
      limit: 10,
      initiatedBy: 'all',
      status: 'all',
      search: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.runs.map(r => r.id)).not.toContain(cliRunId);
  });
});

describe('admin.kiloclawInstances.listKiloCliRuns', () => {
  it('scopes results to the given instanceId', async () => {
    // Create a second instance for the same user with its own CLI run
    const [otherInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: cliRunUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
      })
      .returning({ id: kiloclaw_instances.id });

    const [otherRun] = await db
      .insert(kiloclaw_cli_runs)
      .values({
        user_id: cliRunUser.id,
        instance_id: otherInstance.id,
        prompt: 'run on other instance',
        status: 'completed',
        started_at: '2026-04-08T13:00:00.000Z',
        completed_at: '2026-04-08T13:05:00.000Z',
        exit_code: 0,
        initiated_by_admin_id: null,
      })
      .returning({ id: kiloclaw_cli_runs.id });

    try {
      const caller = await createCallerForUser(adminUser.id);

      // Without instanceId — returns runs from both instances
      const allRuns = await caller.admin.kiloclawInstances.listKiloCliRuns({
        userId: cliRunUser.id,
      });
      const allIds = allRuns.runs.map(r => r.id);
      expect(allIds).toContain(cliRunId);
      expect(allIds).toContain(otherRun.id);

      // Scoped to the original instance — only its run
      const scopedOriginal = await caller.admin.kiloclawInstances.listKiloCliRuns({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
      });
      expect(scopedOriginal.runs.map(r => r.id)).toEqual([cliRunId]);

      // Scoped to the other instance — only its run
      const scopedOther = await caller.admin.kiloclawInstances.listKiloCliRuns({
        userId: cliRunUser.id,
        instanceId: otherInstance.id,
      });
      expect(scopedOther.runs.map(r => r.id)).toEqual([otherRun.id]);
    } finally {
      /* eslint-disable drizzle/enforce-delete-with-where */
      await db.delete(kiloclaw_cli_runs).where(eq(kiloclaw_cli_runs.id, otherRun.id));
      await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, otherInstance.id));
      /* eslint-enable drizzle/enforce-delete-with-where */
    }
  });
});

describe('admin.kiloclawInstances inbound email controls', () => {
  it('cycles the active alias and writes an audit log', async () => {
    const { instanceId, alias } = await insertInboundEmailInstance();
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.kiloclawInstances.cycleInboundEmailAddress({
      id: instanceId,
    });

    expect(result.inboundEmailAddress).toMatch(/@kiloclaw\.ai$/);
    expect(result.inboundEmailAddress).not.toBe(`${alias}@kiloclaw.ai`);

    const rows = await db
      .select()
      .from(kiloclaw_inbound_email_aliases)
      .where(eq(kiloclaw_inbound_email_aliases.instance_id, instanceId));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.alias === alias)?.retired_at).not.toBeNull();
    expect(rows.filter(row => row.retired_at === null)).toHaveLength(1);

    const logs = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        and(
          eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
          eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.inbound_email.cycle')
        )
      );
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toEqual({ instanceId });
  });

  it('disables inbound email and writes an audit log', async () => {
    const { instanceId } = await insertInboundEmailInstance();
    const caller = await createCallerForUser(adminUser.id);

    await caller.admin.kiloclawInstances.setInboundEmailEnabled({ id: instanceId, enabled: false });

    const [row] = await db
      .select({ inbound_email_enabled: kiloclaw_instances.inbound_email_enabled })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instanceId));
    expect(row?.inbound_email_enabled).toBe(false);

    const logs = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        and(
          eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
          eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.inbound_email.update_enabled')
        )
      );
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toEqual({ instanceId, enabled: false });
  });
});

describe('admin.kiloclawInstances.cancelKiloCliRun', () => {
  async function getCancelAuditLogs() {
    return db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        and(
          eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
          eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.cli_run.cancel')
        )
      );
  }

  it('throws before calling the controller when the scoped CLI run row does not exist', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.kiloclawInstances.cancelKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        runId: crypto.randomUUID(),
      })
    ).rejects.toThrow('CLI run not found');

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();
    await expect(getCancelAuditLogs()).resolves.toHaveLength(0);
  });

  it('falls back to the run row when an explicit instance is missing', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const missingInstanceId = crypto.randomUUID();
    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: null,
      exitCode: null,
      startedAt: '2026-04-08T12:00:00.000Z',
      completedAt: null,
      prompt: 'older admin-target run',
    });
    mockCancelKiloCliRun.mockResolvedValue({ ok: true });

    await expect(
      caller.admin.kiloclawInstances.cancelKiloCliRun({
        userId: cliRunUser.id,
        instanceId: missingInstanceId,
        runId: cliRunId,
      })
    ).resolves.toEqual({ ok: true });

    expect(mockCancelKiloCliRun).toHaveBeenCalledWith(cliRunUser.id, cliRunInstanceId);

    const [row] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, cliRunId));

    expect(row.status).toBe('cancelled');
    expect(row.completed_at).not.toBeNull();
  });

  it('throws before calling the controller when the run belongs to another instance', async () => {
    const [otherInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: cliRunUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
      })
      .returning({ id: kiloclaw_instances.id });

    const caller = await createCallerForUser(adminUser.id);

    try {
      await expect(
        caller.admin.kiloclawInstances.cancelKiloCliRun({
          userId: cliRunUser.id,
          instanceId: otherInstance.id,
          runId: cliRunId,
        })
      ).rejects.toThrow('CLI run not found');

      expect(mockCancelKiloCliRun).not.toHaveBeenCalled();
      await expect(getCancelAuditLogs()).resolves.toHaveLength(0);
    } finally {
      await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, otherInstance.id));
    }
  });

  it('returns ok without calling the controller when the run is already terminal', async () => {
    await db
      .update(kiloclaw_cli_runs)
      .set({
        status: 'completed',
        exit_code: 0,
        output: 'done',
        completed_at: '2026-04-08T12:01:00.000Z',
      })
      .where(eq(kiloclaw_cli_runs.id, cliRunId));

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.cancelKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        runId: cliRunId,
      })
    ).resolves.toEqual({ ok: true });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();
    await expect(getCancelAuditLogs()).resolves.toHaveLength(0);
  });

  it('does not write a cancel audit log when the controller cannot cancel the run', async () => {
    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: null,
      exitCode: null,
      startedAt: '2026-04-08T12:00:00.000Z',
      completedAt: null,
      prompt: 'older admin-target run',
    });
    mockCancelKiloCliRun.mockResolvedValue({ ok: false });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.cancelKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        runId: cliRunId,
      })
    ).resolves.toEqual({ ok: false });

    await expect(getCancelAuditLogs()).resolves.toHaveLength(0);
  });

  it('calls the controller, marks the row cancelled, and writes audit metadata for a running run', async () => {
    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: null,
      exitCode: null,
      startedAt: '2026-04-08T12:00:00.000Z',
      completedAt: null,
      prompt: 'older admin-target run',
    });
    mockCancelKiloCliRun.mockResolvedValue({ ok: true });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.cancelKiloCliRun({
        userId: cliRunUser.id,
        instanceId: cliRunInstanceId,
        runId: cliRunId,
      })
    ).resolves.toEqual({ ok: true });

    expect(mockCancelKiloCliRun).toHaveBeenCalledWith(cliRunUser.id, cliRunInstanceId);

    const [row] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, cliRunId));

    expect(row.status).toBe('cancelled');
    expect(row.completed_at).not.toBeNull();

    const logs = await getCancelAuditLogs();

    expect(logs).toHaveLength(1);
    expect(logs[0].target_user_id).toBe(cliRunUser.id);
    expect(logs[0].metadata).toEqual({
      instanceId: cliRunInstanceId,
      requestedInstanceId: cliRunInstanceId,
      usedFallback: false,
      runId: cliRunId,
    });
  });

  it('mirrors cancelCliRun fallback lookup and best-effort audit when explicit instance is gone', async () => {
    const [destroyedInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: cliRunUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        destroyed_at: '2026-04-08T12:02:00.000Z',
      })
      .returning({ id: kiloclaw_instances.id });

    const [staleRun] = await db
      .insert(kiloclaw_cli_runs)
      .values({
        user_id: cliRunUser.id,
        instance_id: destroyedInstance.id,
        prompt: 'stale destroyed-instance run',
        status: 'running',
        started_at: '2026-04-08T12:00:00.000Z',
        initiated_by_admin_id: adminUser.id,
      })
      .returning({ id: kiloclaw_cli_runs.id });

    try {
      mockGetKiloCliRunStatus.mockResolvedValue({
        hasRun: true,
        status: 'running',
        output: null,
        exitCode: null,
        startedAt: '2026-04-08T12:00:00.000Z',
        completedAt: null,
        prompt: 'stale destroyed-instance run',
      });
      mockCancelKiloCliRun.mockResolvedValue({ ok: true });

      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawInstances.cancelKiloCliRun({
          userId: cliRunUser.id,
          instanceId: destroyedInstance.id,
          runId: staleRun.id,
        })
      ).resolves.toEqual({ ok: true });

      expect(mockCancelKiloCliRun).toHaveBeenCalledWith(cliRunUser.id, destroyedInstance.id);

      const [row] = await db
        .select()
        .from(kiloclaw_cli_runs)
        .where(eq(kiloclaw_cli_runs.id, staleRun.id));

      expect(row.status).toBe('cancelled');
      expect(row.completed_at).not.toBeNull();

      const logs = await getCancelAuditLogs();

      expect(logs).toHaveLength(1);
      expect(logs[0].target_user_id).toBe(cliRunUser.id);
      expect(logs[0].message).toBe('CLI run cancelled');
      expect(logs[0].metadata).toEqual({
        instanceId: destroyedInstance.id,
        requestedInstanceId: destroyedInstance.id,
        usedFallback: true,
        runId: staleRun.id,
      });
    } finally {
      /* eslint-disable drizzle/enforce-delete-with-where */
      await db.delete(kiloclaw_cli_runs).where(eq(kiloclaw_cli_runs.id, staleRun.id));
      await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, destroyedInstance.id));
      /* eslint-enable drizzle/enforce-delete-with-where */
    }
  });
});

describe('admin.kiloclawInstances.restartMachine pin override gate', () => {
  // The pin row has an FK to kiloclaw_image_catalog.image_tag, so we
  // need real catalog rows for the pin inserts in these tests. The
  // restartMachine input regex (^[a-zA-Z0-9][a-zA-Z0-9._-]*$) rejects
  // slashes and colons, so we use docker-tag-style identifiers here even
  // though production catalog rows use full registry URLs.
  const newerTag = 'admin-pin-gate-newer';
  const olderTag = 'admin-pin-gate-older';
  let testInstanceId: string;

  beforeEach(async () => {
    await db.insert(kiloclaw_image_catalog).values([
      {
        openclaw_version: '2026.4.10',
        variant: 'default',
        image_tag: newerTag,
        image_digest: 'sha256:newer',
        status: 'available',
        published_at: new Date().toISOString(),
      },
      {
        openclaw_version: '2026.3.1',
        variant: 'default',
        image_tag: olderTag,
        image_digest: 'sha256:older',
        status: 'available',
        published_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      },
    ]);

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
      })
      .returning({ id: kiloclaw_instances.id });
    testInstanceId = instance.id;
  });

  afterEach(async () => {
    /* eslint-disable drizzle/enforce-delete-with-where */
    await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, testInstanceId));
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, testInstanceId));
    await db
      .delete(kiloclaw_image_catalog)
      .where(inArray(kiloclaw_image_catalog.image_tag, [newerTag, olderTag]));
    /* eslint-enable drizzle/enforce-delete-with-where */
  });

  it('throws FORBIDDEN for non-admin callers', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(
      caller.admin.kiloclawInstances.restartMachine({
        instanceId: testInstanceId,
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });

  it('plain restart with no imageTag ignores pin state and never triggers the gate', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: testInstanceId,
      image_tag: newerTag,
      pinned_by: regularUser.id,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.restartMachine({
      instanceId: testInstanceId,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });
    expect(mockUserClientRestartMachine).toHaveBeenCalledWith(undefined, expect.any(Object));

    // Pin must remain untouched on plain restart.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, testInstanceId));
    expect(pins.length).toBe(1);
  });

  it('version change with no pin succeeds without acknowledgeOverride', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.restartMachine({
      instanceId: testInstanceId,
      imageTag: newerTag,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });
    expect(mockUserClientRestartMachine).toHaveBeenCalledWith(
      { imageTag: newerTag },
      expect.any(Object)
    );
  });

  it('version change with user-set pin and no override throws PRECONDITION_FAILED', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: testInstanceId,
      image_tag: olderTag,
      pinned_by: regularUser.id,
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.restartMachine({
        instanceId: testInstanceId,
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'PIN_EXISTS',
    });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();

    // Pin remains in place after a blocked attempt.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, testInstanceId));
    expect(pins.length).toBe(1);
    expect(pins[0].pinned_by).toBe(regularUser.id);
  });

  it('version change with admin-set pin and no override throws PRECONDITION_FAILED', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: testInstanceId,
      image_tag: olderTag,
      pinned_by: adminUser.id,
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.restartMachine({
        instanceId: testInstanceId,
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'PIN_EXISTS',
    });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });

  it('version change with acknowledgeOverride deletes a user-set pin and proceeds', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: testInstanceId,
      image_tag: olderTag,
      pinned_by: regularUser.id,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.restartMachine({
      instanceId: testInstanceId,
      imageTag: newerTag,
      acknowledgeOverride: true,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });
    expect(mockUserClientRestartMachine).toHaveBeenCalledWith(
      { imageTag: newerTag },
      expect.any(Object)
    );

    // Pin row removed; no replacement admin pin written.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, testInstanceId));
    expect(pins.length).toBe(0);
  });

  it('version change with acknowledgeOverride deletes an admin-set pin and proceeds', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: testInstanceId,
      image_tag: olderTag,
      pinned_by: adminUser.id,
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.restartMachine({
      instanceId: testInstanceId,
      imageTag: newerTag,
      acknowledgeOverride: true,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });

    // Pin row removed; the override path strips any pin regardless of pinned_by.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, testInstanceId));
    expect(pins.length).toBe(0);
  });

  it('is direction-agnostic — older imageTag works the same as newer', async () => {
    // No pin: admin can switch to an older tag without override.
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.restartMachine({
      instanceId: testInstanceId,
      imageTag: olderTag,
    });

    expect(result).toEqual({ success: true, message: 'restarting' });
    expect(mockUserClientRestartMachine).toHaveBeenCalledWith(
      { imageTag: olderTag },
      expect.any(Object)
    );
  });

  it('NOT_FOUND when instance does not exist', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.restartMachine({
        instanceId: crypto.randomUUID(),
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });
});
