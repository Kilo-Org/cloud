import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';

// Ported from the closed #6405 (its `manual-code-review-jobs.test.ts`) onto the
// implementation kept in #6325, which maps every public-provider round-trip
// failure to a client error instead of letting tRPC answer 500.
const mockIsLocalCodeReviewDevelopmentEnabled = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockAssertCouncilCreationAllowed = jest.fn();
const mockCreateCodeReview = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockGetAllIntegrationsForOwner = jest.fn();
const mockGetIntegrationForOwner = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockFetchGitLabMergeRequest = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getAllIntegrationsForOwner: (...args: unknown[]) => mockGetAllIntegrationsForOwner(...args),
  getIntegrationForOwner: (...args: unknown[]) => mockGetIntegrationForOwner(...args),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (...args: unknown[]) => mockGetValidGitLabToken(...args),
}));

// The adapter's GitLab transport binds the resolved address and bypasses
// global fetch for self-managed hosts, so the connected path stubs the one
// provider read it makes and asserts the call it was given.
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual<object>('@/lib/integrations/platforms/gitlab/adapter'),
  fetchGitLabMergeRequest: (...args: unknown[]) => mockFetchGitLabMergeRequest(...args),
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  isLocalCodeReviewDevelopmentEnabled: () => mockIsLocalCodeReviewDevelopmentEnabled(),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('./core/council-entitlement', () => ({
  assertCouncilCreationAllowed: (...args: unknown[]) => mockAssertCouncilCreationAllowed(...args),
}));

jest.mock('./db/code-reviews', () => ({
  createCodeReview: (...args: unknown[]) => mockCreateCodeReview(...args),
  findActiveProviderPublishingReview: jest.fn(),
}));

jest.mock('./dispatch/dispatch-pending-reviews', () => ({
  tryDispatchPendingReviews: (...args: unknown[]) => mockTryDispatchPendingReviews(...args),
}));

import { createManualCodeReviewJob } from './manual-code-review-jobs';

const OWNER = { type: 'user' as const, id: 'user-1', userId: 'user-1' };

const GITHUB_PR_URL = 'https://github.com/owner/repo/pull/123';
const GITLAB_MR_URL = 'https://gitlab.com/group/project/-/merge_requests/123';

function providerResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'github' as const,
    url: GITHUB_PR_URL,
    modelSlug: 'test-model',
    ...overrides,
  };
}

async function captureError(overrides: Record<string, unknown> = {}): Promise<unknown> {
  try {
    await createManualCodeReviewJob({ owner: OWNER, input: taskInput(overrides) });
    return null;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsLocalCodeReviewDevelopmentEnabled.mockReturnValue(true);
  mockGetAgentConfigForOwner.mockResolvedValue(null);
  mockAssertCouncilCreationAllowed.mockResolvedValue(undefined);
});

