import { emptyWatchPrProjection, normalizeWatchPrEvent } from './watch-pr-events';

const mockCandidates = jest.fn();
const mockLockedWatch = jest.fn();
const mockReceipt = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockTransaction = jest.fn();
const mockFlag = jest.fn();
const mockAuthorize = jest.fn();
const mockRetainCi = jest.fn();
const mockReadCi = jest.fn();

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    eval: (...args: unknown[]) => mockRetainCi(...args),
    zrange: (...args: unknown[]) => mockReadCi(...args),
  },
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: (condition: unknown) => mockCandidates(condition) }),
      }),
    }),
    transaction: (callback: (tx: unknown) => Promise<void>) => mockTransaction(callback),
  },
}));
jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: (flag: string, owner: string) => mockFlag(flag, owner),
}));
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  GitHubRuntimeAuthorizationError: class GitHubRuntimeAuthorizationError extends Error {},
  assertGitHubInstallationRuntimeAuthorized: (...args: unknown[]) => mockAuthorize(...args),
}));

import { observeWatchPrWebhook } from './watch-pr-webhook';
import { GitHubRuntimeAuthorizationError } from '@/lib/integrations/github/runtime-authorization';
import { PgDialect } from 'drizzle-orm/pg-core';

const head = 'a'.repeat(40);
const input = {
  eventType: 'check_run',
  deliveryId: 'delivery-1',
  appType: 'standard' as const,
  payload: {
    installation: { id: 123 },
    repository: { id: 456 },
    action: 'completed',
    check_run: {
      id: 10,
      head_sha: head,
      name: 'tests',
      app: { id: 7 },
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-10-14T12:00:00Z',
      completed_at: '2026-10-14T12:01:00Z',
      pull_requests: [],
    },
  },
};
const watch = {
  id: 'watch-1',
  kilo_user_id: 'oauth/owner',
  organization_id: null,
  integration_id: 'exact-agent-integration',
  installation_id: '123',
  github_app_type: 'standard',
  repository_id: '456',
  pr_number: 42,
  head_ref: 'feature',
  base_ref: 'main',
  head_sha: head,
  base_sha: 'c'.repeat(40),
  status: 'watching',
  generation: 1,
  pending_revision: 0,
  projection: emptyWatchPrProjection(),
  lifecycle_reason: null,
  expires_at: '2099-10-14 12:00:00+00',
  created_at: '2026-10-14 00:00:00+00',
  policy: {
    version: 1,
    categories: { reviews: true, failedChecks: true, baseUpdates: true },
    model: 'test/model',
    profileId: null,
    branchStrategy: 'merge',
    historyRewriteConsent: false,
    maxAttemptsPerProblem: 2,
    maxTotalAttempts: 10,
    observationOnlyConsent: true,
    futureEventsOnlyConsent: true,
    noHardSpendCapConsent: true,
  },
};
const candidate = {
  watch,
  userId: 'oauth/owner',
  organizationId: null,
  repositoryAccess: 'all',
  repositories: null,
};

