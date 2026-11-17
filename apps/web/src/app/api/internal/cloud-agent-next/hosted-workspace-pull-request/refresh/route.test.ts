import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as routeModule from './route';

const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const userId = 'oauth/google:workspace-owner';

let POST: typeof routeModule.POST;
let authorized = true;

const mockRefresh =
  jest.fn<(input: { sessionId: string }) => Promise<{ associatedPr: { number: number } | null }>>();
const mockCaller = { cliSessionsV2: { refreshAssociatedPullRequest: mockRefresh } };
const mockCreateCaller = jest.fn<(ctx: unknown) => typeof mockCaller>(() => mockCaller);
const mockFindUserById = jest.fn<(id: string) => Promise<{ id: string; is_admin: boolean } | null>>(
  async () => ({ id: userId, is_admin: false })
);
const mockLimit = jest.fn<() => Promise<{ sessionId: string }[]>>();
const mockOrderBy = jest.fn(() => ({ limit: mockLimit }));
const mockWhere = jest.fn(() => ({ orderBy: mockOrderBy }));
const mockInnerJoin = jest.fn(() => ({ where: mockWhere }));
const mockFrom = jest.fn(() => ({ innerJoin: mockInnerJoin }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock('@/lib/internal-api-auth', () => ({
  authorizeInternalApiRequest: () =>
    authorized ? null : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));

jest.mock('@/routers/root-router', () => ({ rootRouter: {} }));

jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createCallerFactory: () => mockCreateCaller,
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: { select: mockSelect } }));

jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: mockFindUserById,
}));

function request(body: unknown) {
  return new Request(
    'http://localhost/api/internal/cloud-agent-next/hosted-workspace-pull-request/refresh',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { workspaceId, userId, organizationId: null, ...overrides };
}

function sessions(...ids: string[]) {
  mockLimit.mockResolvedValue(ids.map(sessionId => ({ sessionId })));
}

beforeEach(async () => {
  jest.clearAllMocks();
  authorized = true;
  mockFindUserById.mockResolvedValue({ id: userId, is_admin: false });
  sessions('workspace_11111111-1111-4111-8111-111111111111');
  mockRefresh.mockResolvedValue({ associatedPr: { number: 142 } });
  ({ POST } = await import('./route'));
});

describe('POST internal hosted workspace PR refresh', () => {
  it('rejects an unauthorized internal caller before reading the workspace', async () => {
    authorized = false;

    const response = await POST(request(validBody()));

    expect(response.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies', async () => {
    const response = await POST(request({ workspaceId: 'not-a-workspace', userId }));

    expect(response.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns not found when the workspace has no authorized root session', async () => {
    sessions();

    const response = await POST(request(validBody()));

    expect(response.status).toBe(404);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('returns not found when the owner user no longer exists', async () => {
    mockFindUserById.mockResolvedValueOnce(null as never);

    const response = await POST(request(validBody()));

    expect(response.status).toBe(404);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('reuses the existing refresh procedure for the workspace root session', async () => {
    const response = await POST(request(validBody()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'refreshed', retryAt: null });
    expect(mockRefresh).toHaveBeenCalledWith({
      sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    });
    expect(mockCreateCaller).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: userId, is_admin: false } })
    );
  });

  it('reports no PR through one rate-limited refresh attempt', async () => {
    mockRefresh.mockResolvedValueOnce({ associatedPr: null });

    const response = await POST(request(validBody()));

    await expect(response.json()).resolves.toEqual({ status: 'no_pr', retryAt: null });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('maps the no-integration refusal without losing the response contract', async () => {
    mockRefresh.mockRejectedValueOnce(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No GitHub integration configured for this session',
        cause: { reason: 'no_integration' },
      })
    );

    const response = await POST(request(validBody()));

    await expect(response.json()).resolves.toEqual({ status: 'no_integration', retryAt: null });
  });

  it('maps rate limiting with its retry time', async () => {
    mockRefresh.mockRejectedValueOnce(
      new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'GitHub rate limit reached',
        cause: { reason: 'rate_limited', retryAt: '2026-10-22T00:00:00.000Z' },
      })
    );

    const response = await POST(request(validBody()));

    await expect(response.json()).resolves.toEqual({
      status: 'rate_limited',
      retryAt: '2026-10-22T00:00:00.000Z',
    });
  });

  it('maps a throttled refresh', async () => {
    mockRefresh.mockRejectedValueOnce(
      new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Already attempted',
        cause: { reason: 'throttled', retryAt: '2026-10-22T00:00:00.000Z' },
      })
    );

    const response = await POST(request(validBody()));

    await expect(response.json()).resolves.toEqual({
      status: 'throttled',
      retryAt: '2026-10-22T00:00:00.000Z',
    });
  });

  it('maps budget unavailability and GitHub failure', async () => {
    mockRefresh.mockRejectedValueOnce(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Cached data is unchanged' })
    );
    let response = await POST(request(validBody()));
    await expect(response.json()).resolves.toEqual({ status: 'unavailable', retryAt: null });

    mockRefresh.mockRejectedValueOnce(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch pull request',
        cause: { reason: 'fetch_failed' },
      })
    );
    response = await POST(request(validBody()));
    await expect(response.json()).resolves.toEqual({ status: 'failed', retryAt: null });
  });
});