describe('createManualCodeReviewJob provider failures', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Every provider round-trip failure must surface as a mapped tRPC error.
  // Before the mapping landed these escaped as raw
  // ProviderFetchError/TypeError/ZodError and tRPC answered
  // INTERNAL_SERVER_ERROR (HTTP 500) — the finding's defect. A provider that is
  // genuinely unreachable maps to 502, which is the correct gateway status and
  // not the reported internal error.
  const cases: Array<{
    name: string;
    fetch: () => void;
    code: TRPCError['code'];
    /** Input overrides for a case whose name names a provider other than GitHub. */
    input?: Record<string, unknown>;
    /** Copy that proves the case ran the provider its name names. */
    message?: string;
  }> = [
    {
      name: 'a missing public pull request maps to NOT_FOUND',
      fetch: () =>
        void jest
          .spyOn(global, 'fetch')
          .mockResolvedValue(providerResponse(404, { message: 'Not Found' })),
      code: 'NOT_FOUND',
    },
    {
      name: 'a rate-limited GitHub maps to TOO_MANY_REQUESTS',
      fetch: () =>
        void jest
          .spyOn(global, 'fetch')
          .mockResolvedValue(providerResponse(403, { message: 'API rate limit exceeded' })),
      code: 'TOO_MANY_REQUESTS',
    },
    {
      name: 'a rate-limited GitLab maps to TOO_MANY_REQUESTS',
      // GitLab reports a rate limit with 429, so the case must run the GitLab
      // path — the default input is a GitHub pull request.
      input: { platform: 'gitlab', url: GITLAB_MR_URL },
      message: 'GitLab rate-limited',
      fetch: () =>
        void jest
          .spyOn(global, 'fetch')
          .mockResolvedValue(providerResponse(429, { message: 'Too Many Requests' })),
      code: 'TOO_MANY_REQUESTS',
    },
    {
      name: 'an unreachable provider maps to BAD_GATEWAY',
      fetch: () =>
        void jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed')),
      code: 'BAD_GATEWAY',
    },
    {
      name: 'an unexpected provider shape maps to BAD_GATEWAY',
      fetch: () =>
        void jest.spyOn(global, 'fetch').mockResolvedValue(providerResponse(200, { nope: true })),
      code: 'BAD_GATEWAY',
    },
    {
      name: 'a provider error status maps to BAD_GATEWAY',
      fetch: () =>
        void jest
          .spyOn(global, 'fetch')
          .mockResolvedValue(providerResponse(500, { message: 'Internal Server Error' })),
      code: 'BAD_GATEWAY',
    },
  ];

  it.each(cases)('$name', async ({ fetch, code, input, message }) => {
    fetch();

    const error = await captureError(input);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe(code);
    if (message) {
      expect((error as TRPCError).message).toContain(message);
    }
    // The finding's defect was tRPC's unmapped INTERNAL_SERVER_ERROR / HTTP 500.
    expect((error as TRPCError).code).not.toBe('INTERNAL_SERVER_ERROR');
    expect(getHTTPStatusCodeFromError(error as TRPCError)).not.toBe(500);
  });

  it('reports an unparseable provider response as unexpected, not unreachable', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'not json',
      json: async () => JSON.parse('not json'),
    } as unknown as Response);

    const error = await captureError();

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_GATEWAY');
    expect((error as TRPCError).message).toContain('unexpected response');
    expect((error as TRPCError).message).not.toContain('Could not reach');
    // The original parse error is kept as the cause rather than dropped.
    expect(((error as TRPCError).cause as Error | undefined)?.message).toContain('JSON');
  });

  it('names the GitLab merge request, never a pull request, in a GitLab failure', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(providerResponse(404, { message: 'Not Found' }));

    const error = await captureError({ platform: 'gitlab', url: GITLAB_MR_URL });

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('NOT_FOUND');
    expect((error as TRPCError).message).toContain('GitLab');
    expect((error as TRPCError).message).toContain('merge request');
    expect((error as TRPCError).message).not.toContain('pull request');
  });

  // GitLab returns 429 for rate limits; a 403 is a permission error and must not
  // be reported to the user as a rate limit.
  it('does not map a public GitLab 403 to a rate-limit error', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(providerResponse(403, { message: 'Forbidden' }));

    const error = await captureError({ platform: 'gitlab', url: GITLAB_MR_URL });

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_GATEWAY');
    expect((error as TRPCError).message).toContain('unexpected response');
    expect((error as TRPCError).message).not.toContain('rate-limited');
  });
});

