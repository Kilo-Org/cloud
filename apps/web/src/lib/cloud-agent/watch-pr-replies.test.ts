const mockAssert = jest.fn(),
  mockWhere = jest.fn();
const mockSelect = jest.fn(),
  mockInsert = jest.fn(),
  mockUpdate = jest.fn(),
  mockRequest = jest.fn(),
  mockCreate = jest.fn(),
  mockBudget = jest.fn(),
  mockDefer = jest.fn();
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          mockWhere(table, condition);
          return {
            limit: () => Promise.resolve(mockSelect(table)),
            then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
              Promise.resolve(mockSelect(table)).then(resolve, reject),
          };
        },
      }),
    }),
    insert: () => ({
      values: (data: unknown) => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve(mockInsert(data)) }),
      }),
    }),
    update: (table: unknown) => ({
      set: (data: unknown) => ({
        where: () => ({
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(mockUpdate(table, data)).then(resolve, reject),
          returning: () => Promise.resolve(mockUpdate(table, data)),
        }),
      }),
    }),
  },
}));
jest.mock('./watch-pr-github-client', () => ({
  assertWatchPrGitHubCall: (...args: unknown[]) => mockAssert(...args),
  watchPrGitHubClient: async () => ({
    request: mockRequest,
    issues: { createComment: mockCreate },
  }),
}));
jest.mock('./watch-pr-assessment', () => ({
  watchPrRepository: () => ({ owner: 'test', repo: 'repo' }),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  toGitHubRateLimitError: (error: { status?: number }) =>
    error?.status === 429 ? { resetAt: new Date('2026-11-12T13:00:00Z') } : null,
}));
jest.mock('@/lib/integrations/platforms/github/pr-refresh-budget', () => ({
  claimPrMaintenanceCall: (...args: unknown[]) => mockBudget(...args),
  completePrMaintenanceWrite: jest.fn(),
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
import { validateGitHubGraphQl } from '@/tests/helpers/github-graphql-schema';
import {
  cloud_agent_pr_feedback_dispositions,
  cloud_agent_pr_maintenance_attempts,
  cloud_agent_pr_watch_activity,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import { publishWatchPrReplies, watchPrReplyBody } from './watch-pr-replies';
import { emptyWatchPrProjection } from './watch-pr-events';
import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import { PgDialect } from 'drizzle-orm/pg-core';
const now = '2026-11-12T12:00:00Z';
const watch = {
  id: 'watch-test',
  generation: 1,
  pending_revision: 1,
  status: 'watching',
  github_app_type: 'lite',
  installation_id: '123',
  repo_url: 'https://github.com/test/repo',
  pr_number: 7,
  head_sha: 'a'.repeat(40),
  head_ref: 'feature',
  policy: watchPrMaintenancePolicySchema.parse({
    version: 2,
    automaticWritesConsent: true,
    historyRewriteConsent: true,
    noHardSpendCapConsent: true,
    model: 'test/model',
    profileId: null,
    environmentId: null,
    categories: { reviews: true, failedChecks: true, conflicts: true },
  }),
  projection: emptyWatchPrProjection(),
} as CloudAgentPrWatch;
let ledger: Record<string, unknown> | null,
  rows: Array<Record<string, unknown>>,
  attempt: Record<string, unknown>;
function setupRows(threadIds: Array<string | null>) {
  rows = threadIds.map((thread, index) => ({
    id: `disposition-${index}`,
    attempt_id: 'attempt-test',
    problem_key: `comment:${index}`,
    content_fingerprint: `fingerprint-${index}`,
    thread_id: thread,
    reply_body: 'Verified the fix.',
    reason: 'Addressed',
    replied_at: null,
    reply_comment_id: null,
    resolution_status: thread ? 'open' : 'not_applicable',
    disposition: 'addressed',
  }));
  attempt = {
    id: 'attempt-test',
    status: 'completed',
    generation: 1,
    input: {
      repository: {
        repoUrl: watch.repo_url,
        prNumber: watch.pr_number,
        headRef: watch.head_ref,
        headSha: 'a'.repeat(40),
      },
      problems: rows.map(row => ({ kind: 'review', problemKey: row.problem_key })),
    },
    result: {
      verification: [{ outcome: 'passed' }],
      publication: {
        status: 'published',
        pushedHeadSha: 'a'.repeat(40),
        observedHeadSha: 'b'.repeat(40),
      },
      problems: rows.map(row => ({
        problemKey: row.problem_key,
        contentFingerprint: row.content_fingerprint,
        resolve: false,
      })),
    },
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  mockAssert.mockResolvedValue({ pendingRevision: watch.pending_revision });
  jest.useFakeTimers().setSystemTime(new Date(now));
  ledger = null;
  setupRows(['thread-1']);
  mockBudget.mockResolvedValue({ allowed: true, writeLease: Date.now() + 30000 });
  mockSelect.mockImplementation(table =>
    table === cloud_agent_pr_maintenance_attempts
      ? [attempt]
      : table === cloud_agent_pr_feedback_dispositions
        ? rows
        : table === cloud_agent_pr_watch_activity
          ? ledger
            ? [ledger]
            : []
          : []
  );
  mockInsert.mockImplementation(data => {
    if (ledger) return [];
    ledger = { ...data, id: 'ledger-test', created_at: now };
    return [{ id: 'ledger-test' }];
  });
  mockUpdate.mockImplementation((table, data) => {
    if (table === cloud_agent_pr_watch_activity) {
      ledger = { ...ledger, ...data };
      return [{ id: 'ledger-test' }];
    }
    if (table === cloud_agent_pr_feedback_dispositions)
      rows = rows.map(row => ({ ...row, ...data }));
    return [];
  });
  mockRequest.mockResolvedValue({
    headers: {},
    data: {
      data: {
        addPullRequestReviewThreadReply: { comment: { id: 'node-reply', fullDatabaseId: '99' } },
      },
    },
  });
  mockCreate.mockResolvedValue({ headers: {}, data: { id: 99 } });
});
afterEach(() => jest.useRealTimers());
describe('durable platform replies', () => {
  it('delivers an authorized verified reply after resume using the attempt ledger generation', async () => {
    const resumed = { ...watch, generation: 3 };
    expect(await publishWatchPrReplies({ watch: resumed, attemptId: 'attempt-test' })).toEqual({
      status: 'completed',
    });
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
    expect(mockAssert).toHaveBeenCalledWith(resumed);
    const activity = mockWhere.mock.calls.find(
      ([table]) => table === cloud_agent_pr_watch_activity
    );
    if (!activity) throw new Error('Missing ledger query');
    expect(new PgDialect().sqlToQuery(activity[1]).params[1]).toBe(1);
  });
  it('reconciles the same unknown write after pause and resume instead of posting again', async () => {
    mockRequest.mockRejectedValueOnce(new Error('transport disconnected'));
    await publishWatchPrReplies({ watch, attemptId: 'attempt-test' });
    const saved = ledger;
    expect(
      await publishWatchPrReplies({
        watch: { ...watch, status: 'paused', generation: 2 },
        attemptId: 'attempt-test',
      })
    ).toEqual({ status: 'completed' });
    expect(ledger).toEqual(saved);
    jest.setSystemTime(new Date('2026-11-12T12:00:31Z'));
    const marker = watchPrReplyBody('Verified the fix.', 'attempt-test:thread-1').marker;
    mockRequest.mockResolvedValue({
      headers: {},
      data: {
        data: {
          node: {
            comments: {
              nodes: [
                {
                  id: 'node-reply',
                  fullDatabaseId: '99',
                  body: marker,
                  author: { login: 'kiloconnect-lite', __typename: 'Bot' },
                },
              ],
            },
          },
        },
      },
    });
    expect(
      await publishWatchPrReplies({ watch: { ...watch, generation: 3 }, attemptId: 'attempt-test' })
    ).toEqual({ status: 'completed' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
  it.each(['finished', 'paused'] as const)(
    'does not publish queued writes while watch status is %s',
    async status => {
      expect(
        await publishWatchPrReplies({
          watch: { ...watch, status, generation: 2 },
          attemptId: 'attempt-test',
        })
      ).toEqual({ status: 'completed' });
      expect(mockRequest).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(rows[0].replied_at).toBeNull();
    }
  );
  it('does not revive a stopped attempt when the watch resumes', async () => {
    attempt.status = 'stopped';
    expect(
      await publishWatchPrReplies({ watch: { ...watch, generation: 3 }, attemptId: 'attempt-test' })
    ).toEqual({ status: 'completed' });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
  it('keeps a known rejected write ready until current resumed access permits publication', async () => {
    setupRows([null]);
    mockCreate.mockRejectedValueOnce({ status: 403 });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'blocked',
    });
    expect(ledger).toMatchObject({ generation: 1, data: { state: 'ready', reconciliations: 0 } });
    expect(
      await publishWatchPrReplies({ watch: { ...watch, generation: 3 }, attemptId: 'attempt-test' })
    ).toEqual({ status: 'completed' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it('preserves an unsent ledger without consuming reconciliation when current access fails', async () => {
    mockRequest.mockRejectedValueOnce(new Error('transport disconnected'));
    await publishWatchPrReplies({ watch, attemptId: 'attempt-test' });
    const saved = ledger;
    mockAssert.mockRejectedValue(new Error('Current access revoked'));
    jest.setSystemTime(new Date('2026-11-12T12:00:31Z'));
    expect(
      await publishWatchPrReplies({ watch: { ...watch, generation: 3 }, attemptId: 'attempt-test' })
    ).toMatchObject({ status: 'deferred' });
    expect(ledger).toEqual(saved);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
  it('rechecks current authority after pacing and intent persistence before starting the write', async () => {
    mockBudget.mockImplementationOnce(async () => {
      mockAssert.mockRejectedValue(new Error('Watch paused during pacing'));
      return { allowed: true, writeLease: Date.now() + 30000 };
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'deferred',
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(ledger).toMatchObject({ data: { state: 'ready', reconciliations: 0 } });
    mockAssert.mockResolvedValue(undefined);
    expect(
      await publishWatchPrReplies({ watch: { ...watch, generation: 3 }, attemptId: 'attempt-test' })
    ).toEqual({ status: 'completed' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
  it('rechecks current authority after pacing before a resolution mutation', async () => {
    rows[0].replied_at = now;
    const result = attempt.result as { problems: Array<{ resolve: boolean }> };
    result.problems[0].resolve = true;
    mockBudget.mockImplementationOnce(async () => {
      mockAssert.mockRejectedValue(new Error('Watch stopped during pacing'));
      return { allowed: true, writeLease: Date.now() + 30000 };
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'deferred',
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(rows[0].resolution_status).toBe('open');
  });
  it('does not consume unknown-write reconciliation on a known rate-limit rejection', async () => {
    mockRequest.mockRejectedValueOnce(new Error('transport disconnected'));
    await publishWatchPrReplies({ watch, attemptId: 'attempt-test' });
    jest.setSystemTime(new Date('2026-11-12T12:00:31Z'));
    mockRequest.mockResolvedValueOnce({
      headers: {},
      data: { errors: [{ type: 'RATE_LIMITED' }] },
    });
    expect(
      await publishWatchPrReplies({ watch: { ...watch, generation: 3 }, attemptId: 'attempt-test' })
    ).toMatchObject({
      status: 'deferred',
      reason: 'rate_limited',
      retryAt: new Date('2026-11-12T13:00:00Z'),
    });
    expect(ledger).toMatchObject({
      data: { state: 'unknown', reconciliations: 0, retryReason: 'rate_limited' },
    });
    const marker = watchPrReplyBody('Verified the fix.', 'attempt-test:thread-1').marker;
    jest.setSystemTime(new Date('2026-11-12T13:00:00Z'));
    mockRequest.mockResolvedValue({
      headers: {},
      data: {
        data: {
          node: {
            comments: {
              nodes: [
                {
                  id: 'node-reply',
                  fullDatabaseId: '99',
                  body: marker,
                  author: { login: 'kiloconnect-lite', __typename: 'Bot' },
                },
              ],
            },
          },
        },
      },
    });
    expect(
      await publishWatchPrReplies({ watch: { ...watch, generation: 3 }, attemptId: 'attempt-test' })
    ).toEqual({ status: 'completed' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });
  it('records reply intent before the API write and saves its returned ID', async () => {
    mockRequest.mockImplementation(async () => {
      expect(ledger).toMatchObject({ kind: 'reply', data: { state: 'posting', commentId: null } });
      return {
        headers: {},
        data: {
          data: {
            addPullRequestReviewThreadReply: {
              comment: { id: 'node-reply', fullDatabaseId: '99' },
            },
          },
        },
      };
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toEqual({
      status: 'completed',
    });
    expect(rows[0]).toMatchObject({
      reply_comment_id: '99',
      replied_at: new Date(now).toISOString(),
    });
    const query = mockRequest.mock.calls[0][1].query;
    expect(validateGitHubGraphQl(query)).toEqual([]);
    expect(query).toContain('kilo-pr-maintenance');
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toEqual({
      status: 'completed',
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
  it('groups handled conversation comments into one batch summary', async () => {
    setupRows([null, null]);
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toEqual({
      status: 'completed',
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(rows.every(row => row.reply_comment_id === '99')).toBe(true);
  });
  it('reconciles an unknown write by its marker without posting twice', async () => {
    mockRequest.mockRejectedValueOnce(new Error('transport disconnected'));
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'deferred',
      reason: 'unavailable',
    });
    jest.setSystemTime(new Date('2026-11-12T12:00:31Z'));
    const marker = watchPrReplyBody('Verified the fix.', 'attempt-test:thread-1').marker;
    mockRequest.mockResolvedValue({
      headers: {},
      data: {
        data: {
          node: {
            comments: {
              nodes: [
                {
                  id: 'node-reply',
                  fullDatabaseId: '99',
                  body: `Done ${marker}`,
                  author: { login: 'kiloconnect-lite', __typename: 'Bot' },
                },
              ],
            },
          },
        },
      },
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toEqual({
      status: 'completed',
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest.mock.calls[1][1].query).toContain('query');
    expect(rows[0].reply_comment_id).toBe('99');
  });
  it('reconciles an unknown summary write against the GraphQL bot login without the [bot] suffix', async () => {
    setupRows([null]);
    mockCreate.mockRejectedValueOnce(new Error('transport disconnected'));
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'deferred',
      reason: 'unavailable',
    });
    expect(ledger).toMatchObject({ data: { state: 'unknown' } });
    jest.setSystemTime(new Date('2026-11-12T12:00:31Z'));
    const marker = watchPrReplyBody('Verified the fix.', 'attempt-test:summary').marker;
    mockRequest.mockResolvedValue({
      headers: {},
      data: {
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: [
                  {
                    id: 'node-user',
                    fullDatabaseId: '98',
                    body: marker,
                    author: { login: 'kiloconnect', __typename: 'User' },
                  },
                  {
                    id: 'node-reply',
                    fullDatabaseId: '99',
                    body: marker,
                    author: { login: 'kiloconnect', __typename: 'Bot' },
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toEqual({
      status: 'completed',
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(rows[0].reply_comment_id).toBe('99');
    expect(ledger).toMatchObject({ data: { state: 'posted', commentId: '99' } });
    const query = mockRequest.mock.calls[0][1].query;
    expect(validateGitHubGraphQl(query)).toEqual([]);
    expect(query).toContain('__typename');
  });
  it('bounds unknown-write reconciliation and exposes a blocker rather than a duplicate reply', async () => {
    mockRequest.mockRejectedValueOnce(new Error('transport disconnected'));
    await publishWatchPrReplies({ watch, attemptId: 'attempt-test' });
    jest.setSystemTime(new Date('2026-11-12T12:00:31Z'));
    mockRequest.mockResolvedValue({
      headers: {},
      data: { data: { node: { comments: { nodes: [] } } } },
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'deferred',
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'deferred',
      retryAt: new Date('2026-11-12T12:01:01Z'),
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    jest.setSystemTime(new Date('2026-11-12T12:01:02Z'));
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('unknown'),
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'blocked',
    });
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });
  it.each([
    ['type', { errors: [{ type: 'RATE_LIMITED' }] }],
    [
      'lowercase extension code',
      { data: null, errors: [{ message: 'slow down', extensions: { code: 'abuse_detection' } }] },
    ],
  ])(
    'keeps a known rate-limit %s rejection retryable and defers installation-wide',
    async (_label, data) => {
      mockRequest.mockResolvedValueOnce({ headers: {}, data });
      expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
        status: 'deferred',
        reason: 'rate_limited',
      });
      expect(ledger).toMatchObject({ data: { state: 'ready' } });
      expect(mockDefer).toHaveBeenCalled();
    }
  );
  it('batches verified resolutions and preserves disputed threads', async () => {
    setupRows(['thread-1', 'thread-2', 'thread-disputed']);
    rows = rows.map(row => ({ ...row, replied_at: now }));
    rows[2].disposition = 'disagreed';
    const result = attempt.result as { problems: Array<{ resolve: boolean }> };
    result.problems.forEach(problem => (problem.resolve = true));
    mockRequest.mockResolvedValue({
      headers: {},
      data: {
        data: {
          t0: { thread: { id: 'thread-1', isResolved: true } },
          t1: { thread: { id: 'thread-2', isResolved: true } },
        },
      },
    });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toEqual({
      status: 'completed',
    });
    const query = mockRequest.mock.calls[0][1].query;
    expect(validateGitHubGraphQl(query)).toEqual([]);
    expect(query).toContain('thread-1');
    expect(query).toContain('thread-2');
    expect(query).not.toContain('thread-disputed');
  });
  it('does not resolve from a stale same-head projection after new feedback arrives', async () => {
    rows[0].replied_at = now;
    const result = attempt.result as { problems: Array<{ resolve: boolean }> };
    result.problems[0].resolve = true;
    mockAssert.mockResolvedValueOnce({ pendingRevision: watch.pending_revision });
    mockAssert.mockResolvedValueOnce({ pendingRevision: watch.pending_revision + 1 });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toMatchObject({
      status: 'deferred',
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(rows[0].resolution_status).toBe('open');
  });
  it('returns a durable retry time when writes are paced and never sleeps', async () => {
    const retryAt = new Date('2026-11-12T12:00:01Z');
    mockBudget.mockResolvedValue({ allowed: false, reason: 'write_pacing', retryAt });
    expect(await publishWatchPrReplies({ watch, attemptId: 'attempt-test' })).toEqual({
      status: 'deferred',
      reason: 'write_pacing',
      retryAt,
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(ledger).toBeNull();
  });
  it('does not resolve a thread against a known different head after verification', async () => {
    rows[0].replied_at = now;
    const result = attempt.result as { problems: Array<{ resolve: boolean }> };
    result.problems[0].resolve = true;
    expect(
      await publishWatchPrReplies({
        watch: { ...watch, head_sha: 'c'.repeat(40) },
        attemptId: 'attempt-test',
      })
    ).toMatchObject({ status: 'blocked', reason: expect.stringContaining('head changed') });
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it('never resolves a thread from incomplete feedback context', async () => {
    rows[0].replied_at = now;
    const result = attempt.result as { problems: Array<{ resolve: boolean }> };
    result.problems[0].resolve = true;
    expect(
      await publishWatchPrReplies({
        watch: { ...watch, projection: { ...emptyWatchPrProjection(), truncated: true } },
        attemptId: 'attempt-test',
      })
    ).toMatchObject({ status: 'blocked', reason: expect.stringContaining('incomplete') });
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it('keeps a thread open until all known requests in that thread are verified addressed', async () => {
    rows[0].replied_at = now;
    const result = attempt.result as { problems: Array<{ resolve: boolean }> };
    result.problems[0].resolve = true;
    rows.push({
      ...rows[0],
      id: 'other-disposition',
      attempt_id: 'previous-attempt',
      problem_key: 'comment:other',
      content_fingerprint: 'other-fingerprint',
      disposition: 'deferred',
    });
    const projection = {
      ...emptyWatchPrProjection(),
      evidence: [
        {
          key: 'comment:0',
          kind: 'feedback',
          sha: 'a'.repeat(40),
          updatedAt: null,
          state: 'commented',
          trusted: true,
          body: 'First request.',
          contentFingerprint: 'fingerprint-0',
          threadId: 'thread-1',
        },
        {
          key: 'comment:other',
          kind: 'feedback',
          sha: 'a'.repeat(40),
          updatedAt: null,
          state: 'commented',
          trusted: true,
          body: 'Second request.',
          contentFingerprint: 'other-fingerprint',
          threadId: 'thread-1',
        },
      ],
    };
    const input = { watch: { ...watch, projection }, attemptId: 'attempt-test' };
    expect(await publishWatchPrReplies(input)).toEqual({ status: 'completed' });
    expect(mockRequest).not.toHaveBeenCalled();
    rows[1].disposition = 'addressed';
    mockRequest.mockResolvedValue({
      headers: {},
      data: { data: { t0: { thread: { id: 'thread-1', isResolved: true } } } },
    });
    expect(await publishWatchPrReplies(input)).toEqual({ status: 'completed' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
