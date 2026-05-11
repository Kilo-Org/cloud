/**
 * Tests for `fetchPullRequestReviewDecision` in `adapter.ts`.
 *
 * The adapter module is globally mocked via the jest `moduleNameMapper` entry
 * for `@/lib/integrations/platforms/github/adapter`. We bypass that by importing
 * via a relative path, then mock `@octokit/rest` and the installation-token
 * generation so we never hit real GitHub.
 *
 * The key invariant tested here is the GraphQL wire-response unwrapping:
 * `octokit.request('POST /graphql')` returns `{ data: <HTTP body>, ... }` where
 * the HTTP body for GraphQL is `{ data: <graphql data>, errors: [...] }`.
 * The actual payload is therefore at `response.data.data`, not `response.data`.
 *
 * `fetchPullRequestReviewDecision` delegates to `fetchBatchedReviewDecisions`
 * with a single alias `pr0`, so the GraphQL response fields are keyed by
 * alias rather than the literal `repository` field name.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockRequest = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    request: mockRequest,
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({ token: 'mock-token', expiresAt: '2099-01-01' })),
}));

import { fetchPullRequestReviewDecision } from './adapter';

beforeEach(() => {
  mockRequest.mockReset();
});

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
});
