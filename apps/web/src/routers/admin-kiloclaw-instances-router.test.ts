import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_admin_audit_logs,
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { UpstreamApiError } from '@/lib/trpc/init';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetDebugStatus: jest.Mock<any, any> = jest.fn();
const mockDestroyFlyMachine: jest.Mock<any, any> = jest.fn();
const mockStartKiloCliRun: jest.Mock<any, any> = jest.fn();

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    getDebugStatus: mockGetDebugStatus,
    destroyFlyMachine: mockDestroyFlyMachine,
    startKiloCliRun: mockStartKiloCliRun,
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
  mockStartKiloCliRun.mockReset();
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
  it('maps worker 409 to tRPC CONFLICT', async () => {
    const { KiloClawApiError } = jest.requireMock<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      KiloClawApiError: new (statusCode: number, responseBody: string) => any;
    }>('@/lib/kiloclaw/kiloclaw-internal-client');

    mockStartKiloCliRun.mockRejectedValue(
      new KiloClawApiError(409, JSON.stringify({ error: 'A CLI run is already in progress' }))
    );

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.startKiloCliRun({
        userId: testUserId,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A CLI run is already in progress',
    });
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
        userId: testUserId,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Instance needs redeploy to support recovery',
    });

    try {
      await caller.admin.kiloclawInstances.startKiloCliRun({
        userId: testUserId,
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

  it('maps worker 409 with empty body to CONFLICT with fallback message', async () => {
    const { KiloClawApiError } = jest.requireMock<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      KiloClawApiError: new (statusCode: number, responseBody: string) => any;
    }>('@/lib/kiloclaw/kiloclaw-internal-client');

    mockStartKiloCliRun.mockRejectedValue(new KiloClawApiError(409, ''));

    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawInstances.startKiloCliRun({
        userId: testUserId,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Failed to start kilo CLI run',
    });
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
