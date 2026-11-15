import type { CloudAgentWorkspaceSummary } from '@kilocode/session-ingest-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../../types.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  select: vi.fn(),
  resolveAuth: vi.fn(),
}));

vi.mock('../../db/pg', () => ({ getPgDb: mocks.getDb }));
vi.mock('../../services/git-token-service-client.js', () => ({
  resolveCloudAgentGitHubAuthForRepo: mocks.resolveAuth,
}));

import { router } from '../auth.js';
import {
  getHostedWorkspacePullRequest,
  getHostedWorkspacePullRequestFile,
  resetHostedWorkspacePullRequestCachesForTest,
} from './hosted-workspace-pull-request.js';

const userId = 'usr_owner';
const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const headSha = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);
const prUrl = 'https://github.com/Kilo-Org/cloud/pull/145';

function workspace(
  overrides: Partial<CloudAgentWorkspaceSummary> = {}
): CloudAgentWorkspaceSummary {
  return {
    workspaceId,
    userId,
    organizationId: null,
    name: null,
    repositoryProvider: 'github',
    gitUrl: 'https://github.com/Kilo-Org/cloud',
    gitBranch: 'feature/diffs',
    profileId: null,
    deletionState: 'active',
    created: 1_760_000_000_000,
    updated: 1_760_000_001_000,
    lastActivity: 1_760_000_002_000,
    sessions: [
      {
        kiloSessionId: 'ses_11111111111111111111111111',
        cloudAgentSessionId: sessionId,
        workspaceId,
        userId,
        organizationId: null,
        title: null,
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

function livePullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 145,
    html_url: prUrl,
    state: 'open',
    draft: false,
    head: { ref: 'feature/diffs', sha: headSha, repo: { full_name: 'Kilo-Org/cloud' } },
    base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'Kilo-Org/cloud' } },
    ...overrides,
  };
}

const filesPayload = [
  {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-old\n+new\n',
  },
  {
    filename: 'src/image.png',
    status: 'added',
    additions: 0,
    deletions: 0,
  },
];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function fixture(
  options: {
    workspace?: CloudAgentWorkspaceSummary | null;
    rows?: unknown[];
    auth?: unknown;
    userAuth?: unknown;
  } = {}
) {
  const getCloudAgentWorkspace = vi.fn(async () =>
    options.workspace === undefined ? workspace() : options.workspace
  );
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => options.rows ?? []),
    };
    return builder;
  });
  mocks.getDb.mockReturnValue({ select });
  mocks.resolveAuth.mockImplementation(async (_env, params: { allowUserAuthorization: boolean }) =>
    params.allowUserAuthorization
      ? (options.userAuth ?? {
          success: false,
          error: { reason: 'no_installation_found', message: '' },
        })
      : (options.auth ?? {
          success: true,
          value: {
            githubToken: 'installation-token',
            installationId: '1',
            appType: 'standard',
            accountLogin: 'bot',
            source: 'installation',
          },
        })
  );
  const context = {
    env: { SESSION_INGEST: { getCloudAgentWorkspace }, GIT_TOKEN_SERVICE: {} } as never,
    userId,
    authToken: 'test-token',
    request: new Request('https://worker.test/trpc'),
  } satisfies TRPCContext;
  const caller = router({
    getHostedWorkspacePullRequest,
    getHostedWorkspacePullRequestFile,
  }).createCaller(context);
  return { caller, getCloudAgentWorkspace, select };
}

const cachedRow = { pr_number: 145, pr_url: prUrl, pr_head_sha: headSha };

function fetchMock(...responses: Array<Response | Error>) {
  const mock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) mock.mockRejectedValueOnce(response);
    else mock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  resetHostedWorkspacePullRequestCachesForTest();
});