describe('createManualCodeReviewJob connected GitLab source', () => {
  const INSTANCE_URL = 'https://gitlab.example.com';
  const PROJECT_PATH = 'group/project';
  const MR_URL = `${INSTANCE_URL}/${PROJECT_PATH}/-/merge_requests/7`;

  const orgOwner = { type: 'org' as const, id: 'org-1', userId: 'bot-1' };

  function gitlabIntegration() {
    return {
      id: 'gitlab-integration-1',
      platform: 'gitlab',
      integration_status: 'active',
      owned_by_user_id: OWNER.id,
      owned_by_organization_id: null,
      repositories: [
        { id: 501, name: 'project', full_name: PROJECT_PATH, private: true },
        { id: 502, name: 'other', full_name: 'group/other', private: false },
      ],
      metadata: { gitlab_instance_url: INSTANCE_URL },
    };
  }

  function mergeRequest(overrides: Record<string, unknown> = {}) {
    return {
      iid: 7,
      title: 'Harden the thing',
      state: 'opened',
      draft: false,
      source_branch: 'feature',
      target_branch: 'main',
      sha: 'sha-7',
      web_url: MR_URL,
      author: { username: 'gl-user' },
      // The provider's ids differ from the cached repository id (501) so the
      // assertion pins which id the review row stores.
      project_id: 999,
      target_project_id: 999,
      ...overrides,
    };
  }

  function gitlabJob(url: string) {
    return { platform: 'gitlab' as const, url, modelSlug: 'test-model' };
  }

  beforeEach(() => {
    mockIsLocalCodeReviewDevelopmentEnabled.mockReturnValue(false);
    mockGetAllIntegrationsForOwner.mockResolvedValue([gitlabIntegration()]);
    mockGetIntegrationForOwner.mockResolvedValue(gitlabIntegration());
    mockGetValidGitLabToken.mockResolvedValue('glpat-token');
    mockFetchGitLabMergeRequest.mockResolvedValue(mergeRequest());
    mockCreateCodeReview.mockResolvedValue('review-gitlab');
  });

  it('starts a review for a project inside the connection repository scope', async () => {
    await expect(
      createManualCodeReviewJob({ owner: OWNER, input: gitlabJob(MR_URL) })
    ).resolves.toEqual({ reviewId: 'review-gitlab', outputMode: 'provider' });

    expect(mockGetValidGitLabToken).toHaveBeenCalledWith(gitlabIntegration(), {
      userId: OWNER.userId,
    });
    expect(mockFetchGitLabMergeRequest).toHaveBeenCalledWith({
      accessToken: 'glpat-token',
      projectId: PROJECT_PATH,
      mrIid: 7,
      instanceUrl: INSTANCE_URL,
    });
    expect(mockCreateCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'gitlab',
        platformIntegrationId: 'gitlab-integration-1',
        repoFullName: PROJECT_PATH,
        platformProjectId: 501,
        prNumber: 7,
        prUrl: MR_URL,
        prAuthor: 'gl-user',
        baseRef: 'main',
        headRef: 'refs/merge-requests/7/head',
        headSha: 'sha-7',
      })
    );
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith(OWNER);
  });

  it('refuses a project outside the connection repository scope before any credential or provider call', async () => {
    const error = await captureError(
      gitlabJob(`${INSTANCE_URL}/other-org/private-project/-/merge_requests/1`)
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('NOT_FOUND');
    // The refusal happens before the connection's credential is minted or a
    // provider request is made: no token, no read, no review row, no dispatch.
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabMergeRequest).not.toHaveBeenCalled();
    expect(mockCreateCodeReview).not.toHaveBeenCalled();
    expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
  });

  it('matches the cached project path case-insensitively and reads only the canonical path', async () => {
    const shoutyUrl = `${INSTANCE_URL}/GROUP/Project/-/merge_requests/7`;

    await expect(
      createManualCodeReviewJob({ owner: OWNER, input: gitlabJob(shoutyUrl) })
    ).resolves.toEqual({ reviewId: 'review-gitlab', outputMode: 'provider' });

    expect(mockFetchGitLabMergeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_PATH })
    );
    expect(mockCreateCodeReview).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: PROJECT_PATH })
    );
  });

  it('refuses a merge request URL on an instance other than the connected one', async () => {
    const error = await captureError(
      gitlabJob(`https://gitlab.com/${PROJECT_PATH}/-/merge_requests/7`)
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('NOT_FOUND');
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabMergeRequest).not.toHaveBeenCalled();
  });

  it('keeps the connect-GitLab precondition when the owner has no active GitLab connection', async () => {
    mockGetAllIntegrationsForOwner.mockResolvedValue([]);

    const error = await captureError(gitlabJob(MR_URL));

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((error as TRPCError).message).toContain('Connect GitLab');
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
  });

  it('maps a refused merge request read to a client error instead of a 500', async () => {
    mockFetchGitLabMergeRequest.mockRejectedValue(new Error('GitLab MR fetch failed: 404'));

    const error = await captureError(gitlabJob(MR_URL));

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('NOT_FOUND');
    expect(mockCreateCodeReview).not.toHaveBeenCalled();
    expect(mockTryDispatchPendingReviews).not.toHaveBeenCalled();
  });

  it('maps a refused credential on the merge request read to the reconnect state', async () => {
    mockFetchGitLabMergeRequest.mockRejectedValue(new Error('GitLab MR fetch failed: 401'));

    const error = await captureError(gitlabJob(MR_URL));

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((error as TRPCError).message).toMatch(/reconnect/i);
    expect(mockCreateCodeReview).not.toHaveBeenCalled();
  });

  it('passes the organization credential actor for an organization-owned connection', async () => {
    mockGetAllIntegrationsForOwner.mockResolvedValue([
      { ...gitlabIntegration(), owned_by_user_id: null, owned_by_organization_id: 'org-1' },
    ]);
    mockGetIntegrationForOwner.mockResolvedValue({
      ...gitlabIntegration(),
      owned_by_user_id: null,
      owned_by_organization_id: 'org-1',
    });

    await expect(
      createManualCodeReviewJob({ owner: orgOwner, input: gitlabJob(MR_URL) })
    ).resolves.toEqual({ reviewId: 'review-gitlab', outputMode: 'provider' });

    expect(mockGetIntegrationForOwner).toHaveBeenCalledWith({ type: 'org', id: 'org-1' }, 'gitlab');
    expect(mockGetValidGitLabToken).toHaveBeenCalledWith(expect.anything(), {
      userId: 'bot-1',
      organizationId: 'org-1',
    });
  });
});

describe('createManualCodeReviewJob happy path', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates the job from a public pull request and dispatches pending reviews', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      providerResponse(200, {
        number: 123,
        html_url: GITHUB_PR_URL,
        title: 'Fix the thing',
        state: 'open',
        draft: false,
        user: { login: 'octocat', id: 1 },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        head: { ref: 'feature', sha: 'abc123' },
      })
    );
    mockCreateCodeReview.mockResolvedValue('review-1');

    await expect(createManualCodeReviewJob({ owner: OWNER, input: taskInput() })).resolves.toEqual({
      reviewId: 'review-1',
      outputMode: 'kilo',
    });
    expect(mockTryDispatchPendingReviews).toHaveBeenCalledWith(OWNER);
  });
});
