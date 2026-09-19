import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';

const mockIsLocalCodeReviewDevelopmentEnabled = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockAssertCouncilCreationAllowed = jest.fn();
const mockCreateCodeReview = jest.fn();
const mockTryDispatchPendingReviews = jest.fn();
const mockGetAllIntegrationsForOwner = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockFetchGitLabMergeRequest = jest.fn();

jest.mock('@/lib/config.server', () => ({
  isLocalCodeReviewDevelopmentEnabled: () => mockIsLocalCodeReviewDevelopmentEnabled(),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('./core/council-entitlement', () => ({
  assertCouncilCreationAllowed: (...args: unknown[]) => mockAssertCouncilCreationAllowed(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getAllIntegrationsForOwner: (...args: unknown[]) => mockGetAllIntegrationsForOwner(...args),
  getIntegrationForOwner: jest.fn(),
  updateIntegrationMetadataForOwner: jest.fn(),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (...args: unknown[]) => mockGetValidGitLabToken(...args),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabMergeRequest: (...args: unknown[]) => mockFetchGitLabMergeRequest(...args),
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
  // genuinely unreachable maps to 502/504, which is the correct gateway status
  // and not the reported internal error.
  const cases: Array<{
    name: string;
    fetch: () => void;
    code: TRPCError['code'];
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
      name: 'an unreachable provider maps to BAD_GATEWAY',
      fetch: () =>
        void jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed')),
      code: 'BAD_GATEWAY',
    },
    {
      name: 'a provider timeout maps to GATEWAY_TIMEOUT',
      fetch: () => {
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        void jest.spyOn(global, 'fetch').mockRejectedValue(timeout);
      },
      code: 'GATEWAY_TIMEOUT',
    },
    {
      name: 'an unexpected provider shape maps to BAD_GATEWAY',
      fetch: () =>
        void jest.spyOn(global, 'fetch').mockResolvedValue(providerResponse(200, { nope: true })),
      code: 'BAD_GATEWAY',
    },
  ];

  it.each(cases)('$name', async ({ fetch, code }) => {
    fetch();

    const error = await captureError();

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe(code);
    // The finding's defect was tRPC's unmapped INTERNAL_SERVER_ERROR / HTTP 500.
    expect((error as TRPCError).code).not.toBe('INTERNAL_SERVER_ERROR');
    expect(getHTTPStatusCodeFromError(error as TRPCError)).not.toBe(500);
  });
});

describe('createManualCodeReviewJob connected GitLab failures', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps an unreadable merge request from the connected instance to a client error', async () => {
    mockIsLocalCodeReviewDevelopmentEnabled.mockReturnValue(false);
    mockGetAllIntegrationsForOwner.mockResolvedValue([
      {
        id: 'integration-1',
        platform: 'gitlab',
        integration_status: 'active',
        metadata: { gitlab_instance_url: 'https://gitlab.com' },
        repositories: [],
      },
    ]);
    mockGetValidGitLabToken.mockResolvedValue('token');
    // The GitLab adapter throws a plain Error whose message ends with the status.
    mockFetchGitLabMergeRequest.mockRejectedValue(new Error('GitLab MR fetch failed: 404'));

    const error = await captureError({ platform: 'gitlab', url: GITLAB_MR_URL });

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('NOT_FOUND');
    expect(getHTTPStatusCodeFromError(error as TRPCError)).not.toBe(500);
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
