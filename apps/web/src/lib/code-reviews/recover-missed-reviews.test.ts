/* eslint-disable @typescript-eslint/no-explicit-any */
// The sweep asserts branch behaviour, so the wide-signature collaborators are
// mocked while the real webhook handler decides the review-start verdict.
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => mockSelectIntegrations(),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve([]),
    }),
    transaction: async (fn: any) =>
      fn({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) }),
  },
}));

const mockSelectIntegrations = jest.fn<Promise<any[]>, unknown[]>();
const mockFetchOpenPullRequests = jest.fn<Promise<OpenPullRequest[]>, unknown[]>();
const mockFindExistingReview = jest.fn<Promise<any>, unknown[]>();
const mockFindActiveReviews = jest.fn<Promise<string[]>, unknown[]>();
const mockGetBotUserId = jest.fn<Promise<string | null>, unknown[]>();
const mockAssertAuthorized = jest.fn<Promise<void>, unknown[]>();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchOpenPullRequests: (params: unknown) => mockFetchOpenPullRequests(params),
}));

let handlerVerdict: 'started' | 'skipped' = 'started';

const mockHandlerResponse = (): { json: () => Promise<Record<string, unknown>> } => ({
  json: async () =>
    handlerVerdict === 'started'
      ? { message: 'Code review queued', reviewId: 'review-new' }
      : { message: 'Code review agent not enabled for this repository' },
});

const mockHandlePullRequestCodeReview = jest.fn<
  Promise<{ json: () => Promise<Record<string, unknown>> }>,
  unknown[]
>(async () => mockHandlerResponse());

jest.mock('@/lib/integrations/platforms/github/webhook-handlers/pull-request-handler', () => ({
  handlePullRequestCodeReview: (...args: unknown[]) => mockHandlePullRequestCodeReview(...args),
}));

jest.mock('@/lib/code-reviews/db/code-reviews', () => {
  const actual = jest.requireActual('@/lib/code-reviews/db/code-reviews');
  return {
    ...actual,
    findExistingReview: (...args: unknown[]) => mockFindExistingReview(...args),
    findActiveReviewsForPR: (...args: unknown[]) => mockFindActiveReviews(...args),
    createCodeReview: async () => {
      throw new Error('createCodeReview must not be reached; the handler mock decides');
    },
    updateCheckRunId: async () => undefined,
  };
});

// The council entitlement is a prerequisite lookup the handler may extend;
// kept as a stub so an added call stays a stub rather than a live lookup.
jest.mock('@/lib/code-reviews/core/council-entitlement', () => ({
  isCouncilEntitledForOwner: async () => false,
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: (organizationId: string, botType: string) =>
    mockGetBotUserId(organizationId, botType),
}));

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: (...args: unknown[]) => mockAssertAuthorized(...args),
  GitHubRuntimeAuthorizationError: class extends Error {
    constructor() {
      super('runtime authorization unavailable');
      this.name = 'GitHubRuntimeAuthorizationError';
    }
  },
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/code-reviews/action-required', () => ({
  getCodeReviewActionRequiredState: () => false,
}));

jest.mock('@/lib/code-reviews/review-memory/github-feedback', () => ({
  handleGitHubReviewCommentReply: async () => undefined,
}));

import type { PlatformIntegration } from '@kilocode/db/schema';
import type { OpenPullRequest } from '@/lib/integrations/platforms/github/adapter';
import {
  recoverMissedReviews,
  RECOVER_MISSED_REVIEWS_LOOKBACK_HOURS,
  RECOVER_MISSED_REVIEWS_REPO_LIMIT,
  RECOVER_MISSED_REVIEWS_START_LIMIT,
} from './recover-missed-reviews';

const FROZEN_NOW = new Date('2026-11-09T12:00:00Z');
const CUTOFF_MS = FROZEN_NOW.getTime() - RECOVER_MISSED_REVIEWS_LOOKBACK_HOURS * 60 * 60 * 1000;
const ORG_ID = '00000000-0000-4000-8000-0000000000aa';
const INTEGRATION_ID = '00000000-0000-4000-8000-000000000001';

function isFetchParams(
  value: unknown
): value is { installationId: string; owner: string; repo: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.installationId === 'string' &&
    typeof candidate.owner === 'string' &&
    typeof candidate.repo === 'string'
  );
}

function fetchParams(value: unknown): { installationId: string; owner: string; repo: string } {
  if (!isFetchParams(value)) throw new Error(`Unexpected list input: ${String(value)}`);
  return value;
}

