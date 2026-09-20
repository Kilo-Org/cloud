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

jest.mock('@/lib/config.server', () => ({
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

  it.each(cases)('$name', async ({ fetch, code }) => {
    fetch();

    const error = await captureError();

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe(code);
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
