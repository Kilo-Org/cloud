import { describe, expect, it, beforeAll, beforeEach, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kiloclaw_instances, kiloclaw_subscriptions, kiloclaw_cli_runs } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@kilocode/db/schema';
import type { createCallerForUser as createCallerForUserType } from '@/routers/test-utils';
import type { KiloClawApiError as KiloClawApiErrorType } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { UpstreamApiError } from '@/lib/trpc/init';

// ── Types ──────────────────────────────────────────────────────────────────

type StartKiloCliRunResult = { ok: true; startedAt: string };
type CancelKiloCliRunResult = { ok: boolean };

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockStartKiloCliRun = jest.fn<() => Promise<StartKiloCliRunResult>>();
const mockCancelKiloCliRun = jest.fn<() => Promise<CancelKiloCliRunResult>>();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/kiloclaw/kiloclaw-internal-client'
  );
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      startKiloCliRun: mockStartKiloCliRun,
      cancelKiloCliRun: mockCancelKiloCliRun,
    })),
    KiloClawApiError: actual.KiloClawApiError,
  };
});

jest.mock('next/headers', () => {
  const get = jest.fn<() => unknown>();
  return {
    cookies: jest.fn<() => Promise<{ get: typeof get }>>().mockResolvedValue({ get }),
    headers: jest.fn<() => Map<string, string>>().mockReturnValue(new Map()),
  };
});

// ── Dynamic imports (after mocks) ──────────────────────────────────────────

let createCallerForUser: typeof createCallerForUserType;
let KiloClawApiError: typeof KiloClawApiErrorType;

beforeAll(async () => {
  const mod = await import('@/routers/test-utils');
  createCallerForUser = mod.createCallerForUser;
  const clientMod = await import('@/lib/kiloclaw/kiloclaw-internal-client');
  KiloClawApiError = clientMod.KiloClawApiError;
});

// ── Helpers ────────────────────────────────────────────────────────────────

let user: User;
let org: Organization;

beforeEach(async () => {
  await cleanupDbForTest();
  mockStartKiloCliRun.mockReset();
  mockCancelKiloCliRun.mockReset();

  user = await insertTestUser({
    google_user_email: `clirun-test-${Math.random()}@example.com`,
  });
});

async function createPersonalInstance(userId: string): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: `sandbox-${userId.slice(0, 8)}`,
    })
    .returning();
  return row.id;
}

async function createOrgInstance(userId: string, organizationId: string): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: `sandbox-org-${userId.slice(0, 8)}`,
      organization_id: organizationId,
    })
    .returning();
  return row.id;
}

async function grantKiloClawAccess(userId: string): Promise<void> {
  await db.insert(kiloclaw_subscriptions).values({
    user_id: userId,
    plan: 'standard',
    status: 'active',
    stripe_subscription_id: `sub_test_${userId.slice(0, 8)}`,
  });
}

// ── Personal router: kiloclaw.startKiloCliRun ──────────────────────────────

describe('kiloclaw.startKiloCliRun error translation', () => {
  beforeEach(async () => {
    await grantKiloClawAccess(user.id);
    await createPersonalInstance(user.id);
  });

  it('maps worker 409 to tRPC CONFLICT', async () => {
    mockStartKiloCliRun.mockRejectedValue(
      new KiloClawApiError(409, '{"error":"A CLI run is already in progress"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.startKiloCliRun({ prompt: 'test prompt' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A CLI run is already in progress',
    });
  });

  it('maps worker 409 without message body to CONFLICT with fallback message', async () => {
    mockStartKiloCliRun.mockRejectedValue(new KiloClawApiError(409, ''));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.startKiloCliRun({ prompt: 'test prompt' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Instance is busy',
    });
  });

  it('maps controller_route_unavailable to PRECONDITION_FAILED', async () => {
    mockStartKiloCliRun.mockRejectedValue(
      new KiloClawApiError(404, '{"error":"Route not found","code":"controller_route_unavailable"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.startKiloCliRun({ prompt: 'test prompt' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Instance needs redeploy to support recovery',
    });

    try {
      await caller.kiloclaw.startKiloCliRun({ prompt: 'test prompt' });
      throw new Error('Expected startKiloCliRun to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      if (!(err instanceof TRPCError)) throw err;
      expect(err.cause).toBeInstanceOf(UpstreamApiError);
      if (!(err.cause instanceof UpstreamApiError)) throw err;
      expect(err.cause.upstreamCode).toBe('controller_route_unavailable');
    }
  });

  it('inserts a running kiloclaw_cli_runs row on success', async () => {
    const startedAt = '2024-01-01T00:00:00.000Z';
    mockStartKiloCliRun.mockResolvedValue({ ok: true, startedAt });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.startKiloCliRun({ prompt: 'fix the config' });

    expect(result).toMatchObject({ ok: true, startedAt, id: expect.any(String) });

    const rows = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, result.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: user.id,
      prompt: 'fix the config',
      status: 'running',
    });
  });
});

// ── Org router: organizations.kiloclaw.startKiloCliRun ─────────────────────