function makeIntegration(overrides: Record<string, unknown> = {}): PlatformIntegration {
  return {
    id: INTEGRATION_ID,
    platform: 'github',
    integration_type: 'app',
    integration_status: 'active',
    platform_installation_id: '123456',
    github_app_type: 'standard',
    owned_by_organization_id: ORG_ID,
    owned_by_user_id: null,
    platform_account_login: 'acme',
    repositories: [
      {
        id: 501,
        name: 'widgets',
        full_name: 'acme/widgets',
        clone_url: 'https://github.com/acme/widgets.git',
      },
    ],
    suspended_at: null,
    auth_invalid_at: null,
    github_disconnected_at: null,
    ...overrides,
  } as unknown as PlatformIntegration; // A partial platform_integrations row; the sweep reads only the fields above.
}

function makePull(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 7,
    title: 'Add a safer widget',
    body: 'Body',
    draft: false,
    htmlUrl: 'https://github.com/acme/widgets/pull/7',
    createdAt: new Date(FROZEN_NOW.getTime() - 600_000).toISOString(),
    updatedAt: new Date(FROZEN_NOW.getTime() - 300_000).toISOString(),
    authorId: 9001,
    authorLogin: 'person',
    authorAvatarUrl: 'https://avatars.githubusercontent.com/u/9001',
    authorType: 'User',
    labels: [],
    headSha: 'abc123',
    headRef: 'feature',
    headRepoFullName: 'acme/widgets',
    headRepoCloneUrl: 'https://github.com/acme/widgets.git',
    headRepoHtmlUrl: 'https://github.com/acme/widgets',
    baseSha: 'def456',
    baseRef: 'main',
    baseRepoId: 501,
    baseRepoName: 'widgets',
    baseRepoFullName: 'acme/widgets',
    ...overrides,
  } as OpenPullRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectIntegrations.mockResolvedValue([makeIntegration()]);
  mockFetchOpenPullRequests.mockResolvedValue([makePull()]);
  mockFindExistingReview.mockResolvedValue(null);
  mockFindActiveReviews.mockResolvedValue([]);
  mockGetBotUserId.mockResolvedValue('bot-user-1');
  mockAssertAuthorized.mockResolvedValue();
  handlerVerdict = 'started';
  mockHandlePullRequestCodeReview.mockClear();
});

