const mockRequest = jest.fn(),
  mockUpdate = jest.fn(),
  mockAssert = jest.fn(),
  mockDefer = jest.fn();
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { update: () => ({ set: (values: unknown) => ({ where: () => mockUpdate(values) }) }) },
}));
jest.mock('./watch-pr-github-client', () => ({
  assertWatchPrGitHubCall: (...args: unknown[]) => mockAssert(...args),
  watchPrGitHubClient: async () => ({ request: mockRequest }),
}));
jest.mock('./watch-pr-assessment', () => ({
  watchPrRepository: () => ({ owner: 'test', repo: 'repo' }),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  toGitHubRateLimitError: (error: { status?: number }) =>
    error?.status === 429 ? { resetAt: new Date('2026-11-12T13:00:00Z') } : null,
}));
jest.mock('@/lib/integrations/platforms/github/pr-refresh-budget', () => ({
  deferPrRefresh: (...args: unknown[]) => mockDefer(...args),
  recordPrMaintenanceApiCall: jest.fn(),
  PrMaintenanceDeferredError: class extends Error {
    constructor(
      public reason: string,
      public retryAt: Date
    ) {
      super(reason);
    }
  },
}));
import type { CloudAgentPrWatch } from '@kilocode/db/schema';
import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { validateGitHubGraphQl } from '@/tests/helpers/github-graphql-schema';
import { emptyWatchPrProjection, projectWatchPrEvent } from './watch-pr-events';
import { collectWatchPrProblems } from './watch-pr-observation';
import { hydrateWatchPrFeedbackThreads } from './watch-pr-feedback-threads';
const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
});
function fixture(sourceId = '9', rootId = '9') {
  const initial = {
    id: 'watch-test',
    installation_id: '123',
    repository_id: '456',
    github_app_type: 'standard',
    repo_url: 'https://github.com/test/repo',
    pr_number: 7,
    head_ref: 'feature',
    base_ref: 'main',
    head_sha: head,
    base_sha: base,
    status: 'watching',
    generation: 1,
    pending_revision: 0,
    projection: emptyWatchPrProjection(),
    lifecycle_reason: null,
    policy,
    updated_at: '2026-11-12T12:00:00Z',
  } as CloudAgentPrWatch;
  const watch = {
    ...initial,
    ...projectWatchPrEvent(
      initial,
      {
        kind: 'feedback',
        installationId: '123',
        repositoryId: '456',
        prNumber: 7,
        key: `comment:${sourceId}`,
        source: 'review_comment',
        sourceId,
        rootId,
        action: 'created',
        sha: head,
        actorId: '8',
        actorLogin: 'reviewer',
        actorType: 'User',
        authorAssociation: 'MEMBER',
        body: 'Handle an empty list.',
        state: 'commented',
        updatedAt: '2026-11-12T12:00:00Z',
      },
      1
    ),
  };
  return { watch, problems: collectWatchPrProblems(watch) };
}
function response(resolved = false, root: Record<string, unknown> = {}) {
  return {
    headers: {},
    data: {
      data: {
        rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: '2026-11-12T13:00:00Z' },
        repository: {
          pullRequest: {
            headRefName: 'feature',
            headRefOid: head,
            reviewThreads: {
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: resolved,
                  comments: {
                    nodes: [
                      {
                        fullDatabaseId: '9',
                        body: 'Handle an empty list.',
                        authorAssociation: 'MEMBER',
                        author: { login: 'reviewer', __typename: 'User', databaseId: '8' },
                        updatedAt: '2026-11-12T12:00:00Z',
                        url: 'https://github.com/test/repo/pull/7#discussion_r9',
                        commit: { oid: head },
                        ...root,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  mockRequest.mockResolvedValue(response());
  mockUpdate.mockResolvedValue(undefined);
});
describe('repair-tied review thread context', () => {
  it('maps a new inline comment to its thread in one schema-valid query', async () => {
    const input = fixture();
    expect(input.problems[0]).toMatchObject({ threadId: null });
    expect(await hydrateWatchPrFeedbackThreads(input)).toMatchObject([{ threadId: 'thread-1' }]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(validateGitHubGraphQl(mockRequest.mock.calls[0][1].query)).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  it('uses the original root for a new reviewer reply', async () => {
    expect(await hydrateWatchPrFeedbackThreads(fixture('10', '9'))).toMatchObject([
      { sourceId: '10', threadId: 'thread-1' },
    ]);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        projection: expect.objectContaining({
          evidence: expect.arrayContaining([
            expect.objectContaining({
              key: 'comment:9',
              body: 'Handle an empty list.',
              threadId: 'thread-1',
            }),
          ]),
        }),
      })
    );
  });
  it('keeps a Kilo reviewer thread root trusted although GraphQL omits the bot login suffix', async () => {
    mockRequest.mockResolvedValue(
      response(false, {
        authorAssociation: 'NONE',
        author: { login: 'kiloconnect', __typename: 'Bot', databaseId: '5' },
      })
    );
    expect(await hydrateWatchPrFeedbackThreads(fixture('10', '9'))).toMatchObject([
      { sourceId: '10', threadId: 'thread-1' },
    ]);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        projection: expect.objectContaining({
          evidence: expect.arrayContaining([
            expect.objectContaining({
              key: 'comment:9',
              trusted: true,
              actorLogin: 'kiloconnect[bot]',
              threadId: 'thread-1',
            }),
          ]),
        }),
      })
    );
  });
  it('makes no GitHub read when thread IDs are already available', async () => {
    const input = fixture();
    const problems = input.problems.map(problem =>
      problem.kind === 'review' ? { ...problem, threadId: 'thread-1' } : problem
    );
    expect(await hydrateWatchPrFeedbackThreads({ ...input, problems })).toEqual(problems);
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it('persists resolved feedback removal instead of repairing it or polling again', async () => {
    mockRequest.mockResolvedValue(response(true));
    const input = fixture();
    expect(await hydrateWatchPrFeedbackThreads(input)).toEqual([]);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        pending_revision: input.watch.pending_revision + 1,
        next_run_at: null,
        projection: expect.objectContaining({
          pending: [],
          threads: expect.arrayContaining([
            expect.objectContaining({ id: 'thread-1', resolved: true }),
          ]),
        }),
      })
    );
  });
  it('does not invent a thread or post a conversation summary when the root is outside the snapshot', async () => {
    await expect(hydrateWatchPrFeedbackThreads(fixture('11', '11'))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  it('stops before a GitHub read when the installation budget is unavailable', async () => {
    mockAssert.mockRejectedValue(new Error('budget deferred'));
    await expect(hydrateWatchPrFeedbackThreads(fixture())).rejects.toThrow('budget deferred');
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it.each([
    ['type', { errors: [{ type: 'RATE_LIMITED' }] }],
    [
      'lowercase extension code',
      {
        data: null,
        errors: [{ message: 'slow down', extensions: { code: 'secondary_rate_limit' } }],
      },
    ],
  ])('defers the installation after a GraphQL 200 rate-limit %s', async (_label, data) => {
    mockRequest.mockResolvedValue({ headers: {}, data });
    await expect(hydrateWatchPrFeedbackThreads(fixture())).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAt: new Date('2026-11-12T13:00:00Z'),
    });
    expect(mockDefer).toHaveBeenCalled();
  });
});