describe('organizations.kiloclaw.startKiloCliRun error translation', () => {
  beforeEach(async () => {
    org = await createOrganization('Test Org', user.id);
    await createOrgInstance(user.id, org.id);
  });

  it('maps worker 409 to tRPC CONFLICT', async () => {
    mockStartKiloCliRun.mockRejectedValue(
      new KiloClawApiError(409, '{"error":"A CLI run is already in progress"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.startKiloCliRun({
        organizationId: org.id,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A CLI run is already in progress',
    });
  });

  it('maps worker 409 without message body to CONFLICT with fallback message', async () => {
    mockStartKiloCliRun.mockRejectedValue(new KiloClawApiError(409, ''));

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.startKiloCliRun({
        organizationId: org.id,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Instance is busy',
    });
  });

  it('maps controller_route_unavailable to PRECONDITION_FAILED', async () => {
    mockStartKiloCliRun.mockRejectedValue(
      new KiloClawApiError(404, '{"error":"Route not found","code":"controller_route_unavailable"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.startKiloCliRun({
        organizationId: org.id,
        prompt: 'test prompt',
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Instance needs redeploy to support recovery',
    });

    try {
      await caller.organizations.kiloclaw.startKiloCliRun({
        organizationId: org.id,
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

  it('inserts a running kiloclaw_cli_runs row on success', async () => {
    const startedAt = '2024-01-01T00:00:00.000Z';
    mockStartKiloCliRun.mockResolvedValue({ ok: true, startedAt });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.startKiloCliRun({
      organizationId: org.id,
      prompt: 'fix the org config',
    });

    expect(result).toMatchObject({ ok: true, startedAt, id: expect.any(String) });

    const rows = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, result.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: user.id,
      instance_id: expect.any(String),
      prompt: 'fix the org config',
      status: 'running',
    });
  });
});

// ── Personal router: kiloclaw.cancelKiloCliRun ────────────────────────────

describe('kiloclaw.cancelKiloCliRun error translation', () => {
  beforeEach(async () => {
    await grantKiloClawAccess(user.id);
    await createPersonalInstance(user.id);
  });

  it('maps worker 409 to tRPC CONFLICT', async () => {
    mockCancelKiloCliRun.mockRejectedValue(
      new KiloClawApiError(409, '{"error":"Instance is not running"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.cancelKiloCliRun({ runId: '10000000-1000-4000-8000-000000000001' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Instance is not running',
    });
  });

  it('marks a running row cancelled when controller has no active run', async () => {
    const [instance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id));
    const [run] = await db
      .insert(kiloclaw_cli_runs)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        prompt: 'stale run',
        status: 'running',
      })
      .returning();
    mockCancelKiloCliRun.mockRejectedValue(
      new KiloClawApiError(
        409,
        '{"error":"No active run to cancel","code":"kilo_cli_run_no_active_run"}'
      )
    );

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelKiloCliRun({ runId: run.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'No active run to cancel',
    });

    const rows = await db.select().from(kiloclaw_cli_runs).where(eq(kiloclaw_cli_runs.id, run.id));
    expect(rows[0]).toMatchObject({
      status: 'cancelled',
      completed_at: expect.any(String),
    });
  });

  it('maps worker 409 without message body to CONFLICT with fallback message', async () => {
    mockCancelKiloCliRun.mockRejectedValue(new KiloClawApiError(409, ''));

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.cancelKiloCliRun({ runId: '10000000-1000-4000-8000-000000000001' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Instance is not running',
    });
  });
});

// ── Org router: organizations.kiloclaw.cancelKiloCliRun ───────────────────

describe('organizations.kiloclaw.cancelKiloCliRun error translation', () => {
  beforeEach(async () => {
    org = await createOrganization('Test Org', user.id);
    await createOrgInstance(user.id, org.id);
  });

  it('maps worker 409 to tRPC CONFLICT', async () => {
    mockCancelKiloCliRun.mockRejectedValue(
      new KiloClawApiError(409, '{"error":"Instance is not running"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({
        organizationId: org.id,
        runId: '10000000-1000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Instance is not running',
    });
  });

  it('marks a running org row cancelled when controller has no active run', async () => {
    const [instance] = await db
      .select()
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.organization_id, org.id));
    const [run] = await db
      .insert(kiloclaw_cli_runs)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        prompt: 'stale org run',
        status: 'running',
      })
      .returning();
    mockCancelKiloCliRun.mockRejectedValue(
      new KiloClawApiError(
        409,
        '{"error":"No active run to cancel","code":"kilo_cli_run_no_active_run"}'
      )
    );

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({
        organizationId: org.id,
        runId: run.id,
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'No active run to cancel',
    });

    const rows = await db.select().from(kiloclaw_cli_runs).where(eq(kiloclaw_cli_runs.id, run.id));
    expect(rows[0]).toMatchObject({
      status: 'cancelled',
      completed_at: expect.any(String),
    });
  });

  it('maps worker 409 without message body to CONFLICT with fallback message', async () => {
    mockCancelKiloCliRun.mockRejectedValue(new KiloClawApiError(409, ''));

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({
        organizationId: org.id,
        runId: '10000000-1000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Instance is not running',
    });
  });
});