describe('recoverMissedReviews', () => {
  it('hands a pull request without a review row to the webhook handler once per head', async () => {
    const first = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(first).toMatchObject({
      repositoriesConsidered: 1,
      pullRequestsConsidered: 1,
      reviewsStarted: 1,
      refusedByHandler: 0,
      providerFailures: 0,
    });
    expect(mockHandlePullRequestCodeReview).toHaveBeenCalledTimes(1);
    const [payload, integration] = mockHandlePullRequestCodeReview.mock.calls[0];
    expect(payload).toMatchObject({
      action: 'opened',
      pull_request: {
        number: 7,
        draft: false,
        user: { login: 'person', type: 'User' },
        labels: [],
        head: { sha: 'abc123', ref: 'feature', repo: { full_name: 'acme/widgets' } },
        base: { sha: 'def456', ref: 'main' },
      },
      repository: { id: 501, full_name: 'acme/widgets', owner: { login: 'acme' } },
      installation: { id: 123456 },
    });
    expect((integration as PlatformIntegration).id).toBe(INTEGRATION_ID);
    expect(fetchParams(mockFetchOpenPullRequests.mock.calls[0][0])).toEqual(
      expect.objectContaining({ installationId: '123456', owner: 'acme', repo: 'widgets' })
    );

    // Idempotent: a review row for the head short-circuits the next run.
    mockFindExistingReview.mockResolvedValue({ id: 'review-new' });
    const second = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(second).toMatchObject({ reviewsStarted: 0, skippedExisting: 1 });
    expect(mockHandlePullRequestCodeReview).toHaveBeenCalledTimes(1);
  });

  it('counts a refusal the handler returns without creating a review row', async () => {
    handlerVerdict = 'skipped';
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ refusedByHandler: 1, reviewsStarted: 0 });
  });

  it('skips a draft pull request before the review lookup', async () => {
    mockFetchOpenPullRequests.mockResolvedValue([makePull({ draft: true })]);
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ skippedDraft: 1, reviewsStarted: 0 });
    expect(mockFindExistingReview).not.toHaveBeenCalled();
  });

  it('skips a pull request updated before the lookback window', async () => {
    mockFetchOpenPullRequests.mockResolvedValue([
      makePull({ updatedAt: new Date(CUTOFF_MS - 1).toISOString() }),
    ]);
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ skippedStale: 1, reviewsStarted: 0 });
    expect(mockFindExistingReview).not.toHaveBeenCalled();
  });

  it('starts nothing when a review is still active for the pull request', async () => {
    mockFindActiveReviews.mockResolvedValue(['review-active']);
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ skippedActiveReview: 1, reviewsStarted: 0 });
    expect(mockHandlePullRequestCodeReview).not.toHaveBeenCalled();
  });

  it('skips an installation whose runtime has not authorized the association', async () => {
    const { GitHubRuntimeAuthorizationError } = jest.requireMock(
      '@/lib/integrations/github/runtime-authorization'
    ) as { GitHubRuntimeAuthorizationError: new () => Error };
    mockAssertAuthorized.mockRejectedValue(new GitHubRuntimeAuthorizationError());

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ integrationsUnavailable: 1, reviewsStarted: 0 });
    expect(mockFetchOpenPullRequests).not.toHaveBeenCalled();
  });

  it('reports an unexpected runtime failure as a provider failure and keeps going', async () => {
    mockAssertAuthorized.mockRejectedValue(new Error('network unreachable'));
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ providerFailures: 1, integrationsUnavailable: 0 });
  });

  it('skips an organization without a code-review bot user', async () => {
    mockGetBotUserId.mockResolvedValue(null);
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ skippedWithoutOwner: 1, reviewsStarted: 0 });
    expect(mockFetchOpenPullRequests).not.toHaveBeenCalled();
  });

  it('leaves a repository entry without a numeric platform id unswept', async () => {
    const [repository] = makeIntegration().repositories as any[];
    mockSelectIntegrations.mockResolvedValue([
      makeIntegration({
        repositories: [repository, { ...repository, id: '902', full_name: 'acme/gears' }],
      }),
    ]);

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ repositoriesConsidered: 1, reviewsStarted: 1 });
    expect(mockFetchOpenPullRequests.mock.calls.map(call => fetchParams(call[0]).repo)).toEqual([
      'widgets',
    ]);
  });

  it('reports one repository failure and still recovers the other repositories', async () => {
    mockSelectIntegrations.mockResolvedValue([
      makeIntegration({
        repositories: [
          { id: 501, name: 'widgets', full_name: 'acme/widgets' },
          { id: 502, name: 'gadgets', full_name: 'acme/gadgets' },
        ],
      }),
    ]);
    mockFetchOpenPullRequests.mockImplementation(async value => {
      if (fetchParams(value).repo === 'widgets') throw new Error('rate limited');
      return [
        makePull({
          number: 8,
          headSha: 'sha-gadgets',
          baseRepoName: 'gadgets',
          baseRepoFullName: 'acme/gadgets',
          headRepoFullName: 'acme/gadgets',
        }),
      ];
    });

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({
      providerFailures: 1,
      repositoriesConsidered: 2,
      reviewsStarted: 1,
    });
  });

  it('stops starting reviews at the per-run limit and counts the remainder', async () => {
    const pulls: OpenPullRequest[] = [];
    for (let index = 0; index < RECOVER_MISSED_REVIEWS_START_LIMIT + 3; index += 1) {
      pulls.push(makePull({ number: 10 + index, headSha: `sha-${index}` }));
    }
    mockFetchOpenPullRequests.mockResolvedValue(pulls);

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary.reviewsStarted).toBe(RECOVER_MISSED_REVIEWS_START_LIMIT);
    expect(summary.skippedStartLimit).toBe(3);
    expect(mockHandlePullRequestCodeReview).toHaveBeenCalledTimes(
      RECOVER_MISSED_REVIEWS_START_LIMIT
    );
  });

  it('reads at most the repository limit and rotates the window across runs', async () => {
    const repositories = Array.from(
      { length: RECOVER_MISSED_REVIEWS_REPO_LIMIT * 2 + 5 },
      (_, index) => {
        const name = `repo-${String(index).padStart(3, '0')}`;
        return { id: 700 + index, name, full_name: `acme/${name}` };
      }
    );
    mockSelectIntegrations.mockResolvedValue([makeIntegration({ repositories })]);

    const fetched: string[][] = [];
    for (let runIndex = 0; runIndex < 3; runIndex += 1) {
      const now = new Date(FROZEN_NOW.getTime() + runIndex * 15 * 60 * 1000);
      const seen: string[] = [];
      mockFetchOpenPullRequests.mockImplementation(async value => {
        seen.push(fetchParams(value).repo);
        return [];
      });
      const summary = await recoverMissedReviews({ now });
      if (runIndex < 2) {
        expect(summary.repositoriesConsidered).toBe(RECOVER_MISSED_REVIEWS_REPO_LIMIT);
      } else {
        expect(summary.repositoriesConsidered).toBe(5);
      }
      fetched.push(seen);
    }

    expect(fetched[0].length).toBe(RECOVER_MISSED_REVIEWS_REPO_LIMIT);
    expect(fetched[1].length).toBe(RECOVER_MISSED_REVIEWS_REPO_LIMIT);
    expect(new Set(fetched[0]).intersection(new Set(fetched[1])).size).toBe(0);
    // The third run closes the rotation: both windows plus the remainder cover
    // every installed repository exactly once.
    expect(fetched[2].length).toBe(5);
    const covered = new Set([...fetched[0], ...fetched[1], ...fetched[2]]);
    expect(covered.size).toBe(RECOVER_MISSED_REVIEWS_REPO_LIMIT * 2 + 5);
  });
});
