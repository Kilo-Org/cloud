/**
 * Tests for `fetchBatchReviewDecisions` / `fetchPullRequestReviewDecision` in
 * `adapter.ts`.
 *
 * The adapter module is globally mocked via the jest `moduleNameMapper` entry
 * for `@/lib/integrations/platforms/github/adapter`. We bypass that by importing
 * via a relative path, then mock `@octokit/rest` and the installation-token
 * generation so we never hit real GitHub.
 *
 * Two invariants live here. First, the GraphQL wire response: `octokit.request`
 * returns `{ data: <HTTP body>, ... }` where the HTTP body for GraphQL is
 * `{ data: <graphql data>, errors: [...] }`, so the payload is at
 * `response.data.data`. Second, the request body: repository coordinates and PR
 * numbers travel as operation variables, and the query text holds only fixed
 * literals plus the generated `pr<N>` aliases.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockRequest = jest.fn();

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    request: mockRequest,
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({ token: 'mock-token', expiresAt: '2099-01-01' })),
}));

import {
  fetchBatchedReviewDecisions,
  fetchPullRequestReviewDecision,
  GitHubGraphQlError,
  GitHubRateLimitError,
} from './adapter';

beforeEach(() => {
  mockRequest.mockReset();
});

type GraphQlRequestBody = {
  query: string;
  variables: Record<string, string | number>;
};

function postedGraphQlBody(): GraphQlRequestBody {
  expect(mockRequest).toHaveBeenCalledTimes(1);
  const [route, body] = mockRequest.mock.calls[0] as [string, GraphQlRequestBody];
  expect(route).toBe('POST /graphql');
  return body;
}

function wireResponse(reviewDecision: string | null) {
  return {
    status: 200,
    data: {
      data: {
        pr0: {
          pullRequest: { reviewDecision },
        },
      },
    },
  };
}

function batchWireResponse(data: Record<string, unknown>) {
  return { status: 200, data: { data } };
}

describe('fetchPullRequestReviewDecision', () => {
  const params = {
    installationId: '42',
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    appType: 'standard' as const,
  };

  it('maps APPROVED → "approved"', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse('APPROVED'));
    expect(await fetchPullRequestReviewDecision(params)).toBe('approved');
  });

  it('maps CHANGES_REQUESTED → "changes_requested"', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse('CHANGES_REQUESTED'));
    expect(await fetchPullRequestReviewDecision(params)).toBe('changes_requested');
  });

  it('maps REVIEW_REQUIRED → "review_required"', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse('REVIEW_REQUIRED'));
    expect(await fetchPullRequestReviewDecision(params)).toBe('review_required');
  });

  it('returns null when reviewDecision is null (no required reviewers)', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse(null));
    expect(await fetchPullRequestReviewDecision(params)).toBeNull();
  });

  it('returns null for an unrecognised reviewDecision value', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse('COMMENTED'));
    expect(await fetchPullRequestReviewDecision(params)).toBeNull();
  });

  it('returns null when pullRequest is null (PR not found)', async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      data: { data: { pr0: { pullRequest: null } } },
    });
    expect(await fetchPullRequestReviewDecision(params)).toBeNull();
  });

  it('returns null when repository is null', async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      data: { data: { pr0: null } },
    });
    expect(await fetchPullRequestReviewDecision(params)).toBeNull();
  });

  it('carries the repository coordinates as operation variables', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse('APPROVED'));

    await fetchPullRequestReviewDecision(params);

    const { query, variables } = postedGraphQlBody();
    expect(variables).toEqual({ owner0: 'acme', name0: 'widgets', number0: 7 });
    expect(query).not.toContain('acme');
    expect(query).not.toContain('widgets');
    expect(query).toContain('repository(owner: $owner0, name: $name0)');
    expect(query).toContain('pullRequest(number: $number0)');
  });

  it('returns null without a request when a coordinate is outside the name charset', async () => {
    expect(await fetchPullRequestReviewDecision({ ...params, owner: 'acme.corp' })).toBeNull();
    expect(await fetchPullRequestReviewDecision({ ...params, repo: 'widgets[1]' })).toBeNull();
    expect(await fetchPullRequestReviewDecision({ ...params, owner: '' })).toBeNull();
    expect(await fetchPullRequestReviewDecision({ ...params, repo: '' })).toBeNull();

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects with GitHubGraphQlError when the body reports errors and no data', async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        data: null,
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }],
      },
    });

    await expect(fetchPullRequestReviewDecision(params)).rejects.toBeInstanceOf(GitHubGraphQlError);
  });

  it('rejects instead of returning partial data when the body reports errors', async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        data: { pr0: { pullRequest: { reviewDecision: 'APPROVED' } } },
        errors: [{ type: 'INTERNAL', message: 'Something went wrong' }],
      },
    });

    await expect(fetchPullRequestReviewDecision(params)).rejects.toBeInstanceOf(GitHubGraphQlError);
  });

  it('rejects with GitHubRateLimitError on a GraphQL rate limit with exhausted headers', async () => {
    const resetSeconds = Math.floor(Date.parse('2026-01-01T00:05:00.000Z') / 1000);
    mockRequest.mockResolvedValueOnce({
      status: 200,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetSeconds),
      },
      data: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
    });

    const error = await fetchPullRequestReviewDecision(params).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt).toEqual(new Date(resetSeconds * 1000));
  });
});

describe('fetchBatchedReviewDecisions', () => {
  it('maps results back to the caller aliases and keeps aliases out of the query text', async () => {
    mockRequest.mockResolvedValueOnce(
      batchWireResponse({
        pr0: { pullRequest: { reviewDecision: 'APPROVED' } },
        pr1: { pullRequest: null },
      })
    );

    const unusualAlias = 'branch 4 (older)';
    const decisions = await fetchBatchedReviewDecisions({
      installationId: '42',
      prs: [
        { alias: 'older-branch', owner: 'acme', repo: 'widgets', number: 3 },
        { alias: unusualAlias, owner: 'acme', repo: 'gadgets', number: 4 },
      ],
    });

    expect(decisions.get('older-branch')).toBe('approved');
    expect(decisions.get(unusualAlias)).toBeNull();

    const { query, variables } = postedGraphQlBody();
    expect(variables).toEqual({
      owner0: 'acme',
      name0: 'widgets',
      number0: 3,
      owner1: 'acme',
      name1: 'gadgets',
      number1: 4,
    });
    expect(query).not.toContain(unusualAlias);
    expect(query).not.toContain('older-branch');
    expect(query.match(/repository\(owner: \$owner\d, name: \$name\d\)/g)).toEqual([
      'repository(owner: $owner0, name: $name0)',
      'repository(owner: $owner1, name: $name1)',
    ]);
  });

  it('leaves entries with an out-of-charset coordinate out of the query', async () => {
    mockRequest.mockResolvedValueOnce(
      batchWireResponse({ pr0: { pullRequest: { reviewDecision: 'REVIEW_REQUIRED' } } })
    );

    const decisions = await fetchBatchedReviewDecisions({
      installationId: '42',
      prs: [
        { alias: 'ok', owner: 'acme', repo: 'widgets', number: 9 },
        { alias: 'dotted', owner: 'acme.corp', repo: 'widgets', number: 10 },
        { alias: 'spaced', owner: 'acme', repo: 'wid gets', number: 11 },
      ],
    });

    expect([...decisions.keys()]).toEqual(['ok']);
    expect(decisions.get('ok')).toBe('review_required');
    expect(postedGraphQlBody().variables).toEqual({
      owner0: 'acme',
      name0: 'widgets',
      number0: 9,
    });
  });

  it('leaves entries whose PR number the API cannot express out of the query', async () => {
    mockRequest.mockResolvedValueOnce(
      batchWireResponse({ pr0: { pullRequest: { reviewDecision: 'CHANGES_REQUESTED' } } })
    );

    const decisions = await fetchBatchedReviewDecisions({
      installationId: '42',
      prs: [
        { alias: 'ok', owner: 'acme', repo: 'widgets', number: 12 },
        { alias: 'zero', owner: 'acme', repo: 'widgets', number: 0 },
        { alias: 'fractional', owner: 'acme', repo: 'widgets', number: 1.5 },
        { alias: 'too-large', owner: 'acme', repo: 'widgets', number: 2_147_483_648 },
        { alias: 'not-a-number', owner: 'acme', repo: 'widgets', number: Number.NaN },
      ],
    });

    expect([...decisions.keys()]).toEqual(['ok']);
    expect(decisions.get('ok')).toBe('changes_requested');
    expect(postedGraphQlBody().variables).toEqual({
      owner0: 'acme',
      name0: 'widgets',
      number0: 12,
    });
  });

  it('rejects when data omits a requested alias', async () => {
    mockRequest.mockResolvedValueOnce(
      batchWireResponse({ pr0: { pullRequest: { reviewDecision: 'APPROVED' } } })
    );

    await expect(
      fetchBatchedReviewDecisions({
        installationId: '42',
        prs: [
          { alias: 'present', owner: 'acme', repo: 'widgets', number: 5 },
          { alias: 'missing', owner: 'acme', repo: 'widgets', number: 6 },
        ],
      })
    ).rejects.toBeInstanceOf(GitHubGraphQlError);
  });

  it('rejects when the body carries no data key', async () => {
    mockRequest.mockResolvedValueOnce({ status: 200, data: {} });

    await expect(
      fetchBatchedReviewDecisions({
        installationId: '42',
        prs: [{ alias: 'only', owner: 'acme', repo: 'widgets', number: 8 }],
      })
    ).rejects.toBeInstanceOf(GitHubGraphQlError);
  });

  it('makes no request when no entry is actionable', async () => {
    const decisions = await fetchBatchedReviewDecisions({
      installationId: '42',
      prs: [
        { alias: 'a', owner: 'acme.corp', repo: 'widgets', number: 1 },
        { alias: 'b', owner: 'acme', repo: '', number: 2 },
      ],
    });

    expect(decisions.size).toBe(0);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
