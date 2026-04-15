import { describe, expect, it, beforeAll, beforeEach, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kiloclaw_instances, kiloclaw_subscriptions, kiloclaw_cli_runs } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@kilocode/db/schema';
import type { createCallerForUser as createCallerForUserType } from '@/routers/test-utils';
import type { KiloClawApiError as KiloClawApiErrorType } from '@/lib/kiloclaw/kiloclaw-internal-client';

// ── Types ──────────────────────────────────────────────────────────────────

type StartKiloCliRunResult = { ok: true; startedAt: string };

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockStartKiloCliRun = jest.fn<() => Promise<StartKiloCliRunResult>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetKiloCliRunStatus = jest.fn<(...args: any[]) => any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCancelKiloCliRun = jest.fn<(...args: any[]) => any>();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/kiloclaw/kiloclaw-internal-client'
  );
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      startKiloCliRun: mockStartKiloCliRun,
      getKiloCliRunStatus: mockGetKiloCliRunStatus,
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
  mockGetKiloCliRunStatus.mockReset();
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

async function insertRunningCliRun(
  userId: string,
  instanceId: string,
  startedAt: string
): Promise<{ id: string; startedAt: string }> {
  const [row] = await db
    .insert(kiloclaw_cli_runs)
    .values({
      user_id: userId,
      instance_id: instanceId,
      prompt: 'test prompt',
      status: 'running',
      started_at: startedAt,
    })
    .returning({ id: kiloclaw_cli_runs.id, startedAt: kiloclaw_cli_runs.started_at });
  return { id: row.id, startedAt: row.startedAt };
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
  });

  it('inserts a running kiloclaw_cli_runs row on success', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
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

// ── Personal router: kiloclaw.getKiloCliRunStatus ──────────────────────────

describe('kiloclaw.getKiloCliRunStatus reconciliation', () => {
  beforeEach(async () => {
    await grantKiloClawAccess(user.id);
  });

  it('terminalizes a running row when controller has no run', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: false,
      status: null,
      output: null,
      exitCode: null,
      startedAt: null,
      completedAt: null,
      prompt: null,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getKiloCliRunStatus({ runId });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'failed',
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('failed');
    expect(dbRow.completed_at).not.toBeNull();
  });

  it('terminalizes a running row when controller reports a different run', async () => {
    const rowStartedAt = '2024-01-01T00:00:00.000+00:00';
    const controllerStartedAt = '2024-01-02T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, rowStartedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'some output from new run',
      exitCode: null,
      startedAt: controllerStartedAt,
      completedAt: null,
      prompt: 'different prompt',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getKiloCliRunStatus({ runId });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'failed',
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('failed');
  });

  it('persists terminal status when controller matches and is complete', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'completed',
      output: 'task done',
      exitCode: 0,
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:05:00.000Z',
      prompt: 'test prompt',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getKiloCliRunStatus({ runId });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'completed',
      output: 'task done',
      exitCode: 0,
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('completed');
    expect(dbRow.exit_code).toBe(0);
  });

  it('returns live output without terminalizing when controller matches and is running', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'in progress...',
      exitCode: null,
      startedAt: run.startedAt,
      completedAt: null,
      prompt: 'test prompt',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getKiloCliRunStatus({ runId });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'running',
      output: 'in progress...',
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('running');
  });
});

// ── Personal router: kiloclaw.cancelKiloCliRun ─────────────────────────────

