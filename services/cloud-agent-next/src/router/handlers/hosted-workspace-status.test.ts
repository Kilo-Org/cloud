import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { getHostedWorkspaceStatus, hourlyMicrodollars } from './hosted-workspace-status.js';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getDb: vi.fn(),
  hasOrganizationAccess: vi.fn(),
}));
vi.mock('../../sandbox-session/session-stub', () => ({
  getSandboxSessionStub: mocks.getSession,
}));
vi.mock('../../db/pg', () => ({ getPgDb: mocks.getDb }));
vi.mock('@kilocode/worker-utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, hasOrganizationAccess: mocks.hasOrganizationAccess };
});

const userId = 'oauth/google:workspace-owner';
const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const cloudAgentSessionId = 'workspace_22222222-2222-4222-8222-222222222222';
const kiloSessionId = 'ses_12345678901234567890123456';

const sleepSnapshot = {
  status: 'sleeping' as const,
  provider: 'Cloudflare Containers' as const,
  observedAt: 1_760_000_000_000,
  detailCode: 'sandbox_stopped' as const,
  inactivityTimeoutMs: 600_000,
  estimatedSleepAt: null,
};

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    userId,
    organizationId: null,
    name: null,
    repositoryProvider: 'github' as const,
    gitUrl: 'https://github.com/Kilo-Org/cloud',
    gitBranch: 'feature/workspace-status',
    profileId: null,
    deletionState: 'active' as const,
    created: 1_760_000_000_000,
    updated: 1_760_000_001_000,
    lastActivity: 1_760_000_002_000,
    sessions: [
      {
        kiloSessionId,
        cloudAgentSessionId,
        workspaceId,
        userId,
        organizationId: null,
        title: 'Hosted root',
        gitUrl: null,
        gitBranch: null,
        profileId: null,
        createdOnPlatform: 'cloud-agent-web',
        created: 1_760_000_000_000,
        updated: 1_760_000_001_000,
      },
    ],
    nextSessionCursor: null,
    ...overrides,
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    userId,
    organizationId: null,
    deletionState: 'active' as const,
    activeSessionCount: 1,
    deletion: {
      started: false,
      completed: false,
      startedAt: null,
      phase: 'not_started',
      sessionCount: 1,
      runtimeLocationCount: 0,
      completedRuntimeLocationCount: 0,
      remainingRuntimeLocationCount: 0,
      deletedSessionIds: [],
    },
    ...overrides,
  };
}