describe('getHostedWorkspacePullRequest', () => {
  it('serves the verified linked PR and its bounded file list with the installation credential', async () => {
    const test = fixture({ rows: [cachedRow] });
    const fetch = fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(livePullRequest())
    );

    const result = await test.caller.getHostedWorkspacePullRequest({ workspaceId });

    expect(result).toMatchObject({
      status: 'linked',
      workspaceId,
      reason: null,
      truncated: false,
      pullRequest: {
        number: 145,
        url: prUrl,
        state: 'open',
        draft: false,
        headSha,
        baseRef: 'main',
        repository: { path: '', repoFullName: 'Kilo-Org/cloud' },
        cacheStale: false,
      },
      files: [
        {
          path: 'src/app.ts',
          previousPath: null,
          status: 'modified',
          additions: 3,
          deletions: 1,
          patchAvailable: true,
        },
        {
          path: 'src/image.png',
          previousPath: null,
          status: 'added',
          additions: 0,
          deletions: 0,
          patchAvailable: false,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    const headers = (fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer installation-token');
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.resolveAuth).toHaveBeenCalledWith(expect.anything(), {
      githubRepo: 'kilo-org/cloud',
      userId,
      allowUserAuthorization: false,
    });
  });

  it('reuses the file list for repeated reads at the same head', async () => {
    const test = fixture({ rows: [cachedRow] });
    const fetch = fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(livePullRequest()),
      jsonResponse(livePullRequest()),
      jsonResponse(livePullRequest())
    );

    await test.caller.getHostedWorkspacePullRequest({ workspaceId });
    expect(fetch).toHaveBeenCalledTimes(3);
    await test.caller.getHostedWorkspacePullRequest({ workspaceId });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('surfaces a timed-out GitHub request as unavailable', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    );

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      { status: 'unavailable', reason: 'github_unavailable' }
    );
  });

  it('flags a stale cache head without rejecting the live publication', async () => {
    const test = fixture({ rows: [{ ...cachedRow, pr_head_sha: otherSha }] });
    fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(livePullRequest())
    );

    const result = await test.caller.getHostedWorkspacePullRequest({ workspaceId });

    expect(result.pullRequest).toMatchObject({ headSha, cacheStale: true });
  });

  it('returns no PR data when the live head ref is not the workspace branch', async () => {
    const test = fixture({ rows: [cachedRow] });
    const fetch = fetchMock(
      jsonResponse(
        livePullRequest({
          head: { ref: 'another-branch', sha: headSha, repo: { full_name: 'Kilo-Org/cloud' } },
        })
      )
    );

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      {
        status: 'unverified',
        reason: 'head_ref_mismatch',
        pullRequest: null,
        files: [],
      }
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns no PR data when the live PR belongs to another repository', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      jsonResponse(
        livePullRequest({
          head: { ref: 'feature/diffs', sha: headSha, repo: { full_name: 'fork/cloud' } },
        })
      )
    );

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      { status: 'unverified', reason: 'repository_mismatch' }
    );
  });

  it('returns not_linked without resolving a credential when the workspace branch has no cached PR', async () => {
    const test = fixture({ rows: [] });
    const fetch = fetchMock();

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      { status: 'not_linked', reason: 'no_pull_request', files: [] }
    );
    expect(mocks.resolveAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports credential_required when only a connected-user credential would work', async () => {
    const test = fixture({
      rows: [cachedRow],
      auth: { success: false, error: { reason: 'no_installation_found', message: '' } },
      userAuth: {
        success: true,
        value: {
          githubToken: 'connected-user-token',
          installationId: '1',
          appType: 'standard',
          accountLogin: 'user',
          source: 'user',
        },
      },
    });
    const fetch = fetchMock();

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      { status: 'credential_required', reason: 'connected_user_required' }
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes an unauthorized GitHub read from a missing PR', async () => {
    const denied = fixture({ rows: [cachedRow] });
    fetchMock(jsonResponse({ message: 'Resource not accessible' }, { status: 403 }));
    await expect(
      denied.caller.getHostedWorkspacePullRequest({ workspaceId })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'github_access_denied' });

    const missing = fixture({ rows: [cachedRow] });
    fetchMock(jsonResponse({ message: 'Not Found' }, { status: 404 }));
    await expect(
      missing.caller.getHostedWorkspacePullRequest({ workspaceId })
    ).resolves.toMatchObject({ status: 'unverified', reason: 'pull_request_not_found' });
  });

  it('maps a secondary GitHub rate limit to a retryable rate-limit result', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      jsonResponse(
        { message: 'You have exceeded a secondary rate limit' },
        { status: 403, headers: { 'retry-after': '60' } }
      )
    );

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      { status: 'unavailable', reason: 'github_rate_limited' }
    );
  });

  it('returns stale instead of mixing a file list with a newer PR head', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(
        livePullRequest({
          head: { ref: 'feature/diffs', sha: otherSha, repo: { full_name: 'Kilo-Org/cloud' } },
        })
      )
    );

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      {
        status: 'stale',
        reason: 'pull_request_changed',
        pullRequest: null,
        files: [],
      }
    );
  });

  it('reports a non-GitHub workspace without resolving GitHub authority', async () => {
    const test = fixture({
      workspace: workspace({ repositoryProvider: 'gitlab', gitUrl: 'https://gitlab.com/a/b' }),
      rows: [cachedRow],
    });

    await expect(test.caller.getHostedWorkspacePullRequest({ workspaceId })).resolves.toMatchObject(
      { status: 'not_github', reason: 'unsupported_repository' }
    );
    expect(mocks.resolveAuth).not.toHaveBeenCalled();
  });
});

