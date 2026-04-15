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
type KiloCliRunStatusResult = {
  hasRun: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | null;
  output: string | null;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  prompt: string | null;
};

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockStartKiloCliRun = jest.fn<() => Promise<StartKiloCliRunResult>>();
const mockCancelKiloCliRun = jest.fn<() => Promise<CancelKiloCliRunResult>>();
const mockGetKiloCliRunStatus = jest.fn<() => Promise<KiloCliRunStatusResult>>();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/kiloclaw/kiloclaw-internal-client'
  );
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      startKiloCliRun: mockStartKiloCliRun,
      cancelKiloCliRun: mockCancelKiloCliRun,
      getKiloCliRunStatus: mockGetKiloCliRunStatus,
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
  mockGetKiloCliRunStatus.mockReset();

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
    .returning({ id: kiloclaw_instances.id });
  if (!row) throw new Error('Failed to create personal KiloClaw instance');
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
    .returning({ id: kiloclaw_instances.id });
  if (!row) throw new Error('Failed to create organization KiloClaw instance');
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

async function createRunningCliRun(params: {
  userId: string;
  instanceId: string;
  prompt: string;
  startedAt: string;
}): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_cli_runs)
    .values({
      user_id: params.userId,
      instance_id: params.instanceId,
      prompt: params.prompt,
      status: 'running',
      started_at: params.startedAt,
    })
    .returning({ id: kiloclaw_cli_runs.id });

  if (!row) throw new Error('Failed to create Kilo CLI run');
  return row.id;
}

function mockRunningCliStatus(params: { startedAt: string; prompt: string }): void {
  mockGetKiloCliRunStatus.mockResolvedValue({
    hasRun: true,
    status: 'running',
    output: null,
    exitCode: null,
    startedAt: params.startedAt,
    completedAt: null,
    prompt: params.prompt,
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

  it('maps missing run to tRPC NOT_FOUND', async () => {
    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.cancelKiloCliRun({ runId: '10000000-1000-4000-8000-000000000001' })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Kilo CLI run not found',
    });
  });

  it('maps a late worker 409 during cancel to ok: false', async () => {
    const [instance] = await db
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.user_id, user.id))
      .limit(1);
    if (!instance) throw new Error('Expected personal KiloClaw instance');

    const instanceId = instance.id;
    const startedAt = '2026-04-12T12:00:00.000Z';
    const prompt = 'run that exits between status poll and cancel';
    const runId = await createRunningCliRun({ userId: user.id, instanceId, prompt, startedAt });
    mockRunningCliStatus({ startedAt, prompt });
    mockCancelKiloCliRun.mockRejectedValue(
      new KiloClawApiError(409, '{"code":"kilo_cli_run_no_active_run"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelKiloCliRun({ runId })).resolves.toEqual({ ok: false });
  });
});

// ── Org router: organizations.kiloclaw.cancelKiloCliRun ───────────────────

describe('organizations.kiloclaw.cancelKiloCliRun error translation', () => {
  beforeEach(async () => {
    org = await createOrganization('Test Org', user.id);
    await createOrgInstance(user.id, org.id);
  });

  it('maps missing run to tRPC NOT_FOUND', async () => {
    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({
        organizationId: org.id,
        runId: '10000000-1000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Kilo CLI run not found',
    });
  });

  it('maps a late worker 409 during cancel to ok: false', async () => {
    const [instance] = await db
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.organization_id, org.id))
      .limit(1);
    if (!instance) throw new Error('Expected organization KiloClaw instance');

    const startedAt = '2026-04-12T12:00:00.000Z';
    const prompt = 'org run that exits between status poll and cancel';
    const runId = await createRunningCliRun({
      userId: user.id,
      instanceId: instance.id,
      prompt,
      startedAt,
    });
    mockRunningCliStatus({ startedAt, prompt });
    mockCancelKiloCliRun.mockRejectedValue(
      new KiloClawApiError(409, '{"code":"kilo_cli_run_no_active_run"}')
    );

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({ organizationId: org.id, runId })
    ).resolves.toEqual({ ok: false });
  });
});