function fixture(
  options: {
    workspace?: Record<string, unknown> | null;
    status?: Record<string, unknown> | null;
    runtime?: Record<string, unknown> | null;
    rate?: { rateCentsPerSecond: string | null } | null;
    dbRows?: unknown[][];
  } = {}
) {
  const getCloudAgentWorkspace = vi.fn(async () =>
    options.workspace === undefined ? workspace() : options.workspace
  );
  const getCloudAgentWorkspaceStatus = vi.fn(async () =>
    options.status === undefined ? status() : options.status
  );
  const getWorkspaceRuntimeStatus = vi.fn(async () =>
    options.runtime === undefined
      ? {
          sandbox: sleepSnapshot,
          billing: {
            payer: { type: 'user', id: userId },
            actor: { type: 'user', id: userId },
            onBehalfOf: null,
            sku: 'cloud-agent-standard',
            blocked: false,
            enforcementRequested: true,
            intervalStartedAt: null,
            meterInstanceId: 'sbx-meter',
          },
        }
      : options.runtime
  );
  const prepare = vi.fn();
  const deliver = vi.fn();
  mocks.getSession.mockReturnValue({
    getWorkspaceRuntimeStatus,
    prepare,
    deliver,
  });
  const dbRows = [
    ...(options.dbRows ??
      (options.rate === null
        ? [[]]
        : [[options.rate ?? { rateCentsPerSecond: '0.033416666667' }]])),
  ];
  const select = vi.fn(() => {
    const rows = dbRows.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => rows),
    };
    return builder;
  });
  mocks.getDb.mockReturnValue({ select });
  mocks.hasOrganizationAccess.mockResolvedValue(true);
  const ctx = {
    env: { SESSION_INGEST: { getCloudAgentWorkspace, getCloudAgentWorkspaceStatus } } as never,
    userId,
    authToken: 'authenticated-user-token',
    request: new Request('https://worker.test/trpc/getHostedWorkspaceStatus'),
  } satisfies TRPCContext;
  return {
    caller: router({ getHostedWorkspaceStatus }).createCaller(ctx),
    ctx,
    env: ctx.env as unknown as Env,
    getCloudAgentWorkspace,
    getCloudAgentWorkspaceStatus,
    getWorkspaceRuntimeStatus,
    prepare,
    deliver,
    select,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getHostedWorkspaceStatus', () => {
  it('projects a sleeping workspace without preparing or delivering work', async () => {
    const test = fixture();

    const result = await test.caller.getHostedWorkspaceStatus({ workspaceId });

    expect(result).toMatchObject({
      workspaceId,
      userId,
      organizationId: null,
      deletionState: 'active',
      compute: {
        status: 'sleeping',
        detailCode: 'sandbox_stopped',
        provider: 'Cloudflare Containers',
      },
      activity: { activeSessionCount: 1, hasActiveTurn: true },
      wakeOnInput: { available: true, blockedReason: null },
      billing: {
        payer: { type: 'user', id: userId },
        sku: 'cloud-agent-standard',
        blocked: false,
        rate: {
          rateCentsPerSecond: '0.033416666667',
          estimatedHourlyMicrodollars: 1_203_000,
        },
      },
      deletion: { started: false, completed: false, sessionCount: 1 },
    });
    expect(test.getWorkspaceRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.deliver).not.toHaveBeenCalled();
    expect(test.getCloudAgentWorkspaceStatus).toHaveBeenCalledWith({
      kiloUserId: userId,
      workspaceId,
      authorizedWorkspace: {
        userId,
        organizationId: null,
        deletionState: 'active',
      },
    });
  });

  it('recovers the metered rate for a sleeping workspace with no live allocation SKU', async () => {
    const test = fixture({
      runtime: {
        sandbox: sleepSnapshot,
        billing: {
          payer: { type: 'user', id: userId },
          actor: { type: 'user', id: userId },
          onBehalfOf: null,
          sku: null,
          blocked: false,
          enforcementRequested: true,
          intervalStartedAt: null,
          meterInstanceId: 'sbx-meter',
        },
      },
      dbRows: [
        [{ sku: 'cloud-agent-standard-2026-07', rateCentsPerSecond: null }],
        [{ rateCentsPerSecond: '0.033416666667' }],
      ],
    });

    await expect(test.caller.getHostedWorkspaceStatus({ workspaceId })).resolves.toMatchObject({
      compute: { status: 'sleeping' },
      billing: {
        sku: 'cloud-agent-standard-2026-07',
        rate: {
          rateCentsPerSecond: '0.033416666667',
          estimatedHourlyMicrodollars: 1_203_000,
        },
      },
    });
    expect(test.select).toHaveBeenCalledTimes(2);
    expect(test.getWorkspaceRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(test.prepare).not.toHaveBeenCalled();
  });

  it('reports a blocked payer as wake-unavailable without waking the workspace', async () => {
    const test = fixture({
      runtime: {
        sandbox: sleepSnapshot,
        billing: {
          payer: { type: 'org', id: '11111111-1111-4111-8111-111111111111' },
          actor: { type: 'user', id: userId },
          onBehalfOf: { type: 'user', id: 'oauth/google:member' },
          sku: 'cloud-agent-standard',
          blocked: true,
          enforcementRequested: true,
          intervalStartedAt: null,
        },
      },
    });

    await expect(test.caller.getHostedWorkspaceStatus({ workspaceId })).resolves.toMatchObject({
      wakeOnInput: { available: false, blockedReason: 'billing_blocked' },
      billing: { blocked: true, payer: { type: 'org' } },
    });
    expect(test.getWorkspaceRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(test.prepare).not.toHaveBeenCalled();
  });

  it('fails closed when enforced billing state cannot be read', async () => {
    const test = fixture({
      runtime: {
        sandbox: sleepSnapshot,
        billing: {
          payer: { type: 'user', id: userId },
          actor: { type: 'user', id: userId },
          onBehalfOf: null,
          sku: null,
          blocked: null,
          enforcementRequested: true,
          intervalStartedAt: null,
          meterInstanceId: 'sbx-meter',
        },
      },
      rate: null,
    });

    await expect(test.caller.getHostedWorkspaceStatus({ workspaceId })).resolves.toMatchObject({
      wakeOnInput: { available: false, blockedReason: 'billing_status_unavailable' },
      billing: { blocked: null, enforcementRequested: true },
    });
  });

  it('reports an in-flight deletion as wake-unavailable with journal progress', async () => {
    const test = fixture({
      status: status({
        deletionState: 'deleting',
        deletion: {
          started: true,
          completed: false,
          startedAt: 1_760_000_003_000,
          phase: 'runtime_cleanup',
          sessionCount: 4,
          runtimeLocationCount: 1,
          completedRuntimeLocationCount: 0,
          remainingRuntimeLocationCount: 1,
          deletedSessionIds: [],
        },
      }),
    });

    await expect(test.caller.getHostedWorkspaceStatus({ workspaceId })).resolves.toMatchObject({
      deletionState: 'deleting',
      wakeOnInput: { available: false, blockedReason: 'deleting' },
      deletion: { started: true, sessionCount: 4, runtimeLocationCount: 1 },
    });
  });

  it('reports a completed tombstone without any Durable Object access', async () => {
    const deletedSessionIds = [kiloSessionId, 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa'];
    const test = fixture({
      workspace: {
        ...workspace(),
        deletionState: 'deleted',
        sessions: [],
      },
      status: status({
        deletionState: 'deleted',
        activeSessionCount: 0,
        deletion: {
          started: true,
          completed: true,
          startedAt: 1_760_000_003_000,
          phase: 'completed',
          sessionCount: 2,
          runtimeLocationCount: 0,
          completedRuntimeLocationCount: 0,
          remainingRuntimeLocationCount: 0,
          deletedSessionIds,
        },
      }),
      runtime: null,
    });

    const result = await test.caller.getHostedWorkspaceStatus({ workspaceId });

    expect(result).toMatchObject({
      deletionState: 'deleted',
      compute: { status: 'unknown', detailCode: 'status_unavailable' },
      activity: { activeSessionCount: 0, hasActiveTurn: false },
      wakeOnInput: { available: false, blockedReason: 'deleted' },
      billing: { sku: null, blocked: null, rate: null },
      deletion: { completed: true, deletedSessionIds },
    });
    expect(test.getWorkspaceRuntimeStatus).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(test.select).not.toHaveBeenCalled();
  });

  it('requires the current organization to match the workspace scope', async () => {
    const test = fixture();
    await expect(
      test.caller.getHostedWorkspaceStatus({
        workspaceId,
        kilocodeOrganizationId: '33333333-3333-4333-8333-333333333333',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(test.getCloudAgentWorkspace).toHaveBeenCalledTimes(1);
    expect(test.getWorkspaceRuntimeStatus).not.toHaveBeenCalled();
  });

  it('rejects a caller who lost current organization membership', async () => {
    const test = fixture();
    mocks.hasOrganizationAccess.mockResolvedValue(false);
    await expect(
      test.caller.getHostedWorkspaceStatus({
        workspaceId,
        kilocodeOrganizationId: '33333333-3333-4333-8333-333333333333',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(test.getCloudAgentWorkspace).not.toHaveBeenCalled();
  });

  it('revalidates the owning organization when the caller omits the scope', async () => {
    const organizationId = '33333333-3333-4333-8333-333333333333';
    const test = fixture({
      workspace: workspace({ organizationId }),
      status: status({ organizationId }),
    });

    await expect(test.caller.getHostedWorkspaceStatus({ workspaceId })).resolves.toMatchObject({
      organizationId,
    });
    expect(mocks.hasOrganizationAccess).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: userId,
      organizationId,
    });

    mocks.hasOrganizationAccess.mockResolvedValue(false);
    await expect(test.caller.getHostedWorkspaceStatus({ workspaceId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects an unknown or unauthorized workspace without runtime access', async () => {
    const test = fixture({ workspace: null });
    await expect(test.caller.getHostedWorkspaceStatus({ workspaceId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(test.getWorkspaceRuntimeStatus).not.toHaveBeenCalled();
  });

  it('rejects a personal workspace requested through an organization scope', async () => {
    const test = fixture({ workspace: workspace({ organizationId: null }) });
    await expect(
      test.caller.getHostedWorkspaceStatus({
        workspaceId,
        kilocodeOrganizationId: '33333333-3333-4333-8333-333333333333',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(test.getWorkspaceRuntimeStatus).not.toHaveBeenCalled();
  });
});

describe('hourlyMicrodollars', () => {
  it.each([
    ['0.033416666667', 1_203_000],
    ['0.000277777778', 10_000],
    ['1', 36_000_000],
    ['0', undefined],
    ['not-a-rate', undefined],
  ])('converts %s cents per second', (rate, expected) => {
    expect(hourlyMicrodollars(rate)).toBe(expected);
  });
});
