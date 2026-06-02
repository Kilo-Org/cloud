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
  kiloclaw_scheduled_actions,
  kiloclaw_scheduled_action_notifications,
  kiloclaw_scheduled_action_stages,
  kiloclaw_scheduled_action_targets,
  kiloclaw_subscriptions,
  kiloclaw_version_pins,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { UpstreamApiError } from '@/lib/trpc/init';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetDebugStatus: jest.Mock<any, any> = jest.fn();
const mockDestroyFlyMachine: jest.Mock<any, any> = jest.fn();
const mockDestroyOrphanVolume: jest.Mock<any, any> = jest.fn();
const mockScanOrphanVolumes: jest.Mock<any, any> = jest.fn();
const mockGetKiloCliRunStatus: jest.Mock<any, any> = jest.fn();
const mockCancelKiloCliRun: jest.Mock<any, any> = jest.fn();
const mockStartKiloCliRun: jest.Mock<any, any> = jest.fn();
const mockStart: jest.Mock<any, any> = jest.fn();
const mockUserClientRestartMachine: jest.Mock<any, any> = jest.fn();
const mockWakeScheduledAction: jest.Mock<any, any> = jest.fn();
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
    destroyOrphanVolume: mockDestroyOrphanVolume,
    scanOrphanVolumes: mockScanOrphanVolumes,
    getKiloCliRunStatus: mockGetKiloCliRunStatus,
    cancelKiloCliRun: mockCancelKiloCliRun,
    startKiloCliRun: mockStartKiloCliRun,
    start: mockStart,
    wakeScheduledAction: mockWakeScheduledAction,
  }));
}

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    getDebugStatus: mockGetDebugStatus,
    destroyFlyMachine: mockDestroyFlyMachine,
    destroyOrphanVolume: mockDestroyOrphanVolume,
    scanOrphanVolumes: mockScanOrphanVolumes,
    getKiloCliRunStatus: mockGetKiloCliRunStatus,
    cancelKiloCliRun: mockCancelKiloCliRun,
    startKiloCliRun: mockStartKiloCliRun,
    start: mockStart,
    wakeScheduledAction: mockWakeScheduledAction,
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
  mockDestroyOrphanVolume.mockReset();
  mockScanOrphanVolumes.mockReset();
  mockGetKiloCliRunStatus.mockReset();
  mockCancelKiloCliRun.mockReset();
  mockStartKiloCliRun.mockReset();
  mockStart.mockReset();
  mockStart.mockResolvedValue(startedResponse);
  mockUserClientRestartMachine.mockReset();
  mockUserClientRestartMachine.mockResolvedValue({ success: true, message: 'restarting' });
  mockWakeScheduledAction.mockReset();
  mockWakeScheduledAction.mockResolvedValue({ ok: true });
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

