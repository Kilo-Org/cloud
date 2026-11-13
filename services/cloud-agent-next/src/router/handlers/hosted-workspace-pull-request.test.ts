import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, TRPCContext } from '../../types.js';
import type * as workspacePullRequestModule from '../../session/workspace-pull-request.js';
import { router } from '../auth.js';
import { refreshHostedWorkspacePullRequest } from './hosted-workspace-pull-request.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  hasOrganizationAccess: vi.fn(),
  getPgDb: vi.fn(() => ({})),
}));
vi.mock('../../db/pg.js', () => ({ getPgDb: mocks.getPgDb }));
vi.mock('../../session/workspace-pull-request.js', async importOriginal => {
  const actual = await importOriginal<typeof workspacePullRequestModule>();
  return { ...actual, readWorkspacePullRequestSummaries: mocks.read };
});
vi.mock('@kilocode/worker-utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, hasOrganizationAccess: mocks.hasOrganizationAccess };
});

const userId = 'oauth/google:workspace-owner';
const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111' as const;

function pullRequest() {
  return {
    url: 'https://github.com/Kilo-Org/cloud/pull/142',
    number: 142,
    state: 'open' as const,
    title: 'Expose hosted workspace PR status',
    headSha: 'a'.repeat(40),
    lastSyncedAt: '2026-10-21T12:00:00.000Z',
    review: { decision: 'approved' as const, available: true, pending: false },
    checks: {
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      complete: true,
      available: true,
    },
    conversations: { unresolved: 0, complete: true },
    mergeability: { mergeable: true, state: 'clean', complete: true },
    partial: false,
    unavailable: [],
  };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    userId,
    organizationId: null,
    name: 'Cloud workspace',
    repositoryProvider: 'github' as const,
    gitUrl: 'https://github.com/Kilo-Org/cloud',
    gitBranch: 'feature/workspace-pr',
    profileId: null,
    deletionState: 'active' as const,
    created: 1_760_000_000_000,
    updated: 1_760_000_001_000,
    lastActivity: 1_760_000_002_000,
    sessions: [],
    nextSessionCursor: null,
    ...overrides,
  };
}

function fixture(
  options: {
    workspace?: Record<string, unknown> | null;
    summary?: unknown;
    env?: Record<string, unknown>;
  } = {}
) {
  const getCloudAgentWorkspace = vi.fn(async () =>
    options.workspace === undefined ? workspace() : options.workspace
  );
  const durableObjectAccess = vi.fn(() => {
    throw new Error('Workspace PR refresh must not access Durable Objects');
  });
  const ctx = {
    env: {
      SESSION_INGEST: { getCloudAgentWorkspace },
      CLOUD_AGENT_SESSION: { idFromName: durableObjectAccess, get: durableObjectAccess },
      SANDBOX_SESSION: { idFromName: durableObjectAccess, get: durableObjectAccess },
      INTERNAL_API_SECRET: 'internal-secret',
      KILOCODE_BACKEND_BASE_URL: 'https://api.test',
      ...options.env,
    } as unknown as Env,
    userId,
    authToken: 'authenticated-user-token',
    request: new Request('https://worker.test/trpc/refreshHostedWorkspacePullRequest'),
  } satisfies TRPCContext;

  mocks.read.mockResolvedValue(
    options.summary === undefined ? new Map() : new Map([[workspaceId, options.summary]])
  );
  return {
    caller: router({ refreshHostedWorkspacePullRequest }).createCaller(ctx),
    getCloudAgentWorkspace,
    durableObjectAccess,
  };
}

function backendResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  mocks.read.mockReset();
  mocks.hasOrganizationAccess.mockReset();
  mocks.getPgDb.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('refreshHostedWorkspacePullRequest', () => {
  it('refreshes through the authenticated internal route and returns the summary', async () => {
    fetchMock.mockResolvedValueOnce(backendResponse({ status: 'refreshed', retryAt: null }));
    const test = fixture({ summary: pullRequest() });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({ status: 'refreshed', retryAt: null });
    expect(result.pullRequest).toMatchObject({ number: 142 });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://api.test/api/internal/cloud-agent-next/hosted-workspace-pull-request/refresh'
      ),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'internal-secret',
        },
        body: JSON.stringify({ workspaceId, userId, organizationId: null }),
        signal: expect.any(AbortSignal),
      }
    );
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });

  it('keeps cached data and reports a rate limit', async () => {
    fetchMock.mockResolvedValueOnce(
      backendResponse({ status: 'rate_limited', retryAt: '2026-10-22T00:00:00.000Z' })
    );
    const test = fixture({ summary: pullRequest() });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({
      status: 'rate_limited',
      retryAt: '2026-10-22T00:00:00.000Z',
    });
    expect(result.pullRequest).toMatchObject({ number: 142 });
  });

  it('keeps cached data when the owner has no GitHub integration', async () => {
    fetchMock.mockResolvedValueOnce(backendResponse({ status: 'no_integration', retryAt: null }));
    const test = fixture({ summary: pullRequest() });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({ status: 'no_integration', retryAt: null });
    expect(result.pullRequest).toMatchObject({ number: 142 });
  });

  it('keeps cached data when the refresh backend fails', async () => {
    fetchMock.mockResolvedValueOnce(backendResponse({ error: 'boom' }, 500));
    const test = fixture({ summary: pullRequest() });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({ status: 'failed', retryAt: null });
    expect(result.pullRequest).toMatchObject({ number: 142 });
  });

  it('keeps cached data when the backend returns an invalid result', async () => {
    fetchMock.mockResolvedValueOnce(backendResponse({ status: 'surprise' }));
    const test = fixture({ summary: pullRequest() });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({ status: 'failed', retryAt: null });
    expect(result.pullRequest).toMatchObject({ number: 142 });
  });

  it('keeps cached data when the backend is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const test = fixture({ summary: pullRequest() });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({ status: 'failed', retryAt: null });
    expect(result.pullRequest).toMatchObject({ number: 142 });
  });

  it('reports not found when the backend says the workspace disappeared', async () => {
    fetchMock.mockResolvedValueOnce(backendResponse({ error: 'Workspace not found' }, 404));
    const test = fixture({ summary: pullRequest() });

    await expect(
      test.caller.refreshHostedWorkspacePullRequest({ workspaceId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports no PR only when no verified PR exists', async () => {
    fetchMock.mockResolvedValueOnce(backendResponse({ status: 'no_pr', retryAt: null }));
    const test = fixture();

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({ status: 'no_pr', retryAt: null });
    expect(result.pullRequest).toBeNull();
  });

  it('does not report no PR when a workspace-level PR is still cached', async () => {
    fetchMock.mockResolvedValueOnce(backendResponse({ status: 'no_pr', retryAt: null }));
    const test = fixture({ summary: pullRequest() });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh.status).toBe('refreshed');
    expect(result.pullRequest).toMatchObject({ number: 142 });
  });

  it('reports unavailable without calling the backend when the internal secret is missing', async () => {
    const test = fixture({ summary: pullRequest(), env: { INTERNAL_API_SECRET: undefined } });

    const result = await test.caller.refreshHostedWorkspacePullRequest({ workspaceId });

    expect(result.refresh).toEqual({ status: 'unavailable', retryAt: null });
    expect(result.pullRequest).toMatchObject({ number: 142 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns not found for an unauthorized or missing workspace', async () => {
    const test = fixture({ workspace: null });

    await expect(
      test.caller.refreshHostedWorkspacePullRequest({ workspaceId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechecks organization access before refreshing', async () => {
    mocks.hasOrganizationAccess.mockResolvedValueOnce(false);
    const test = fixture({ workspace: workspace({ organizationId: 'org-1' }) });

    await expect(
      test.caller.refreshHostedWorkspacePullRequest({ workspaceId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed workspace id before any backend call', async () => {
    const test = fixture();

    await expect(
      test.caller.refreshHostedWorkspacePullRequest({ workspaceId: 'not-a-workspace' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
