/* eslint-disable @typescript-eslint/no-explicit-any */
// The sweep asserts branch behaviour, so the wide-signature collaborators are
// mocked while the real webhook handler decides the review-start verdict.
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    // Raw SQL reads go through execute; the query builder reads through select.
    execute: (...args: unknown[]) => mockDbExecute(...args),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(mockSelectIntegrations()),
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
const mockDbExecute = jest.fn<Promise<{ rows: any[] }>, unknown[]>();
const mockFetchOpenPullRequests = jest.fn<Promise<OpenPullRequest[]>, unknown[]>();
const mockFindExistingReview = jest.fn<Promise<any>, unknown[]>();
const mockFindActiveReviews = jest.fn<Promise<string[]>, unknown[]>();
const mockGetBotUserId = jest.fn<Promise<string | null>, unknown[]>();
const mockAssertAuthorized = jest.fn<Promise<void>, unknown[]>();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchOpenPullRequests: (params: unknown) => mockFetchOpenPullRequests(params),
}));

let handlerVerdict: 'started' | 'skipped' | 'failed' = 'started';

const mockHandlerResponse = (): {
  status: number;
  json: () => Promise<Record<string, unknown>>;
} => ({
  status: handlerVerdict === 'started' ? 202 : handlerVerdict === 'skipped' ? 200 : 500,
  json: async () =>
    handlerVerdict === 'started'
      ? { message: 'Code review queued', reviewId: 'review-new' }
      : handlerVerdict === 'skipped'
        ? { message: 'Code review agent not enabled for this repository' }
        : { error: 'Failed to trigger code review' },
});