describe('awaited watch PR durable observation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockCandidates.mockResolvedValue([candidate]);
    mockLockedWatch.mockResolvedValue([watch]);
    mockReceipt.mockResolvedValue([]);
    mockInsert.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockFlag.mockResolvedValue(true);
    mockAuthorize.mockResolvedValue(undefined);
    mockRetainCi.mockResolvedValue(1);
    mockReadCi.mockResolvedValue([]);
    mockTransaction.mockImplementation(async callback =>
      callback({
        select: () => ({
          from: () => ({
            where: () => ({
              for: mockLockedWatch,
              limit: mockReceipt,
              then: (resolve: (rows: unknown) => unknown) => mockReceipt().then(resolve),
            }),
          }),
        }),
        insert: () => ({ values: mockInsert }),
        update: () => ({ set: (values: unknown) => ({ where: () => mockUpdate(values) }) }),
      })
    );
  });

  it('matches exact installation/app/repository in SQL and authorizes the exact agent-only connection', async () => {
    await observeWatchPrWebhook(input);
    const query = new PgDialect().sqlToQuery(mockCandidates.mock.calls[0][0]);
    expect(query.params).toEqual(['123', 'standard', '456', 'finished', head]);
    expect(mockFlag).toHaveBeenCalledWith('cloud-agent-watch-pr', 'oauth/owner');
    expect(mockAuthorize).toHaveBeenCalledWith(
      '123',
      'standard',
      'exact-agent-integration',
      'agent'
    );
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        watch_id: watch.id,
        generation: 1,
        delivery_id: 'delivery-1',
        kind: 'observation',
      })
    );
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'watching',
        pending_revision: 1,
        projection: expect.objectContaining({
          pending: [{ key: `check:7:run:10:tests:${head}`, reason: 'failed_check' }],
        }),
      })
    );
  });

  it('does not let saved repair category preferences hide failed observations', async () => {
    mockLockedWatch.mockResolvedValue([
      {
        ...watch,
        policy: {
          ...watch.policy,
          categories: { reviews: false, failedChecks: false, baseUpdates: false },
        },
      },
    ]);
    await observeWatchPrWebhook(input);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        pending_revision: 1,
        projection: expect.objectContaining({
          pending: [{ key: `check:7:run:10:tests:${head}`, reason: 'failed_check' }],
        }),
      })
    );
  });

  it('retains early empty-association checks once without writing to unrelated watches', async () => {
    const earlyHead = 'b'.repeat(40);
    mockCandidates.mockResolvedValue([]);
    await observeWatchPrWebhook({
      ...input,
      payload: { ...input.payload, check_run: { ...input.payload.check_run, head_sha: earlyHead } },
    });
    const query = new PgDialect().sqlToQuery(mockCandidates.mock.calls[0][0]);
    expect(query.params).toEqual(['123', 'standard', '456', 'finished', earlyHead]);
    expect(mockRetainCi).toHaveBeenCalledTimes(1);
    expect(mockRetainCi.mock.calls[0][1]).toEqual(['watch-pr-ci:v1:123:standard:456']);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('uses the head-SHA predicate for status events too', async () => {
    mockCandidates.mockResolvedValue([]);
    await observeWatchPrWebhook({
      ...input,
      eventType: 'status',
      payload: {
        installation: { id: 123 },
        repository: { id: 456 },
        id: 11,
        sha: head,
        context: 'ci',
        state: 'failure',
        updated_at: '2026-10-14T12:01:00Z',
      },
    });
    const query = new PgDialect().sqlToQuery(mockCandidates.mock.calls[0][0]);
    expect(query.params).toEqual(['123', 'standard', '456', 'finished', head]);
    expect(mockRetainCi).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each(['push', 'pull_request'])(
    'joins early checks only when %s establishes their head SHA',
    async eventType => {
      const earlyHead = 'b'.repeat(40);
      const earlyEvent = normalizeWatchPrEvent('check_run', {
        ...input.payload,
        check_run: { ...input.payload.check_run, head_sha: earlyHead },
      });
      mockReadCi.mockResolvedValue([JSON.stringify({ deliveryId: 'early-ci', event: earlyEvent })]);
      await observeWatchPrWebhook({
        ...input,
        eventType,
        payload:
          eventType === 'push'
            ? {
                installation: { id: 123 },
                repository: { id: 456 },
                ref: 'refs/heads/feature',
                before: head,
                after: earlyHead,
                deleted: false,
              }
            : {
                installation: { id: 123 },
                repository: { id: 456 },
                action: 'synchronize',
                before: head,
                pull_request: {
                  number: 42,
                  state: 'open',
                  updated_at: '2026-10-14T12:02:00Z',
                  head: { ref: 'feature', sha: earlyHead, repo: { id: 456 } },
                  base: { ref: 'main', sha: 'c'.repeat(40), repo: { id: 456 } },
                },
              },
      });
      expect(mockReadCi).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          head_sha: earlyHead,
          projection: expect.objectContaining({
            pending: [{ key: `check:7:run:10:tests:${earlyHead}`, reason: 'failed_check' }],
            truncated: false,
          }),
        })
      );
      expect(mockInsert).toHaveBeenCalledWith([
        expect.objectContaining({ delivery_id: 'early-ci' }),
      ]);
    }
  );

  it('does not replay preexisting deliveries or unrelated commits into a new head', async () => {
    const nextHead = 'b'.repeat(40);
    mockReceipt.mockResolvedValueOnce([]).mockResolvedValueOnce([{ deliveryId: 'early-ci' }]);
    mockReadCi.mockResolvedValue([
      JSON.stringify({
        deliveryId: 'early-ci',
        event: normalizeWatchPrEvent('check_run', {
          ...input.payload,
          check_run: { ...input.payload.check_run, head_sha: nextHead },
        }),
      }),
      JSON.stringify({
        deliveryId: 'unrelated',
        event: normalizeWatchPrEvent('check_run', input.payload),
      }),
    ]);
    await observeWatchPrWebhook({
      ...input,
      eventType: 'push',
      payload: {
        installation: { id: 123 },
        repository: { id: 456 },
        ref: 'refs/heads/feature',
        before: head,
        after: nextHead,
        deleted: false,
      },
    });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        head_sha: nextHead,
        projection: expect.objectContaining({ pending: [], evidence: [] }),
      })
    );
  });

  it('propagates inbox failures before acknowledging CI delivery', async () => {
    mockRetainCi.mockRejectedValue(new Error('inbox unavailable'));
    await expect(observeWatchPrWebhook(input)).rejects.toThrow('inbox unavailable');
    expect(mockCandidates).not.toHaveBeenCalled();
  });

  it('retains the PR/head index predicate for checks carrying explicit associations', async () => {
    await observeWatchPrWebhook({
      ...input,
      payload: {
        ...input.payload,
        check_run: { ...input.payload.check_run, pull_requests: [{ number: 42 }] },
      },
    });
    const query = new PgDialect().sqlToQuery(mockCandidates.mock.calls[0][0]);
    expect(query.params).toEqual(['123', 'standard', '456', 'finished', head, 42]);
  });

  it('continues to persist observations for a paused watch without resuming or changing its pause', async () => {
    mockLockedWatch.mockResolvedValue([
      { ...watch, status: 'paused', lifecycle_reason: 'user_paused' },
    ]);
    await observeWatchPrWebhook(input);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'paused',
        lifecycle_reason: 'user_paused',
        generation: 1,
        pending_revision: 1,
      })
    );
  });

  it('makes no GitHub reads or pending repair work for a burst of passing observations', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network read'));
    try {
      for (let i = 0; i < 5; i++) {
        await observeWatchPrWebhook({
          ...input,
          deliveryId: `passing-${i}`,
          payload: {
            ...input.payload,
            check_run: { ...input.payload.check_run, conclusion: 'success' },
          },
        });
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledTimes(5);
      for (const [update] of mockUpdate.mock.calls) {
        expect(update).toMatchObject({
          status: 'watching',
          pending_revision: 0,
          projection: { pending: [] },
        });
      }
    } finally {
      fetch.mockRestore();
    }
  });

  it('does not resolve until the projection transaction has persisted', async () => {
    let release: (() => void) | undefined;
    mockUpdate.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );
    let finished = false;
    const observing = observeWatchPrWebhook(input).then(() => {
      finished = true;
    });
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    expect(finished).toBe(false);
    release?.();
    await observing;
    expect(finished).toBe(true);
  });

  it('propagates durable admission failure, allowing ingress to return a retryable response', async () => {
    mockUpdate.mockRejectedValue(new Error('database unavailable'));
    await expect(observeWatchPrWebhook(input)).rejects.toThrow('database unavailable');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('deduplicates receipt and projection in the same locked transaction', async () => {
    mockReceipt.mockResolvedValue([{ id: 'prior-delivery' }]);
    await observeWatchPrWebhook(input);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not project watches that became terminal before locking', async () => {
    mockLockedWatch.mockResolvedValue([]);
    await observeWatchPrWebhook(input);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('projects against the locked paused generation when pause races with candidate selection', async () => {
    mockLockedWatch.mockResolvedValue([
      { ...watch, status: 'paused', generation: 2, lifecycle_reason: 'user_paused' },
    ]);
    await observeWatchPrWebhook(input);
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 2,
        status: 'paused',
        lifecycle_reason: 'user_paused',
        pending_revision: 1,
      })
    );
  });

  it('ignores feature-disabled watches without runtime authorization or projection', async () => {
    mockFlag.mockResolvedValue(false);
    await observeWatchPrWebhook(input);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('fails closed for changed tenant or removed selected repository access', async () => {
    for (const invalid of [
      { ...candidate, userId: 'different-owner' },
      { ...candidate, repositoryAccess: 'selected', repositories: [{ id: 987 }] },
    ]) {
      mockCandidates.mockResolvedValue([invalid]);
      await observeWatchPrWebhook(input);
    }
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('skips definitively revoked authorization but retries transient authorization failures', async () => {
    mockAuthorize.mockRejectedValueOnce(new GitHubRuntimeAuthorizationError());
    await observeWatchPrWebhook(input);
    expect(mockTransaction).not.toHaveBeenCalled();
    mockAuthorize.mockRejectedValueOnce(new Error('authorization database unavailable'));
    await expect(observeWatchPrWebhook(input)).rejects.toThrow(
      'authorization database unavailable'
    );
  });

  it('validates unsupported and malformed payloads before any database read', async () => {
    await observeWatchPrWebhook({ ...input, eventType: 'issue_comment' });
    await observeWatchPrWebhook({ ...input, payload: { installation: { id: 123 } } });
    expect(mockCandidates).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('finishes expired watches with a generation fence without manufacturing actionable work', async () => {
    mockLockedWatch.mockResolvedValue([{ ...watch, expires_at: '2026-01-01 12:00:00+00' }]);
    await observeWatchPrWebhook(input);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'finished',
        generation: 2,
        lifecycle_reason: 'expired',
        pending_revision: 0,
      })
    );
  });
});