describe('admin.kiloclawInstances.extendVolume', () => {
  it('rejects when instanceId belongs to a different user than the supplied userId', async () => {
    // Regression: resolveInstance(userId, instanceId) looks up by id only —
    // without the ownership assert, an admin passing userId=A + instanceId=B
    // (B owned by user C) would extend C's volume while the audit log
    // attributed it to A. Fly volumes can't shrink, so the consequence is
    // permanent + misattributed. Mirrors the same guard on resizeMachine /
    // set/clear admin size override.
    const targetUser = await insertTestUser({
      google_user_email: `extend-volume-target-${Math.random()}@example.com`,
      is_admin: false,
    });
    const otherUser = await insertTestUser({
      google_user_email: `extend-volume-other-${Math.random()}@example.com`,
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
        caller.admin.kiloclawInstances.extendVolume({
          userId: otherUser.id,
          instanceId,
          appName: testAppName,
          volumeId: 'vol_test123',
          targetSizeGb: 20,
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Instance not found',
      });

      // The Fly extend should never have been attempted — guard runs first.
      expect(mockGetDebugStatus).not.toHaveBeenCalled();
    } finally {
      await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, instanceId));
    }
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

describe('admin.kiloclawInstances.bulkChangeVersion', () => {
  const newerTag = 'admin-bulk-change-newer';
  const olderTag = 'admin-bulk-change-older';
  const disabledTag = 'admin-bulk-change-disabled';
  let secondAdmin: User;

  // Five fixture instances exercising every partition class. Names mirror
  // the partition reasons surfaced in the result.
  let unpinnedId: string;
  let userPinnedId: string;
  let adminPinnedId: string;
  let destroyedId: string;
  let alreadyOnTargetId: string;

  beforeEach(async () => {
    secondAdmin = await insertTestUser({
      google_user_email: `admin-bulk-secondary-${Math.random()}@admin.example.com`,
      is_admin: true,
    });

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
      {
        openclaw_version: '2026.2.1',
        variant: 'default',
        image_tag: disabledTag,
        image_digest: 'sha256:disabled',
        status: 'disabled',
        published_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      },
    ]);

    const insertInstance = async (
      ownerId: string,
      overrides: Partial<{ destroyed_at: string; tracked_image_tag: string | null }> = {}
    ): Promise<string> => {
      const id = crypto.randomUUID();
      await db.insert(kiloclaw_instances).values({
        id,
        user_id: ownerId,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        ...overrides,
      });
      return id;
    };

    unpinnedId = await insertInstance(regularUser.id, { tracked_image_tag: olderTag });
    userPinnedId = await insertInstance(regularUser.id, { tracked_image_tag: olderTag });
    adminPinnedId = await insertInstance(regularUser.id, { tracked_image_tag: olderTag });
    destroyedId = await insertInstance(regularUser.id, {
      tracked_image_tag: olderTag,
      destroyed_at: new Date().toISOString(),
    });
    alreadyOnTargetId = await insertInstance(regularUser.id, { tracked_image_tag: newerTag });

    await db.insert(kiloclaw_version_pins).values([
      { instance_id: userPinnedId, image_tag: olderTag, pinned_by: regularUser.id },
      { instance_id: adminPinnedId, image_tag: olderTag, pinned_by: secondAdmin.id },
    ]);
  });

  afterEach(async () => {
    /* eslint-disable drizzle/enforce-delete-with-where */
    const ids = [unpinnedId, userPinnedId, adminPinnedId, destroyedId, alreadyOnTargetId];
    await db.delete(kiloclaw_version_pins).where(inArray(kiloclaw_version_pins.instance_id, ids));
    await db.delete(kiloclaw_instances).where(inArray(kiloclaw_instances.id, ids));
    await db
      .delete(kiloclaw_image_catalog)
      .where(inArray(kiloclaw_image_catalog.image_tag, [newerTag, olderTag, disabledTag]));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, secondAdmin.id));
    /* eslint-enable drizzle/enforce-delete-with-where */
  });

  it('throws FORBIDDEN for non-admin callers', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(
      caller.admin.kiloclawInstances.bulkChangeVersion({
        instanceIds: [unpinnedId],
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });

  it('Zod rejects empty instanceIds', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.bulkChangeVersion({
        instanceIds: [],
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });

  it('Zod rejects more than 500 instanceIds', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
    await expect(
      caller.admin.kiloclawInstances.bulkChangeVersion({
        instanceIds: tooMany,
        imageTag: newerTag,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('Zod rejects malformed imageTag', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.bulkChangeVersion({
        instanceIds: [unpinnedId],
        imageTag: 'invalid/tag:with:colons',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });

  it('BAD_REQUEST when target tag is not in catalog', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.bulkChangeVersion({
        instanceIds: [unpinnedId],
        imageTag: 'never-published-tag',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });

  it('BAD_REQUEST when target tag is disabled', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.bulkChangeVersion({
        instanceIds: [unpinnedId],
        imageTag: disabledTag,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockUserClientRestartMachine).not.toHaveBeenCalled();
  });

  it('partitions a mixed batch correctly with overridePins=false', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.bulkChangeVersion({
      instanceIds: [unpinnedId, userPinnedId, adminPinnedId, destroyedId, alreadyOnTargetId],
      imageTag: newerTag,
    });

    expect(result.applied).toEqual([unpinnedId]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toHaveLength(4);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { instanceId: userPinnedId, reason: 'pinned_by_user' },
        { instanceId: adminPinnedId, reason: 'pinned_by_admin' },
        { instanceId: destroyedId, reason: 'destroyed' },
        { instanceId: alreadyOnTargetId, reason: 'already_on_target' },
      ])
    );

    expect(mockUserClientRestartMachine).toHaveBeenCalledTimes(1);
    expect(mockUserClientRestartMachine).toHaveBeenCalledWith(
      { imageTag: newerTag },
      expect.any(Object)
    );

    // Pins on user-pinned and admin-pinned instances must remain in place
    // when override is off.
    const remainingPins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(inArray(kiloclaw_version_pins.instance_id, [userPinnedId, adminPinnedId]));
    expect(remainingPins.length).toBe(2);
  });

  it('overridePins=true shifts user-pinned and admin-pinned into applied', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.bulkChangeVersion({
      instanceIds: [unpinnedId, userPinnedId, adminPinnedId, destroyedId, alreadyOnTargetId],
      imageTag: newerTag,
      overridePins: true,
    });

    expect(result.applied).toEqual(
      expect.arrayContaining([unpinnedId, userPinnedId, adminPinnedId])
    );
    expect(result.applied).toHaveLength(3);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { instanceId: destroyedId, reason: 'destroyed' },
        { instanceId: alreadyOnTargetId, reason: 'already_on_target' },
      ])
    );
    expect(result.skipped).toHaveLength(2);

    // Pins on user-pinned and admin-pinned instances are deleted; no
    // replacement admin pin written.
    const remainingPins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(inArray(kiloclaw_version_pins.instance_id, [userPinnedId, adminPinnedId]));
    expect(remainingPins.length).toBe(0);

    expect(mockUserClientRestartMachine).toHaveBeenCalledTimes(3);
  });

  it('per-instance worker failure does not abort siblings', async () => {
    mockUserClientRestartMachine
      .mockReset()
      .mockResolvedValueOnce({ success: true, message: 'restarting' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ success: true, message: 'restarting' });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.bulkChangeVersion({
      instanceIds: [unpinnedId, userPinnedId, adminPinnedId],
      imageTag: newerTag,
      overridePins: true,
    });

    // One of the three fails, the other two succeed. Order is not
    // guaranteed because the for-loop chunks 10 at a time and
    // Promise.allSettled doesn't preserve mock-call order across the batch.
    // Assert on counts and shapes rather than specific id-to-result mapping.
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('boom');
    expect(result.skipped).toEqual([]);
  });

  it('returns failed:not_found for instanceIds that do not exist', async () => {
    const ghostId = crypto.randomUUID();
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.bulkChangeVersion({
      instanceIds: [unpinnedId, ghostId],
      imageTag: newerTag,
    });

    expect(result.applied).toEqual([unpinnedId]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([{ instanceId: ghostId, error: 'not_found' }]);
  });

  it('plain happy path with a single unpinned instance', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.bulkChangeVersion({
      instanceIds: [unpinnedId],
      imageTag: newerTag,
    });

    expect(result).toEqual({
      applied: [unpinnedId],
      skipped: [],
      failed: [],
    });
  });

  it('writes an admin audit log capturing the bulk action', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await caller.admin.kiloclawInstances.bulkChangeVersion({
      instanceIds: [unpinnedId, userPinnedId],
      imageTag: newerTag,
      overridePins: false,
    });

    const logs = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        and(
          eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
          eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.instances.bulk_change_version')
        )
      );

    expect(logs).toHaveLength(1);
    expect(logs[0].actor_email).toBe(adminUser.google_user_email);
    expect(logs[0].target_user_id).toBe(adminUser.id); // multi-user action sentinels actor
    expect(logs[0].message).toContain(`tag=${newerTag}`);
    expect(logs[0].message).toContain('overridePins=false');
    expect(logs[0].metadata).toMatchObject({
      imageTag: newerTag,
      overridePins: false,
      appliedInstanceIds: [unpinnedId],
    });
    expect(logs[0].metadata).toHaveProperty('skipped');
    expect(logs[0].metadata).toHaveProperty('failed');
  });
});