describe('kiloclaw.cancelKiloCliRun identity validation', () => {
  beforeEach(async () => {
    await grantKiloClawAccess(user.id);
  });

  it('rejects cancel when the run is not running', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const [row] = await db
      .insert(kiloclaw_cli_runs)
      .values({
        user_id: user.id,
        instance_id: instanceId,
        prompt: 'test prompt',
        status: 'completed',
        started_at: startedAt,
        completed_at: '2024-01-01T00:05:00.000Z',
      })
      .returning({ id: kiloclaw_cli_runs.id });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelKiloCliRun({ runId: row.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Kilo CLI run is no longer running',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();
  });

  it('rejects cancel and terminalizes row when controller has no run', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: false,
      status: null,
      output: null,
      exitCode: null,
      startedAt: null,
      completedAt: null,
      prompt: null,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelKiloCliRun({ runId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Kilo CLI run is no longer active on the controller',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('failed');
  });

  it('rejects cancel when controller is running a different run', async () => {
    const rowStartedAt = '2024-01-01T00:00:00.000+00:00';
    const controllerStartedAt = '2024-01-02T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, rowStartedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'new run output',
      exitCode: null,
      startedAt: controllerStartedAt,
      completedAt: null,
      prompt: 'different prompt',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelKiloCliRun({ runId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();
  });

  it('persists terminal status and rejects cancel when controller reports same run already completed', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'completed',
      output: 'task done',
      exitCode: 0,
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:05:00.000Z',
      prompt: 'test prompt',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelKiloCliRun({ runId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Kilo CLI run is no longer running',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('completed');
    expect(dbRow.exit_code).toBe(0);
    expect(Date.parse(dbRow.completed_at ?? '')).toBe(Date.parse('2024-01-01T00:05:00.000Z'));
  });

  it('cancels successfully when controller matches the DB run', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createPersonalInstance(user.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'in progress',
      exitCode: null,
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: null,
      prompt: 'test prompt',
    });
    mockCancelKiloCliRun.mockResolvedValue({ ok: true });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelKiloCliRun({ runId });

    expect(result).toMatchObject({ ok: true });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('cancelled');
    expect(dbRow.completed_at).not.toBeNull();
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
  });

  it('inserts a running kiloclaw_cli_runs row on success', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
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

// ── Org router: organizations.kiloclaw.getKiloCliRunStatus ─────────────────

describe('organizations.kiloclaw.getKiloCliRunStatus reconciliation', () => {
  beforeEach(async () => {
    org = await createOrganization('Test Org', user.id);
  });

  it('terminalizes a running row when controller has no run', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: false,
      status: null,
      output: null,
      exitCode: null,
      startedAt: null,
      completedAt: null,
      prompt: null,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.getKiloCliRunStatus({
      organizationId: org.id,
      runId,
    });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'failed',
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('failed');
    expect(dbRow.completed_at).not.toBeNull();
  });

  it('terminalizes a running row when controller reports a different run', async () => {
    const rowStartedAt = '2024-01-01T00:00:00.000+00:00';
    const controllerStartedAt = '2024-01-02T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, rowStartedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'some output from new run',
      exitCode: null,
      startedAt: controllerStartedAt,
      completedAt: null,
      prompt: 'different prompt',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.getKiloCliRunStatus({
      organizationId: org.id,
      runId,
    });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'failed',
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('failed');
  });

  it('persists terminal status when controller matches and is complete', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'completed',
      output: 'task done',
      exitCode: 0,
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:05:00.000Z',
      prompt: 'test prompt',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.getKiloCliRunStatus({
      organizationId: org.id,
      runId,
    });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'completed',
      output: 'task done',
      exitCode: 0,
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('completed');
    expect(dbRow.exit_code).toBe(0);
  });

  it('returns live output without terminalizing when controller matches and is running', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'in progress...',
      exitCode: null,
      startedAt: run.startedAt,
      completedAt: null,
      prompt: 'test prompt',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.getKiloCliRunStatus({
      organizationId: org.id,
      runId,
    });

    expect(result).toMatchObject({
      hasRun: true,
      status: 'running',
      output: 'in progress...',
    });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('running');
  });
});

// ── Org router: organizations.kiloclaw.cancelKiloCliRun ────────────────────

describe('organizations.kiloclaw.cancelKiloCliRun identity validation', () => {
  beforeEach(async () => {
    org = await createOrganization('Test Org', user.id);
  });

  it('rejects cancel when the run is not running', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const [row] = await db
      .insert(kiloclaw_cli_runs)
      .values({
        user_id: user.id,
        instance_id: instanceId,
        prompt: 'test prompt',
        status: 'completed',
        started_at: startedAt,
        completed_at: '2024-01-01T00:05:00.000Z',
      })
      .returning({ id: kiloclaw_cli_runs.id });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({
        organizationId: org.id,
        runId: row.id,
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Kilo CLI run is no longer running',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();
  });

  it('rejects cancel and terminalizes row when controller has no run', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: false,
      status: null,
      output: null,
      exitCode: null,
      startedAt: null,
      completedAt: null,
      prompt: null,
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({ organizationId: org.id, runId })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Kilo CLI run is no longer active on the controller',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('failed');
  });

  it('rejects cancel when controller is running a different run', async () => {
    const rowStartedAt = '2024-01-01T00:00:00.000+00:00';
    const controllerStartedAt = '2024-01-02T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, rowStartedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'new run output',
      exitCode: null,
      startedAt: controllerStartedAt,
      completedAt: null,
      prompt: 'different prompt',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({ organizationId: org.id, runId })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();
  });

  it('persists terminal status and rejects cancel when controller reports same run already completed', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'completed',
      output: 'task done',
      exitCode: 0,
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:05:00.000Z',
      prompt: 'test prompt',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.cancelKiloCliRun({ organizationId: org.id, runId })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Kilo CLI run is no longer running',
    });

    expect(mockCancelKiloCliRun).not.toHaveBeenCalled();

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('completed');
    expect(dbRow.exit_code).toBe(0);
    expect(Date.parse(dbRow.completed_at ?? '')).toBe(Date.parse('2024-01-01T00:05:00.000Z'));
  });

  it('cancels successfully when controller matches the DB run', async () => {
    const startedAt = '2024-01-01T00:00:00.000+00:00';
    const instanceId = await createOrgInstance(user.id, org.id);
    const run = await insertRunningCliRun(user.id, instanceId, startedAt);
    const runId = run.id;

    mockGetKiloCliRunStatus.mockResolvedValue({
      hasRun: true,
      status: 'running',
      output: 'in progress',
      exitCode: null,
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: null,
      prompt: 'test prompt',
    });
    mockCancelKiloCliRun.mockResolvedValue({ ok: true });

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.cancelKiloCliRun({
      organizationId: org.id,
      runId,
    });

    expect(result).toMatchObject({ ok: true });

    const [dbRow] = await db
      .select()
      .from(kiloclaw_cli_runs)
      .where(eq(kiloclaw_cli_runs.id, runId));
    expect(dbRow.status).toBe('cancelled');
    expect(dbRow.completed_at).not.toBeNull();
  });
});