describe('getHostedWorkspacePullRequestFile', () => {
  it('returns the exact patch for the requested path and head', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(livePullRequest())
    );

    await expect(
      test.caller.getHostedWorkspacePullRequestFile({
        workspaceId,
        path: 'src/app.ts',
        expectedHeadSha: headSha,
      })
    ).resolves.toEqual({
      status: 'available',
      path: 'src/app.ts',
      reason: null,
      omissionReason: null,
      headSha,
      patch: '@@ -1 +1 @@\n-old\n+new\n',
    });
  });

  it('fences the patch on the requested head and reports the live head when it moved', async () => {
    const test = fixture({ rows: [cachedRow] });
    const fetch = fetchMock(jsonResponse(livePullRequest()));

    await expect(
      test.caller.getHostedWorkspacePullRequestFile({
        workspaceId,
        path: 'src/app.ts',
        expectedHeadSha: otherSha,
      })
    ).resolves.toMatchObject({ status: 'stale', headSha, patch: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a patch when the PR head moves during the files fetch', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(
        livePullRequest({
          head: { ref: 'feature/diffs', sha: otherSha, repo: { full_name: 'Kilo-Org/cloud' } },
        })
      )
    );

    await expect(
      test.caller.getHostedWorkspacePullRequestFile({
        workspaceId,
        path: 'src/app.ts',
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({ status: 'stale', headSha: otherSha, patch: null });
  });

  it('uses the cached page index to fetch only the page holding the requested file', async () => {
    const pageOne = Array.from({ length: 50 }, (_, index) => ({
      filename: `src/bulk-${index}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n-first\n+second\n',
    }));
    const pageTwo = [
      {
        filename: 'src/page-two.ts',
        status: 'modified',
        additions: 2,
        deletions: 0,
        patch: '@@ -1 +1 @@\n-a\n+b\n',
      },
    ];
    const test = fixture({ rows: [cachedRow] });
    const fetch = fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(pageOne),
      jsonResponse(pageTwo),
      jsonResponse(livePullRequest())
    );

    await test.caller.getHostedWorkspacePullRequest({ workspaceId });
    expect(fetch).toHaveBeenCalledTimes(4);

    fetch.mockClear();
    fetch.mockResolvedValueOnce(jsonResponse(livePullRequest()));
    fetch.mockResolvedValueOnce(jsonResponse(pageTwo));
    fetch.mockResolvedValueOnce(jsonResponse(livePullRequest()));

    await expect(
      test.caller.getHostedWorkspacePullRequestFile({
        workspaceId,
        path: 'src/page-two.ts',
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({
      status: 'available',
      patch: '@@ -1 +1 @@\n-a\n+b\n',
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[1]?.[0])).toContain('page=2');
  });

  it('keeps a provider-omitted patch explicit', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(livePullRequest())
    );

    await expect(
      test.caller.getHostedWorkspacePullRequestFile({
        workspaceId,
        path: 'src/image.png',
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({
      status: 'omitted',
      omissionReason: 'provider_omitted',
      patch: null,
      headSha,
    });
  });

  it('reports a path that the PR does not list', async () => {
    const test = fixture({ rows: [cachedRow] });
    fetchMock(
      jsonResponse(livePullRequest()),
      jsonResponse(filesPayload),
      jsonResponse(livePullRequest())
    );

    await expect(
      test.caller.getHostedWorkspacePullRequestFile({
        workspaceId,
        path: 'src/missing.ts',
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({ status: 'not_listed', headSha });
  });

  it('carries the linked-PR failure through the per-file read', async () => {
    const test = fixture({ rows: [] });
    const fetch = fetchMock();

    await expect(
      test.caller.getHostedWorkspacePullRequestFile({
        workspaceId,
        path: 'src/app.ts',
        expectedHeadSha: headSha,
      })
    ).resolves.toMatchObject({ status: 'not_linked', reason: 'no_pull_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