const mockHandlePullRequestCodeReview = jest.fn<
  Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>,
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
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { OpenPullRequest } from '@/lib/integrations/platforms/github/adapter';
import {
  RECOVER_CONCURRENCY,
  recoverMissedReviews,
  recoverMissedReviewsSliceOffset,
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

/**
 * Stubs the raw SQL reads: the count aggregate, the repository slice, and the
 * integration rows of the slice. The slice repeats, like the same database
 * read on every run.
 */
function installedSlice(
  rows: Array<{ integrationId: string; fullName: string }>,
  counts: { addressable: number; unaddressable: number } = {
    addressable: rows.length,
    unaddressable: 0,
  }
): void {
  const slice = rows.map(row => ({ integration_id: row.integrationId, full_name: row.fullName }));
  mockDbExecute.mockReset();
  mockDbExecute.mockImplementation(async query => {
    const { sql: text } = new PgDialect().sqlToQuery(query as SQL);
    if (/count\(\*\)/.test(text)) return { rows: [counts] };
    if (/LIMIT/.test(text)) return { rows: slice.slice() };
    // The integration rows come from the query builder; a non-slice call is a
    // stub mistake and answers nothing.
    throw new Error(`Unexpected db query: ${text.slice(0, 80)}`);
  });
  mockSelectIntegrations.mockReset();
  mockSelectIntegrations.mockImplementation(async () => {
    const ids = [...new Set(rows.map(row => row.integrationId))];
    return ids.map(id => makeIntegration({ id }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  installedSlice([{ integrationId: INTEGRATION_ID, fullName: 'acme/widgets' }]);
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

  it('counts a handler failure as a provider failure and frees the start slot', async () => {
    handlerVerdict = 'failed';
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ providerFailures: 1, refusedByHandler: 0, reviewsStarted: 0 });
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

  it('skips an organization without a code-review bot user or a requester', async () => {
    mockGetBotUserId.mockResolvedValue(null);
    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ skippedWithoutOwner: 1, reviewsStarted: 0 });
    expect(mockFetchOpenPullRequests).not.toHaveBeenCalled();
  });

  it('reviews for the requester when the org has no code-review bot user', async () => {
    // The webhook handler names this owner from the requester's user id; the
    // sweep must recover the same reviews instead of dropping them.
    mockGetBotUserId.mockResolvedValue(null);
    mockSelectIntegrations.mockResolvedValue([
      makeIntegration({ kilo_requester_user_id: 'requester-1' }),
    ]);

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ skippedWithoutOwner: 0, reviewsStarted: 1 });
    expect(mockFindExistingReview.mock.calls[0]?.[0]).toMatchObject({
      owner: { type: 'org', id: ORG_ID, userId: 'requester-1' },
    });
  });

  it('sweeps only the entries the database addresses and reports the rest', async () => {
    installedSlice(
      [
        { integrationId: INTEGRATION_ID, fullName: 'acme/widgets' },
        { integrationId: INTEGRATION_ID, fullName: 'acme/gears' },
      ],
      { addressable: 2, unaddressable: 1 }
    );

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({
      repositoriesConsidered: 2,
      unaddressableRepositories: 1,
      reviewsStarted: 1,
    });
    expect(mockFetchOpenPullRequests.mock.calls.map(call => fetchParams(call[0]).repo)).toEqual(
      expect.arrayContaining(['gears', 'widgets'])
    );
  });

  it('resolves the owner and the installation authorization once per integration', async () => {
    installedSlice([
      { integrationId: INTEGRATION_ID, fullName: 'acme/widgets' },
      { integrationId: INTEGRATION_ID, fullName: 'acme/gears' },
    ]);
    mockFetchOpenPullRequests.mockImplementation(async params => {
      const { owner, repo } = fetchParams(params);
      return [makePull({ baseRepoName: repo, baseRepoFullName: `${owner}/${repo}` })];
    });

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ repositoriesConsidered: 2, reviewsStarted: 2 });
    expect(mockGetBotUserId).toHaveBeenCalledTimes(1);
    expect(mockAssertAuthorized).toHaveBeenCalledTimes(1);
    // Each repository still lists its own pull requests.
    expect(mockFetchOpenPullRequests).toHaveBeenCalledTimes(2);
  });

  it('drops a slice row its integration no longer holds', async () => {
    const missingId = '00000000-0000-4000-8000-0000000000dz';
    installedSlice([
      { integrationId: INTEGRATION_ID, fullName: 'acme/widgets' },
      { integrationId: missingId, fullName: 'acme/gone' },
    ]);
    // The integration fetch answers only the row that still exists.
    mockSelectIntegrations.mockImplementation(async () => [makeIntegration()]);

    const summary = await recoverMissedReviews({ now: FROZEN_NOW });
    expect(summary).toMatchObject({ repositoriesConsidered: 1, reviewsStarted: 1 });
  });

  it('reports one repository failure and still recovers the other repositories', async () => {
    installedSlice([
      { integrationId: INTEGRATION_ID, fullName: 'acme/widgets' },
      { integrationId: INTEGRATION_ID, fullName: 'acme/gadgets' },
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

  it('never starts a review past the per-run limit while handlers are in flight', async () => {
    // Ten repositories sweep at once; the first handler only answers after its
    // successors' reservations, so an awaited check would let them all start.
    const repositoryCount = RECOVER_MISSED_REVIEWS_START_LIMIT + RECOVER_CONCURRENCY;
    installedSlice(
      Array.from({ length: repositoryCount }, (_, index) => ({
        integrationId: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        fullName: `acme/repo-${index}`,
      })),
      { addressable: repositoryCount, unaddressable: 0 }
    );
    mockSelectIntegrations.mockResolvedValue(
      Array.from({ length: repositoryCount }, (_, index) =>
        makeIntegration({
          id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        })
      )
    );
    // Each repository's pull must name its own repository, or the rename guard
    // drops it before a handler call.
    mockFetchOpenPullRequests.mockImplementation(async params => {
      const { owner, repo } = fetchParams(params);
      return [makePull({ baseRepoName: repo, baseRepoFullName: `${owner}/${repo}` })];
    });
    let startedHandlers = 0;
    const block = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    mockHandlePullRequestCodeReview.mockImplementation(async () => {
      startedHandlers += 1;
      if (startedHandlers === 1) gate.resolve();
      await block.promise;
      return { status: 202, json: async () => ({}) };
    });

    const run = recoverMissedReviews({ now: FROZEN_NOW });
    // The first handler is in flight; its gate is the real arrival signal.
    await gate.promise;
    expect(startedHandlers).toBeLessThanOrEqual(RECOVER_MISSED_REVIEWS_START_LIMIT);
    block.resolve();
    const summary = await run;

    expect(summary.reviewsStarted).toBe(RECOVER_MISSED_REVIEWS_START_LIMIT);
    expect(summary.skippedStartLimit).toBe(repositoryCount - RECOVER_MISSED_REVIEWS_START_LIMIT);
    expect(mockHandlePullRequestCodeReview).toHaveBeenCalledTimes(
      RECOVER_MISSED_REVIEWS_START_LIMIT
    );
  });

  it('keeps one slice when the fleet fits the repository limit', () => {
    expect(recoverMissedReviewsSliceOffset(RECOVER_MISSED_REVIEWS_REPO_LIMIT, FROZEN_NOW)).toBe(0);
    expect(recoverMissedReviewsSliceOffset(12, FROZEN_NOW)).toBe(0);
    // Two full slices and a remainder rotate over three runs, then wrap.
    const sliceMs = 15 * 60 * 1000;
    const start = Math.floor(FROZEN_NOW.getTime() / sliceMs);
    for (let index = 0; index < 5; index += 1) {
      const expected = (index % 3) * RECOVER_MISSED_REVIEWS_REPO_LIMIT;
      expect(
        recoverMissedReviewsSliceOffset(
          RECOVER_MISSED_REVIEWS_REPO_LIMIT * 2 + 5,
          new Date((start + index) * sliceMs)
        )
      ).toBe(expected);
    }
  });
});