describe('admin.kiloclawInstances scheduled actions', () => {
  let testInstanceId: string;
  const fleetCatalogTags: string[] = [];

  async function insertFleetCatalogEntry(params: {
    openclawVersion: string;
    imageTag?: string;
    status?: 'available' | 'disabled';
  }) {
    const imageTag = params.imageTag ?? `fleet-test-${crypto.randomUUID()}`;
    fleetCatalogTags.push(imageTag);
    await db.insert(kiloclaw_image_catalog).values({
      openclaw_version: params.openclawVersion,
      variant: 'default',
      image_tag: imageTag,
      image_digest: `sha256:${crypto.randomUUID()}`,
      status: params.status ?? 'available',
      published_at: new Date().toISOString(),
    });
    return imageTag;
  }

  async function insertFleetInstance(params: {
    trackedImageTag: string | null;
    userId?: string;
    pinned?: boolean;
    inactiveTrialStopped?: boolean;
    suspended?: boolean;
  }) {
    const instanceId = crypto.randomUUID();
    const userId = params.userId ?? regularUser.id;
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: userId,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
      tracked_image_tag: params.trackedImageTag,
      inactive_trial_stopped_at: params.inactiveTrialStopped ? '2026-04-20T12:00:00.000Z' : null,
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: userId,
      instance_id: instanceId,
      plan: 'trial',
      status: 'trialing',
      suspended_at: params.suspended ? '2026-04-20T12:00:00.000Z' : null,
    });
    if (params.pinned && params.trackedImageTag) {
      await db.insert(kiloclaw_version_pins).values({
        instance_id: instanceId,
        image_tag: params.trackedImageTag,
        pinned_by: userId,
      });
    }
    return instanceId;
  }

  beforeEach(async () => {
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
      .delete(kiloclaw_scheduled_action_targets)
      .where(eq(kiloclaw_scheduled_action_targets.instance_id, testInstanceId));
    // We deleted target rows above (by instance_id). Stages and parents
    // don't auto-delete from that — the FK from target.stage_id is ON
    // DELETE SET NULL, which nullifies the column on the target row, not
    // the other way around. Tear down stages and parents explicitly by
    // id so the test instance leaves no orphans.
    const parents = await db
      .select({ id: kiloclaw_scheduled_actions.id })
      .from(kiloclaw_scheduled_actions)
      .where(eq(kiloclaw_scheduled_actions.created_by, adminUser.id));
    if (parents.length > 0) {
      const ids = parents.map(p => p.id);
      await db
        .delete(kiloclaw_scheduled_action_stages)
        .where(inArray(kiloclaw_scheduled_action_stages.scheduled_action_id, ids));
      await db
        .delete(kiloclaw_scheduled_actions)
        .where(inArray(kiloclaw_scheduled_actions.id, ids));
    }
    if (fleetCatalogTags.length > 0) {
      await db
        .delete(kiloclaw_version_pins)
        .where(inArray(kiloclaw_version_pins.image_tag, [...fleetCatalogTags]));
      await db
        .delete(kiloclaw_image_catalog)
        .where(inArray(kiloclaw_image_catalog.image_tag, [...fleetCatalogTags]));
      fleetCatalogTags.length = 0;
    }
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, testInstanceId));
    /* eslint-enable drizzle/enforce-delete-with-where */
  });

  describe('scheduleAction', () => {
    it('throws FORBIDDEN for non-admin callers', async () => {
      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.admin.kiloclawInstances.scheduleAction({
          actionType: 'scheduled_restart',
          instanceIds: [testInstanceId],
          scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects scheduledAt within 1 minute of now', async () => {
      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawInstances.scheduleAction({
          actionType: 'scheduled_restart',
          instanceIds: [testInstanceId],
          // 30 seconds in the future — under the 1-minute floor.
          scheduledAt: new Date(Date.now() + 30_000).toISOString(),
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('1 minute'),
      });
    });

    it('rejects unknown instanceId with NOT_FOUND', async () => {
      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawInstances.scheduleAction({
          actionType: 'scheduled_restart',
          instanceIds: [crypto.randomUUID()],
          scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects scheduling on a destroyed instance', async () => {
      // Mark the test instance destroyed.
      await db
        .update(kiloclaw_instances)
        .set({ destroyed_at: new Date().toISOString() })
        .where(eq(kiloclaw_instances.id, testInstanceId));

      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawInstances.scheduleAction({
          actionType: 'scheduled_restart',
          instanceIds: [testInstanceId],
          scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('happy path creates parent + stage + target rows and writes audit log', async () => {
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId],
        scheduledAt,
        reason: 'e2e test',
      });

      expect(result.id).toBeDefined();
      expect(result.stageId).toBeDefined();

      const [parent] = await db
        .select()
        .from(kiloclaw_scheduled_actions)
        .where(eq(kiloclaw_scheduled_actions.id, result.id));
      expect(parent.action_type).toBe('scheduled_restart');
      expect(parent.status).toBe('scheduled');
      expect(parent.created_by).toBe(adminUser.id);
      expect(parent.total_count).toBe(1);
      expect(parent.reason).toBe('e2e test');

      const stages = await db
        .select()
        .from(kiloclaw_scheduled_action_stages)
        .where(eq(kiloclaw_scheduled_action_stages.scheduled_action_id, result.id));
      expect(stages).toHaveLength(1);
      expect(stages[0].stage_index).toBe(0);
      expect(stages[0].status).toBe('pending');

      const targets = await db
        .select()
        .from(kiloclaw_scheduled_action_targets)
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, result.id));
      expect(targets).toHaveLength(1);
      expect(targets[0].instance_id).toBe(testInstanceId);
      expect(targets[0].status).toBe('pending');
      expect(targets[0].user_id).toBe(regularUser.id);

      const logs = await db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(
          and(
            eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
            eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.scheduled_action.created')
          )
        );
      expect(logs).toHaveLength(1);
      expect(logs[0].metadata).toMatchObject({
        scheduledActionId: result.id,
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId],
      });
    });

    it('multi-instance happy path creates one parent + one stage + N targets', async () => {
      // Build a second instance owned by a different user.
      const secondUser = await insertTestUser();
      const [secondInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: secondUser.id,
          sandbox_id: `test-multi-schedule-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });

      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId, secondInstance.id],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const [parent] = await db
        .select()
        .from(kiloclaw_scheduled_actions)
        .where(eq(kiloclaw_scheduled_actions.id, result.id));
      expect(parent.total_count).toBe(2);

      const stages = await db
        .select()
        .from(kiloclaw_scheduled_action_stages)
        .where(eq(kiloclaw_scheduled_action_stages.scheduled_action_id, result.id));
      expect(stages).toHaveLength(1);

      const targets = await db
        .select()
        .from(kiloclaw_scheduled_action_targets)
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, result.id));
      expect(targets).toHaveLength(2);
      const targetInstanceIds = new Set(targets.map(t => t.instance_id));
      expect(targetInstanceIds).toEqual(new Set([testInstanceId, secondInstance.id]));
      // Each target is stamped with the right user_id.
      const userIdByInstance = new Map(targets.map(t => [t.instance_id, t.user_id]));
      expect(userIdByInstance.get(testInstanceId)).toBe(regularUser.id);
      expect(userIdByInstance.get(secondInstance.id)).toBe(secondUser.id);
    });

    it('silently filters destroyed instances from a bulk schedule', async () => {
      const [destroyedInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: regularUser.id,
          sandbox_id: `test-bulk-dead-${Date.now()}`,
          destroyed_at: new Date().toISOString(),
        })
        .returning({ id: kiloclaw_instances.id });

      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId, destroyedInstance.id],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      // Only the live instance becomes a target; total_count reflects
      // the post-filter size.
      const [parent] = await db
        .select()
        .from(kiloclaw_scheduled_actions)
        .where(eq(kiloclaw_scheduled_actions.id, result.id));
      expect(parent.total_count).toBe(1);

      const targets = await db
        .select()
        .from(kiloclaw_scheduled_action_targets)
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, result.id));
      expect(targets).toHaveLength(1);
      expect(targets[0].instance_id).toBe(testInstanceId);

      // Audit metadata captures what was filtered so the trail is
      // self-explanatory.
      const logs = await db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(
          and(
            eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
            eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.scheduled_action.created')
          )
        );
      expect(logs).toHaveLength(1);
      expect(logs[0].metadata).toMatchObject({
        instanceIds: [testInstanceId],
        filteredDestroyedInstanceIds: [destroyedInstance.id],
      });
    });

    it('rejects when every instance is destroyed (nothing to schedule)', async () => {
      const [destroyedInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: regularUser.id,
          sandbox_id: `test-all-dead-${Date.now()}`,
          destroyed_at: new Date().toISOString(),
        })
        .returning({ id: kiloclaw_instances.id });

      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawInstances.scheduleAction({
          actionType: 'scheduled_restart',
          instanceIds: [destroyedInstance.id],
          scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('destroyed'),
      });
    });

    it('rejects with CONFLICT when an instance already has a pending scheduled action', async () => {
      const caller = await createCallerForUser(adminUser.id);
      // First schedule succeeds.
      await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      // Second schedule on the same instance is rejected — we don't
      // support 1+N concurrent schedules per instance.
      await expect(
        caller.admin.kiloclawInstances.scheduleAction({
          actionType: 'scheduled_restart',
          instanceIds: [testInstanceId],
          scheduledAt: new Date(Date.now() + 120 * 60_000).toISOString(),
        })
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringMatching(/pending(?:.*in-flight)? scheduled action/),
      });
    });

    it('dedupes duplicate instanceIds in the input', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId, testInstanceId, testInstanceId],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      const targets = await db
        .select()
        .from(kiloclaw_scheduled_action_targets)
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, result.id));
      expect(targets).toHaveLength(1);
    });

    describe('version_change variant', () => {
      // Per-test tags so cross-test runs can't collide on the unique
      // image_tag constraint when an earlier test's catalog cleanup is
      // delayed by FK ordering.
      let availableTag: string;
      let disabledTag: string;

      beforeEach(async () => {
        availableTag = `vc-test-available-${crypto.randomUUID()}`;
        disabledTag = `vc-test-disabled-${crypto.randomUUID()}`;
        await db.insert(kiloclaw_image_catalog).values([
          {
            openclaw_version: '2026.1.1',
            variant: 'default',
            image_tag: availableTag,
            image_digest: 'sha256:vc-available',
            status: 'available',
            published_at: new Date().toISOString(),
          },
          {
            openclaw_version: '2026.0.1',
            variant: 'default',
            image_tag: disabledTag,
            image_digest: 'sha256:vc-disabled',
            status: 'disabled',
            published_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          },
        ]);
      });

      afterEach(async () => {
        /* eslint-disable drizzle/enforce-delete-with-where */
        // FK from kiloclaw_scheduled_actions.target_image_tag → catalog
        // is ON DELETE RESTRICT. Outer afterEach deletes parents but
        // runs after this inner one, so clear our parents first.
        const parents = await db
          .select({ id: kiloclaw_scheduled_actions.id })
          .from(kiloclaw_scheduled_actions)
          .where(inArray(kiloclaw_scheduled_actions.target_image_tag, [availableTag, disabledTag]));
        if (parents.length > 0) {
          const parentIds = parents.map(p => p.id);
          await db
            .delete(kiloclaw_scheduled_action_targets)
            .where(inArray(kiloclaw_scheduled_action_targets.scheduled_action_id, parentIds));
          await db
            .delete(kiloclaw_scheduled_action_stages)
            .where(inArray(kiloclaw_scheduled_action_stages.scheduled_action_id, parentIds));
          await db
            .delete(kiloclaw_scheduled_actions)
            .where(inArray(kiloclaw_scheduled_actions.id, parentIds));
        }
        await db
          .delete(kiloclaw_image_catalog)
          .where(inArray(kiloclaw_image_catalog.image_tag, [availableTag, disabledTag]));
        /* eslint-enable drizzle/enforce-delete-with-where */
      });

      it('happy path stamps target_image_tag + override_pins on parent and target', async () => {
        const caller = await createCallerForUser(adminUser.id);
        const result = await caller.admin.kiloclawInstances.scheduleAction({
          actionType: 'version_change',
          instanceIds: [testInstanceId],
          imageTag: availableTag,
          overridePins: true,
          scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        });

        const [parent] = await db
          .select()
          .from(kiloclaw_scheduled_actions)
          .where(eq(kiloclaw_scheduled_actions.id, result.id));
        expect(parent.action_type).toBe('version_change');
        expect(parent.target_image_tag).toBe(availableTag);
        expect(parent.override_pins).toBe(true);

        const [target] = await db
          .select()
          .from(kiloclaw_scheduled_action_targets)
          .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, result.id));
        // target_image_tag mirrored from the parent — DO apply path
        // reads the per-target column directly without re-joining.
        expect(target.target_image_tag).toBe(availableTag);
        expect(target.instance_id).toBe(testInstanceId);

        const logs = await db
          .select()
          .from(kiloclaw_admin_audit_logs)
          .where(
            and(
              eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
              eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.scheduled_action.created')
            )
          );
        expect(logs).toHaveLength(1);
        expect(logs[0].metadata).toMatchObject({
          actionType: 'version_change',
          imageTag: availableTag,
          overridePins: true,
        });
      });

      it('rejects unknown imageTag with BAD_REQUEST', async () => {
        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.admin.kiloclawInstances.scheduleAction({
            actionType: 'version_change',
            instanceIds: [testInstanceId],
            imageTag: 'totally-not-in-catalog',
            scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('not found'),
        });
      });

      it('rejects disabled imageTag with BAD_REQUEST', async () => {
        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.admin.kiloclawInstances.scheduleAction({
            actionType: 'version_change',
            instanceIds: [testInstanceId],
            imageTag: disabledTag,
            scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('disabled'),
        });
      });

      it('Zod rejects malformed imageTag (regex)', async () => {
        const caller = await createCallerForUser(adminUser.id);
        await expect(
          caller.admin.kiloclawInstances.scheduleAction({
            actionType: 'version_change',
            instanceIds: [testInstanceId],
            // Starts with a non-alphanumeric — fails the
            // /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ guard.
            imageTag: '-bad-tag',
            scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      });
    });
  });

  describe('listScheduledActions / getScheduledAction', () => {
    it('throws FORBIDDEN for non-admin callers (listScheduledActions)', async () => {
      const caller = await createCallerForUser(regularUser.id);
      await expect(caller.admin.kiloclawInstances.listScheduledActions({})).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('throws FORBIDDEN for non-admin callers (getScheduledAction)', async () => {
      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.admin.kiloclawInstances.getScheduledAction({ id: crypto.randomUUID() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('lists scheduled actions and getScheduledAction returns parent + stages + targets', async () => {
      const adminCaller = await createCallerForUser(adminUser.id);
      const created = await adminCaller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const list = await adminCaller.admin.kiloclawInstances.listScheduledActions({});
      expect(list.items.some(a => a.id === created.id)).toBe(true);
      expect(list.pagination.total).toBeGreaterThanOrEqual(1);

      const detail = await adminCaller.admin.kiloclawInstances.getScheduledAction({
        id: created.id,
      });
      expect(detail.action.id).toBe(created.id);
      expect(detail.stages).toHaveLength(1);
      expect(detail.targets).toHaveLength(1);
      expect(detail.targets[0].instance_id).toBe(testInstanceId);
    });
  });

  describe('fleet upgrade', () => {
    it('throws FORBIDDEN for non-admin preview callers', async () => {
      const targetTag = await insertFleetCatalogEntry({ openclawVersion: '2026.2.10' });
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.admin.kiloclawInstances.previewFleetUpgrade({
          versionBelow: '2026.2.10',
          targetImageTag: targetTag,
          overridePins: false,
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          tranchePercent: 50,
          intervalDays: 2,
          notify: false,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('previews eligibility buckets with numeric CalVer comparison', async () => {
      const oldTag = await insertFleetCatalogEntry({ openclawVersion: '2026.2.9' });
      const newerTag = await insertFleetCatalogEntry({ openclawVersion: '2026.2.10' });
      const targetTag = await insertFleetCatalogEntry({ openclawVersion: '2026.3.1' });
      const unknownTag = `fleet-missing-${crypto.randomUUID()}`;

      const actionableId = await insertFleetInstance({ trackedImageTag: oldTag });
      const pinnedId = await insertFleetInstance({ trackedImageTag: oldTag, pinned: true });
      const conflictId = await insertFleetInstance({ trackedImageTag: oldTag });
      await insertFleetInstance({ trackedImageTag: newerTag });
      await insertFleetInstance({ trackedImageTag: targetTag });
      await insertFleetInstance({ trackedImageTag: unknownTag });
      await insertFleetInstance({ trackedImageTag: null });

      const caller = await createCallerForUser(adminUser.id);
      await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [conflictId],
        scheduledAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        notify: false,
      });

      const preview = await caller.admin.kiloclawInstances.previewFleetUpgrade({
        versionBelow: '2026.2.10',
        targetImageTag: targetTag,
        overridePins: false,
        startsAt: new Date(Date.now() + 120 * 60_000).toISOString(),
        tranchePercent: 50,
        intervalDays: 2,
        notify: false,
      });

      expect(preview.counts).toMatchObject({
        eligible: 3,
        actionable: 1,
        pinned: 1,
        conflicts: 1,
        alreadyOnTarget: 1,
        unknownVersion: 2,
      });
      expect(preview.actionableInstanceIds).toEqual([actionableId]);
      expect(preview.excluded.pinnedInstanceIds).toEqual([pinnedId]);
      expect(preview.excluded.conflictInstanceIds).toEqual([conflictId]);
      expect(preview.stages).toHaveLength(1);
      expect(preview.stages[0]).toMatchObject({ stageIndex: 0, targetCount: 1 });
    });

    it('creates one version-change parent split across deterministic stages', async () => {
      const oldTag = await insertFleetCatalogEntry({ openclawVersion: '2026.2.1' });
      const targetTag = await insertFleetCatalogEntry({ openclawVersion: '2026.3.1' });
      const instanceIds = await Promise.all(
        Array.from({ length: 5 }, () => insertFleetInstance({ trackedImageTag: oldTag }))
      );
      const startsAt = new Date(Date.now() + 120 * 60_000).toISOString();

      const caller = await createCallerForUser(adminUser.id);
      const created = await caller.admin.kiloclawInstances.createFleetUpgrade({
        versionBelow: '2026.2.10',
        targetImageTag: targetTag,
        overridePins: true,
        startsAt,
        tranchePercent: 40,
        intervalDays: 3,
        reason: 'fleet rollout test',
        notify: true,
        noticeLeadHours: 12,
        noticeSubject: 'Maintenance window',
        noticeBody: 'A version update is scheduled.',
        noticeChannels: ['email', 'webapp'],
      });

      expect(created.targetCount).toBe(5);
      expect(created.stageIds).toHaveLength(3);

      const [parent] = await db
        .select()
        .from(kiloclaw_scheduled_actions)
        .where(eq(kiloclaw_scheduled_actions.id, created.id));
      expect(parent).toMatchObject({
        action_type: 'version_change',
        target_image_tag: targetTag,
        override_pins: true,
        reason: 'fleet rollout test',
        total_count: 5,
        notice_lead_hours: 12,
        notice_subject: 'Maintenance window',
        notice_body: 'A version update is scheduled.',
      });

      const stages = await db
        .select()
        .from(kiloclaw_scheduled_action_stages)
        .where(eq(kiloclaw_scheduled_action_stages.scheduled_action_id, created.id));
      expect(stages.map(s => s.stage_index).sort()).toEqual([0, 1, 2]);
      expect(stages.map(s => new Date(s.scheduled_at).toISOString()).sort()).toEqual([
        new Date(startsAt).toISOString(),
        new Date(new Date(startsAt).getTime() + 3 * 86_400_000).toISOString(),
        new Date(new Date(startsAt).getTime() + 6 * 86_400_000).toISOString(),
      ]);

      const targets = await db
        .select()
        .from(kiloclaw_scheduled_action_targets)
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, created.id));
      expect(targets).toHaveLength(5);
      expect(new Set(targets.map(t => t.instance_id))).toEqual(new Set(instanceIds));
      expect(new Set(targets.map(t => t.target_image_tag))).toEqual(new Set([targetTag]));

      const stageSizes = new Map(stages.map(stage => [stage.id, 0]));
      for (const target of targets) {
        stageSizes.set(target.stage_id ?? '', (stageSizes.get(target.stage_id ?? '') ?? 0) + 1);
      }
      expect(Array.from(stageSizes.values()).sort()).toEqual([1, 2, 2]);

      const notices = await db
        .select()
        .from(kiloclaw_scheduled_action_notifications)
        .innerJoin(
          kiloclaw_scheduled_action_targets,
          eq(
            kiloclaw_scheduled_action_targets.id,
            kiloclaw_scheduled_action_notifications.target_id
          )
        )
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, created.id));
      expect(notices).toHaveLength(10);

      const logs = await db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(
          and(
            eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
            eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.fleet_upgrade.created')
          )
        );
      expect(logs).toHaveLength(1);
      expect(logs[0].metadata).toMatchObject({
        scheduledActionId: created.id,
        versionBelow: '2026.2.10',
        targetImageTag: targetTag,
        tranchePercent: 40,
        intervalDays: 3,
        targetCount: 5,
        stageSizes: [2, 2, 1],
      });

      const list = await caller.admin.kiloclawInstances.listScheduledActions({});
      const row = list.items.find(item => item.id === created.id);
      expect(row).toMatchObject({
        target_count: 5,
        stage_count: 3,
        latest_scheduled_at: expect.any(String),
      });

      const detail = await caller.admin.kiloclawInstances.getScheduledAction({ id: created.id });
      expect(detail.stages).toHaveLength(3);
      expect(detail.targets.map(target => target.stage_index).sort()).toEqual([0, 0, 1, 1, 2]);
    });

    it('rejects create when an actionable target has a pending scheduled action', async () => {
      const oldTag = await insertFleetCatalogEntry({ openclawVersion: '2026.2.1' });
      const targetTag = await insertFleetCatalogEntry({ openclawVersion: '2026.3.1' });
      const instanceId = await insertFleetInstance({ trackedImageTag: oldTag });
      const caller = await createCallerForUser(adminUser.id);
      await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [instanceId],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        notify: false,
      });

      await expect(
        caller.admin.kiloclawInstances.createFleetUpgrade({
          versionBelow: '2026.2.10',
          targetImageTag: targetTag,
          overridePins: false,
          startsAt: new Date(Date.now() + 120 * 60_000).toISOString(),
          tranchePercent: 50,
          intervalDays: 2,
          notify: false,
        })
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('pending or in-flight scheduled actions'),
      });
    });
  });

  describe('cancelScheduledAction', () => {
    it('throws FORBIDDEN for non-admin callers', async () => {
      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.admin.kiloclawInstances.cancelScheduledAction({ id: crypto.randomUUID() })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('throws NOT_FOUND for an unknown id', async () => {
      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawInstances.cancelScheduledAction({ id: crypto.randomUUID() })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('cancels a scheduled action and marks pending stages + targets cancelled', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const created = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const result = await caller.admin.kiloclawInstances.cancelScheduledAction({
        id: created.id,
      });
      expect(result).toEqual({ cancelled: true, status: 'cancelled' });

      const [parent] = await db
        .select()
        .from(kiloclaw_scheduled_actions)
        .where(eq(kiloclaw_scheduled_actions.id, created.id));
      expect(parent.status).toBe('cancelled');
      expect(parent.cancelled_at).not.toBeNull();

      const stages = await db
        .select()
        .from(kiloclaw_scheduled_action_stages)
        .where(eq(kiloclaw_scheduled_action_stages.scheduled_action_id, created.id));
      expect(stages.every(s => s.status === 'cancelled')).toBe(true);

      const targets = await db
        .select()
        .from(kiloclaw_scheduled_action_targets)
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, created.id));
      expect(targets.every(t => t.status === 'skipped' && t.skip_reason === 'cancelled')).toBe(
        true
      );

      const logs = await db
        .select()
        .from(kiloclaw_admin_audit_logs)
        .where(
          and(
            eq(kiloclaw_admin_audit_logs.actor_id, adminUser.id),
            eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.scheduled_action.cancelled')
          )
        );
      expect(logs).toHaveLength(1);
    });

    it('returns no-op when called twice (idempotent)', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const created = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const first = await caller.admin.kiloclawInstances.cancelScheduledAction({
        id: created.id,
      });
      expect(first).toEqual({ cancelled: true, status: 'cancelled' });

      const second = await caller.admin.kiloclawInstances.cancelScheduledAction({
        id: created.id,
      });
      expect(second.cancelled).toBe(false);
      expect(second.status).toBe('cancelled');
    });

    it('voids pending notice rows so the sweep does not deliver after cancel', async () => {
      // scheduleAction with default notify=true queues 3 pending notice
      // rows (email, webapp, mobile_push) per target. After cancel,
      // those rows must transition to 'failed' so selectDueNotifications
      // never picks them up again.
      const caller = await createCallerForUser(adminUser.id);
      const created = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const beforeCancel = await db
        .select()
        .from(kiloclaw_scheduled_action_notifications)
        .innerJoin(
          kiloclaw_scheduled_action_targets,
          eq(
            kiloclaw_scheduled_action_targets.id,
            kiloclaw_scheduled_action_notifications.target_id
          )
        )
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, created.id));
      expect(beforeCancel.length).toBeGreaterThan(0);
      expect(
        beforeCancel.every(
          row =>
            row.kiloclaw_scheduled_action_notifications.kind === 'notice' &&
            row.kiloclaw_scheduled_action_notifications.status === 'pending'
        )
      ).toBe(true);

      await caller.admin.kiloclawInstances.cancelScheduledAction({ id: created.id });

      const afterCancel = await db
        .select()
        .from(kiloclaw_scheduled_action_notifications)
        .innerJoin(
          kiloclaw_scheduled_action_targets,
          eq(
            kiloclaw_scheduled_action_targets.id,
            kiloclaw_scheduled_action_notifications.target_id
          )
        )
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, created.id));
      const noticeRows = afterCancel
        .map(row => row.kiloclaw_scheduled_action_notifications)
        .filter(n => n.kind === 'notice');
      expect(noticeRows.length).toBe(beforeCancel.length);
      expect(noticeRows.every(n => n.status === 'failed')).toBe(true);
      expect(
        noticeRows.every(n => n.error_message === 'action cancelled before notice was dispatched')
      ).toBe(true);
    });
  });

  describe('cancelScheduledActionTarget', () => {
    it('voids pending notice rows for only the cancelled target', async () => {
      // Two targets in one action; cancel one. Pending notice rows for
      // the cancelled target should transition to 'failed'; the other
      // target's notice rows should stay 'pending'.
      const secondUser = await insertTestUser();
      const [secondInstance] = await db
        .insert(kiloclaw_instances)
        .values({
          user_id: secondUser.id,
          sandbox_id: `test-cancel-target-${Date.now()}`,
        })
        .returning({ id: kiloclaw_instances.id });

      const caller = await createCallerForUser(adminUser.id);
      const created = await caller.admin.kiloclawInstances.scheduleAction({
        actionType: 'scheduled_restart',
        instanceIds: [testInstanceId, secondInstance.id],
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      await caller.admin.kiloclawInstances.cancelScheduledActionTarget({
        scheduledActionId: created.id,
        instanceId: testInstanceId,
      });

      const allNotices = await db
        .select({
          status: kiloclaw_scheduled_action_notifications.status,
          error_message: kiloclaw_scheduled_action_notifications.error_message,
          instance_id: kiloclaw_scheduled_action_targets.instance_id,
        })
        .from(kiloclaw_scheduled_action_notifications)
        .innerJoin(
          kiloclaw_scheduled_action_targets,
          eq(
            kiloclaw_scheduled_action_targets.id,
            kiloclaw_scheduled_action_notifications.target_id
          )
        )
        .where(eq(kiloclaw_scheduled_action_targets.scheduled_action_id, created.id));

      const cancelledTargetRows = allNotices.filter(n => n.instance_id === testInstanceId);
      const otherTargetRows = allNotices.filter(n => n.instance_id === secondInstance.id);

      expect(cancelledTargetRows.length).toBeGreaterThan(0);
      expect(cancelledTargetRows.every(n => n.status === 'failed')).toBe(true);

      expect(otherTargetRows.length).toBeGreaterThan(0);
      expect(otherTargetRows.every(n => n.status === 'pending')).toBe(true);
    });
  });
});

describe('admin.kiloclawInstances.findOrphanVolumes', () => {
  it('returns a cursor for continuing older capped scan batches', async () => {
    const destroyedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const instanceIds = Array.from(
      { length: 501 },
      (_, i) => `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`
    );
    await db.insert(kiloclaw_instances).values(
      instanceIds.map((id, i) => ({
        id,
        user_id: regularUser.id,
        sandbox_id: `ki_cursor_${i.toString().padStart(4, '0')}`,
        destroyed_at: destroyedAt,
      }))
    );

    mockScanOrphanVolumes.mockResolvedValue({
      flyApp: 'inst-cursor',
      appExists: true,
      expectedVolumeName: 'kiloclaw_cursor',
      doStatus: null,
      doStatusError: null,
      scanError: null,
      volumes: [],
    });

    const destroyedMs = Date.parse(destroyedAt);
    const caller = await createCallerForUser(adminUser.id);
    const firstBatch = await caller.admin.kiloclawInstances.findOrphanVolumes({
      destroyedAfter: new Date(destroyedMs - 60_000).toISOString(),
      destroyedBefore: new Date(destroyedMs + 60_000).toISOString(),
    });

    expect(firstBatch.scanned).toBe(500);
    expect(firstBatch.capped).toBe(true);
    expect(firstBatch.nextCursor).toEqual({
      destroyedAt,
      id: '00000000-0000-4000-8000-000000000001',
    });
    expect(mockScanOrphanVolumes).toHaveBeenCalledTimes(500);
    const firstBatchInstanceIds = new Set(
      mockScanOrphanVolumes.mock.calls.map(([, instanceId]) => instanceId)
    );

    mockScanOrphanVolumes.mockClear();
    const secondBatch = await caller.admin.kiloclawInstances.findOrphanVolumes({
      destroyedAfter: new Date(destroyedMs - 60_000).toISOString(),
      destroyedBefore: new Date(destroyedMs + 60_000).toISOString(),
      cursor: firstBatch.nextCursor ?? undefined,
    });

    expect(secondBatch.scanned).toBe(1);
    expect(secondBatch.capped).toBe(false);
    expect(secondBatch.nextCursor).toBeNull();
    expect(mockScanOrphanVolumes).toHaveBeenCalledTimes(1);
    expect(firstBatchInstanceIds.has(mockScanOrphanVolumes.mock.calls[0][1])).toBe(false);
  });

  it('runs the deduplicated scan query and returns classified volumes', async () => {
    // Regression: the dedup subquery becomes a derived table, so no two
    // projected columns may emit the same name. This exercises that query
    // against Postgres — a duplicate column makes the outer SELECT fail.
    const destroyedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const sandboxId = `ki_${crypto.randomUUID().replace(/-/g, '')}`;
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: sandboxId,
        destroyed_at: destroyedAt,
      })
      .returning({ id: kiloclaw_instances.id });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: regularUser.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'canceled',
    });

    mockScanOrphanVolumes.mockResolvedValue({
      flyApp: 'inst-findorphans',
      appExists: true,
      expectedVolumeName: 'kiloclaw_findorphans',
      doStatus: null,
      doStatusError: null,
      scanError: null,
      volumes: [
        {
          id: 'vol_findorphans00000',
          name: 'kiloclaw_findorphans',
          state: 'created',
          size_gb: 10,
          region: 'ord',
          attached_machine_id: null,
          created_at: '2026-04-01T00:00:00.000Z',
          nameMatchesInstance: true,
          trackedByLiveDo: false,
        },
      ],
    });

    // A narrow window around this instance's destruction so the result is
    // deterministic regardless of other rows in the test database.
    const destroyedMs = Date.parse(destroyedAt);
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.findOrphanVolumes({
      destroyedAfter: new Date(destroyedMs - 60_000).toISOString(),
      destroyedBefore: new Date(destroyedMs + 60_000).toISOString(),
    });

    expect(result.errors).toEqual([]);
    expect(result.scanned).toBe(1);
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toMatchObject({
      instance_id: instance.id,
      volume_id: 'vol_findorphans00000',
      subscription_status: 'canceled',
      classification: 'safe_destroy',
    });
  });

  it('scans production-shaped timestamp rows inside a narrow same-day ISO window', async () => {
    const destroyedAt = '2026-05-15 10:06:30.976+00';
    const sandboxId = `ki_${crypto.randomUUID().replace(/-/g, '')}`;
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: sandboxId,
        destroyed_at: destroyedAt,
      })
      .returning({ id: kiloclaw_instances.id });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: regularUser.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'canceled',
    });

    mockScanOrphanVolumes.mockResolvedValue({
      flyApp: 'inst-narrow-window',
      appExists: true,
      expectedVolumeName: 'kiloclaw_narrow_window',
      doStatus: null,
      doStatusError: null,
      scanError: null,
      volumes: [
        {
          id: 'vol_narrowwindow000',
          name: 'kiloclaw_narrow_window',
          state: 'created',
          size_gb: 10,
          region: 'ord',
          attached_machine_id: null,
          created_at: '2026-05-11T15:22:38.841Z',
          nameMatchesInstance: true,
          trackedByLiveDo: false,
        },
      ],
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.findOrphanVolumes({
      destroyedAfter: '2026-05-15T10:00:00.000Z',
      destroyedBefore: '2026-05-15T10:15:00.000Z',
    });

    expect(result.errors).toEqual([]);
    expect(result.scanned).toBe(1);
    expect(mockScanOrphanVolumes).toHaveBeenCalledWith(regularUser.id, instance.id, sandboxId);
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toMatchObject({
      instance_id: instance.id,
      volume_id: 'vol_narrowwindow000',
      classification: 'safe_destroy',
    });
  });

  it('scans an in-window destruction even when the same sandbox was destroyed later', async () => {
    const inWindowDestroyedAt = new Date(Date.now() - 10 * 86_400_000);
    const laterDestroyedAt = new Date(inWindowDestroyedAt.getTime() + 60_000);
    const sandboxId = `ki_${crypto.randomUUID().replace(/-/g, '')}`;
    const inWindowInstanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values([
      {
        id: inWindowInstanceId,
        user_id: regularUser.id,
        sandbox_id: sandboxId,
        destroyed_at: inWindowDestroyedAt.toISOString().replace('T', ' ').replace('Z', '+00'),
      },
      {
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: sandboxId,
        destroyed_at: laterDestroyedAt.toISOString().replace('T', ' ').replace('Z', '+00'),
      },
    ]);

    mockScanOrphanVolumes.mockResolvedValue({
      flyApp: 'inst-reprovisioned-window',
      appExists: true,
      expectedVolumeName: 'kiloclaw_reprovisioned_window',
      doStatus: null,
      doStatusError: null,
      scanError: null,
      volumes: [],
    });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.findOrphanVolumes({
      destroyedAfter: new Date(inWindowDestroyedAt.getTime() - 1_000).toISOString(),
      destroyedBefore: new Date(inWindowDestroyedAt.getTime() + 1_000).toISOString(),
    });

    expect(result.errors).toEqual([]);
    expect(result.scanned).toBe(1);
    expect(mockScanOrphanVolumes).toHaveBeenCalledWith(
      regularUser.id,
      inWindowInstanceId,
      sandboxId
    );
  });

  it('excludes volumes that are not confirmed orphans', async () => {
    const destroyedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        destroyed_at: destroyedAt,
      })
      .returning({ id: kiloclaw_instances.id });

    // The volume is still attached to a machine — not an orphan.
    mockScanOrphanVolumes.mockResolvedValue({
      flyApp: 'inst-attached',
      appExists: true,
      expectedVolumeName: 'kiloclaw_attached',
      doStatus: null,
      doStatusError: null,
      scanError: null,
      volumes: [
        {
          id: 'vol_attached00000000',
          name: 'kiloclaw_attached',
          state: 'attached',
          size_gb: 10,
          region: 'ord',
          attached_machine_id: 'm-still-here',
          created_at: '2026-04-01T00:00:00.000Z',
          nameMatchesInstance: true,
          trackedByLiveDo: false,
        },
      ],
    });

    const destroyedMs = Date.parse(destroyedAt);
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.findOrphanVolumes({
      destroyedAfter: new Date(destroyedMs - 60_000).toISOString(),
      destroyedBefore: new Date(destroyedMs + 60_000).toISOString(),
    });

    expect(result.scanned).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.volumes.some(v => v.instance_id === instance.id)).toBe(false);
  });

  it('reports instances whose Durable Object state could not be read', async () => {
    const destroyedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        destroyed_at: destroyedAt,
      })
      .returning({ id: kiloclaw_instances.id });

    mockScanOrphanVolumes.mockResolvedValue({
      flyApp: 'inst-dofail',
      appExists: true,
      expectedVolumeName: 'kiloclaw_dofail',
      doStatus: null,
      doStatusError: 'getDebugState failed',
      scanError: null,
      volumes: [],
    });

    const destroyedMs = Date.parse(destroyedAt);
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawInstances.findOrphanVolumes({
      destroyedAfter: new Date(destroyedMs - 60_000).toISOString(),
      destroyedBefore: new Date(destroyedMs + 60_000).toISOString(),
    });

    expect(result.volumes).toEqual([]);
    expect(result.errors.some(e => e.instance_id === instance.id)).toBe(true);
  });
});

describe('admin.kiloclawInstances.destroyOrphanVolume', () => {
  const VOLUME_ID = 'vol_orphantest00000';
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  async function insertDestroyedInstance(opts: {
    destroyedAt: string;
    subscriptionStatus?: 'active' | 'canceled' | 'trialing';
  }): Promise<string> {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        destroyed_at: opts.destroyedAt,
      })
      .returning({ id: kiloclaw_instances.id });
    if (opts.subscriptionStatus) {
      await db.insert(kiloclaw_subscriptions).values({
        user_id: regularUser.id,
        instance_id: instance.id,
        plan: 'trial',
        status: opts.subscriptionStatus,
      });
    }
    return instance.id;
  }

  it('rejects when the instance does not exist', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyOrphanVolume({
        instanceId: crypto.randomUUID(),
        volumeId: VOLUME_ID,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDestroyOrphanVolume).not.toHaveBeenCalled();
  });

  it('rejects when the instance is not destroyed', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
      })
      .returning({ id: kiloclaw_instances.id });
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyOrphanVolume({
        instanceId: instance.id,
        volumeId: VOLUME_ID,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDestroyOrphanVolume).not.toHaveBeenCalled();
  });

  it('rejects while the instance is within the 7-day grace period', async () => {
    const instanceId = await insertDestroyedInstance({ destroyedAt: daysAgo(2) });
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyOrphanVolume({ instanceId, volumeId: VOLUME_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDestroyOrphanVolume).not.toHaveBeenCalled();
  });

  it('rejects when a newer destruction of the same sandbox is within grace', async () => {
    // The submitted row was destroyed long ago, but the sandbox was
    // reprovisioned and destroyed again recently. Grace runs from the latest
    // destruction, so the older row must not reap the shared volume early.
    const sandboxId = `ki_${crypto.randomUUID().replace(/-/g, '')}`;
    const [oldInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: sandboxId,
        destroyed_at: daysAgo(30),
      })
      .returning({ id: kiloclaw_instances.id });
    await db.insert(kiloclaw_instances).values({
      id: crypto.randomUUID(),
      user_id: regularUser.id,
      sandbox_id: sandboxId,
      destroyed_at: daysAgo(2),
    });

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyOrphanVolume({
        instanceId: oldInstance.id,
        volumeId: VOLUME_ID,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDestroyOrphanVolume).not.toHaveBeenCalled();
  });

  it('clears the grace gate for a long-destroyed instance stored as Postgres timestamp text', async () => {
    // Regression: the grace check is evaluated in SQL, never by parsing the
    // stored timestamp with the JS `Date` constructor. A row destroyed 60
    // days ago — written in Postgres native timestamp text, not ISO 8601 —
    // must clear the 7-day grace gate and reach the destroy handoff.
    const destroyedAt = new Date(Date.now() - 60 * 86_400_000)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '+00');
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        destroyed_at: destroyedAt,
      })
      .returning({ id: kiloclaw_instances.id });
    mockDestroyOrphanVolume.mockResolvedValue({
      ok: true,
      flyApp: 'inst-grace',
      volumeId: VOLUME_ID,
      volumeName: 'kiloclaw_grace',
      alreadyGone: false,
    });
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.kiloclawInstances.destroyOrphanVolume({
      instanceId: instance.id,
      volumeId: VOLUME_ID,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockDestroyOrphanVolume).toHaveBeenCalledTimes(1);
  });

  it('measures grace per (user, sandbox), not across the entire table', async () => {
    // Regression: an earlier shape of the grace SQL used Drizzle's
    // `${kiloclaw_instances.user_id}` interpolation inside a `sql` template,
    // which Drizzle rendered as a BARE `"user_id"` (no table qualifier).
    // Postgres then resolved that bare reference to the inner aliased table
    // (most-local scope), collapsing the correlated subquery into a
    // trivially-true predicate and computing `max(destroyed_at)` over EVERY
    // destroyed row in the table. In production that maximum is almost
    // always recent, so the grace gate would fail closed for every destroy
    // regardless of the target's actual destruction time.
    //
    // This test seeds an unrelated user with a destroyed_at inside the last
    // 7 days alongside a 30-day-old target row. With a properly scoped
    // correlation the unrelated row is invisible to the target's grace
    // check; with the bug present, the destroy throws PRECONDITION_FAILED.
    const otherUser = await insertTestUser({
      google_user_email: `unrelated-recent-${Math.random()}@example.com`,
      is_admin: false,
    });
    // The outer afterEach only cleans `regularUser` / `adminUser` /
    // `cliRunUser`, so this unrelated user must be cleaned up explicitly. A
    // try/finally guarantees the cleanup runs even when an assertion in the
    // body throws — otherwise a failing run would leave the row in the table
    // and pollute subsequent tests.
    try {
      await db.insert(kiloclaw_instances).values({
        id: crypto.randomUUID(),
        user_id: otherUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
        destroyed_at: daysAgo(1),
      });
      const targetInstanceId = await insertDestroyedInstance({ destroyedAt: daysAgo(30) });
      mockDestroyOrphanVolume.mockResolvedValue({
        ok: true,
        flyApp: 'inst-scoped',
        volumeId: VOLUME_ID,
        volumeName: 'kiloclaw_scoped',
        alreadyGone: false,
      });
      const caller = await createCallerForUser(adminUser.id);

      const result = await caller.admin.kiloclawInstances.destroyOrphanVolume({
        instanceId: targetInstanceId,
        volumeId: VOLUME_ID,
      });

      expect(result).toMatchObject({ success: true });
      expect(mockDestroyOrphanVolume).toHaveBeenCalledTimes(1);
    } finally {
      await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.user_id, otherUser.id));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, otherUser.id));
    }
  });

  it('rejects when the user has an access-granting subscription', async () => {
    const instanceId = await insertDestroyedInstance({
      destroyedAt: daysAgo(30),
      subscriptionStatus: 'active',
    });
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.destroyOrphanVolume({ instanceId, volumeId: VOLUME_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDestroyOrphanVolume).not.toHaveBeenCalled();
  });

  it('rejects when an access-granting successor subscription replaced the destroyed instance row', async () => {
    const instanceId = await insertDestroyedInstance({ destroyedAt: daysAgo(30) });
    const [successorInstance] = await db
      .insert(kiloclaw_instances)
      .values({
        id: crypto.randomUUID(),
        user_id: regularUser.id,
        sandbox_id: `ki_${crypto.randomUUID().replace(/-/g, '')}`,
      })
      .returning({ id: kiloclaw_instances.id });
    const [successorSubscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: regularUser.id,
        instance_id: successorInstance.id,
        plan: 'trial',
        status: 'active',
      })
      .returning({ id: kiloclaw_subscriptions.id });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: regularUser.id,
      instance_id: instanceId,
      plan: 'trial',
      status: 'canceled',
      transferred_to_subscription_id: successorSubscription.id,
    });
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.kiloclawInstances.destroyOrphanVolume({ instanceId, volumeId: VOLUME_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDestroyOrphanVolume).not.toHaveBeenCalled();
  });

  it('destroys the volume for a long-destroyed instance with no subscription', async () => {
    mockDestroyOrphanVolume.mockResolvedValue({
      ok: true,
      flyApp: 'inst-abc',
      volumeId: VOLUME_ID,
      volumeName: 'kiloclaw_ki_test',
      alreadyGone: false,
    });
    const instanceId = await insertDestroyedInstance({ destroyedAt: daysAgo(30) });
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.kiloclawInstances.destroyOrphanVolume({
      instanceId,
      volumeId: VOLUME_ID,
    });

    expect(result).toMatchObject({ success: true, ok: true, volumeId: VOLUME_ID });
    expect(mockDestroyOrphanVolume).toHaveBeenCalledWith(
      regularUser.id,
      instanceId,
      expect.any(String),
      VOLUME_ID
    );
  });

  it('allows destroy when the subscription is canceled (positive guard case)', async () => {
    mockDestroyOrphanVolume.mockResolvedValue({
      ok: true,
      flyApp: 'inst-abc',
      volumeId: VOLUME_ID,
      volumeName: 'kiloclaw_ki_test',
      alreadyGone: false,
    });
    const instanceId = await insertDestroyedInstance({
      destroyedAt: daysAgo(30),
      subscriptionStatus: 'canceled',
    });
    const caller = await createCallerForUser(adminUser.id);

    const result = await caller.admin.kiloclawInstances.destroyOrphanVolume({
      instanceId,
      volumeId: VOLUME_ID,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockDestroyOrphanVolume).toHaveBeenCalledTimes(1);
  });
});
