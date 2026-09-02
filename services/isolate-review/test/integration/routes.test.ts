import { env, runInDurableObject, SELF, reset } from 'cloudflare:test';
import { RpcTarget } from 'cloudflare:workers';
import type { ThinkSubmissionInspection } from '@cloudflare/think';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyKiloToken } from '@kilocode/worker-utils';
import { createReviewPersistence } from '../../src/persistence';
import { DEFAULT_MODEL } from '../../src/prompt';
import { MAX_CLONE_ATTEMPTS, ReviewIsolate } from '../../src/review-isolate';
import type { RunState } from '../../src/types';

vi.mock('@kilocode/worker-utils/kilo-token-auth', () => ({
  verifyKiloBearerAgainstCurrentPepper: async ({
    token,
    nextAuthSecret,
  }: {
    token: string | null;
    nextAuthSecret: string;
  }) => {
    if (!token) return null;
    const claims = await verifyKiloToken(token, nextAuthSecret);
    return { userId: claims.kiloUserId };
  },
}));

const REVIEW_OWNER_ID = 'review-owner';

function reviewPersistence(durableState: DurableObjectState) {
  return createReviewPersistence(durableState.storage).persistence;
}

function authHeaders(userId?: string, exp = Math.floor(Date.now() / 1000) + 3_600): HeadersInit {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      kiloUserId: userId,
      version: 3,
      env: 'test',
      apiTokenPepper: 'fixture',
      iat: Math.floor(Date.now() / 1000),
      exp,
    })
  ).toString('base64url');
  const payload = `${header}.${claims}`;
  if (typeof env.NEXTAUTH_SECRET !== 'string') throw new Error('Expected a fixture JWT secret');
  const signature = createHmac('sha256', env.NEXTAUTH_SECRET).update(payload).digest('base64url');
  return {
    'x-internal-api-key': env.INTERNAL_API_SECRET,
    ...(userId ? { authorization: `Bearer ${payload}.${signature}` } : {}),
  };
}

function reviewBody() {
  return {
    owner: 'acme',
    repo: 'widget',
    pullNumber: 42,
    gitToken: 'git-token',
    kiloToken: 'kilo-token',
    userId: REVIEW_OWNER_ID,
  };
}

async function invokeSubmissionStatus(
  instance: ReviewIsolate,
  submission: ThinkSubmissionInspection
): Promise<void> {
  const hook = Reflect.get(instance, 'onSubmissionStatus');
  if (typeof hook !== 'function') throw new Error('onSubmissionStatus hook is unavailable');
  await Reflect.apply(hook, instance, [submission]);
}

describe('isolate review routes', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('External networking is disabled in route tests');
      })
    );
  });
  afterEach(async () => {
    await reset();
    vi.unstubAllGlobals();
  });

  it('requires the internal API key and Kilo bearer', async () => {
    const response = await SELF.fetch('https://worker.test/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewBody()),
    });
    expect(response.status).toBe(401);
  });

  it('requires the Kilo bearer after the internal key', async () => {
    const response = await SELF.fetch('https://worker.test/reviews', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewBody()),
    });
    expect(response.status).toBe(401);
  });

  it.each([
    { model: undefined, requestedModel: DEFAULT_MODEL },
    { model: '', requestedModel: DEFAULT_MODEL },
    { model: '  ', requestedModel: DEFAULT_MODEL },
    { model: ' kilo-auto/efficient ', requestedModel: 'kilo-auto/efficient' },
  ])(
    'persists the effective model for "$model" and keeps the first start',
    async ({ model, requestedModel }) => {
      const runId = crypto.randomUUID();
      const now = Date.now();
      const result = await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (instance, durableState) => {
          const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
          const schedule = vi.spyOn(instance, 'schedule').mockResolvedValue({
            id: 'unused-schedule',
            callback: 'runClone',
            payload: { runId },
            type: 'scheduled',
            time: now / 1000,
          });
          try {
            await instance.startReview(runId, { ...reviewBody(), model });
            const state = await reviewPersistence(durableState).get<RunState>('runState');
            clock.mockReturnValue(now + 1000);
            await instance.startReview(runId, { ...reviewBody(), model: 'another-model' });
            return {
              state,
              again: await reviewPersistence(durableState).get<RunState>('runState'),
              review: await instance.getReview(REVIEW_OWNER_ID),
            };
          } finally {
            clock.mockRestore();
            schedule.mockRestore();
          }
        }
      );
      expect(result.state).toMatchObject({
        runId,
        status: 'pending',
        input: { model: requestedModel, dryRun: true },
        createdAt: new Date(now).toISOString(),
      });
      expect(result.state?.startedAt).toBeUndefined();
      expect(result.state?.cloneCompletedAt).toBeUndefined();
      expect(result.state?.completedAt).toBeUndefined();
      expect(result.again).toEqual(result.state);
      expect(result.review).toMatchObject({
        runId,
        status: 'pending',
        requestedModel,
        dryRun: true,
        createdAt: new Date(now).toISOString(),
      });
    }
  );

  it.each(['running', 'completed', 'error'] as const)(
    'returns only whitelisted diagnostics for an owned %s run',
    async status => {
      const runId = crypto.randomUUID();
      const diagnostics = {
        cleanupAt: Date.now() + 86_400_000,
        createdAt: '2026-08-27T09:00:00.000Z',
        startedAt: '2026-08-27T09:00:01.000Z',
        cloneCompletedAt: '2026-08-27T09:00:02.000Z',
        ...(status !== 'running' ? { completedAt: '2026-08-27T09:00:04.000Z' } : {}),
        cloneAttempts: 2,
        githubSizeKiB: 1,
        tipFileCount: 0,
        tipTotalBytes: 0,
        vfsTotalBytes: 40,
        cloneMs: 0,
        headSha: 'head-sha',
        summaryCommentId: 22,
        reviewReconciliationAttempts: 1,
        summaryReconciliationAttempts: 2,
        published: true,
        publishedAt: '2026-08-27T09:00:03.000Z',
        ...(status === 'error' ? { error: 'gateway unavailable' } : {}),
      };
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (_instance, durableState) => {
          await reviewPersistence(durableState).put('runState', {
            runId,
            status,
            input: {
              ...reviewBody(),
              model: 'kilo-auto/efficient',
              dryRun: false,
              userPrompt: 'private instructions',
              organizationId: 'private-org',
            },
            ...diagnostics,
            githubToken: 'minted-github-token',
            submissionId: 'private-submission',
            credentialsExpireAt: Date.now() + 3_600_000,
            executionDeadlineAt: Date.now() + 720_000,
            reviewId: 17,
            reviewPendingFingerprint: 'private-review-fingerprint',
            summaryPendingFingerprint: 'private-summary-fingerprint',
            summaryPendingCommentId: 21,
            summaryPublished: true,
          } satisfies RunState);
        }
      );

      const response = await SELF.fetch(`https://worker.test/reviews/${runId}`, {
        headers: authHeaders(REVIEW_OWNER_ID),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        runId,
        status,
        requestedModel: 'kilo-auto/efficient',
        dryRun: false,
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        userId: REVIEW_OWNER_ID,
        organizationId: 'private-org',
        ...diagnostics,
        githubReviewId: 17,
        usageSessions: [runId],
      });
    }
  );

  it.each(['pending', 'completed', 'error'] as const)(
    'omits unavailable diagnostics for a legacy %s run',
    async status => {
      const runId = crypto.randomUUID();
      await runInDurableObject(
        env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
        async (_instance, durableState) => {
          await reviewPersistence(durableState).put('runState', {
            runId,
            status,
            input: { ...reviewBody(), gitToken: '', kiloToken: '' },
          } satisfies RunState);
        }
      );

      const response = await SELF.fetch(`https://worker.test/reviews/${runId}`, {
        headers: authHeaders(REVIEW_OWNER_ID),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        runId,
        status,
        requestedModel: DEFAULT_MODEL,
        dryRun: true,
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        userId: REVIEW_OWNER_ID,
        usageSessions: [runId],
      });
    }
  );

  it('reschedules a stranded clone from getReview', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(id),
      async (instance: ReviewIsolate, durableState) => {
        await reviewPersistence(durableState).put('runState', {
          runId,
          status: 'cloning',
          input: reviewBody(),
        } satisfies RunState);
        return instance.getReview(REVIEW_OWNER_ID);
      }
    );
    expect(result).toMatchObject({ runId, status: 'cloning' });
  });

  it('rejects a malformed headSha', async () => {
    const runId = crypto.randomUUID();
    await expect(
      runInDurableObject(env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)), instance =>
        instance.startReview(runId, { ...reviewBody(), headSha: 'main' })
      )
    ).rejects.toThrow('full git commit SHA');
  });

  it('scrubs stored tokens once a run is terminal', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(id),
      async (instance: ReviewIsolate, durableState) => {
        await reviewPersistence(durableState).put('runState', {
          runId,
          status: 'completed',
          input: reviewBody(),
          githubToken: 'minted-github-token',
        } satisfies RunState);
        const review = await instance.getReview(REVIEW_OWNER_ID);
        const stored = await reviewPersistence(durableState).get<RunState>('runState');
        return { review, stored };
      }
    );
    expect(result.review).toMatchObject({ runId, status: 'completed' });
    expect(result.stored?.input).toMatchObject({ gitToken: '', kiloToken: '' });
    expect(result.stored?.githubToken).toBeUndefined();
  });

  it('finalizes a completed Think submission without polling', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(id),
      async (instance: ReviewIsolate, durableState) => {
        await reviewPersistence(durableState).put('runState', {
          runId,
          status: 'running',
          input: reviewBody(),
          githubToken: 'minted-github-token',
          submissionId: 'submission-completed',
          analysisOutcome: {
            status: 'running',
            stepCount: 1,
            parentFinished: true,
            parentFinishReason: 'stop',
          },
          summaryProposal: {
            fingerprint: 'a'.repeat(64),
            bodyHash: 'b'.repeat(64),
            publishable: true,
          },
        } satisfies RunState);
        await invokeSubmissionStatus(instance, {
          submissionId: 'submission-completed',
          idempotencyKey: runId,
          status: 'completed',
          createdAt: Date.now(),
        });
        return reviewPersistence(durableState).get<RunState>('runState');
      }
    );

    expect(result).toMatchObject({
      runId,
      status: 'completed',
      submissionId: 'submission-completed',
      input: { gitToken: '', kiloToken: '' },
    });
    expect(result?.githubToken).toBeUndefined();
  });

  it('finalizes a failed Think submission and preserves its sanitized error', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(id),
      async (instance: ReviewIsolate, durableState) => {
        await reviewPersistence(durableState).put('runState', {
          runId,
          status: 'running',
          input: reviewBody(),
          githubToken: 'minted-github-token',
          submissionId: 'submission-error',
        } satisfies RunState);
        await invokeSubmissionStatus(instance, {
          submissionId: 'submission-error',
          status: 'error',
          error: 'gateway returned 401',
          createdAt: Date.now(),
        });
        return reviewPersistence(durableState).get<RunState>('runState');
      }
    );

    expect(result).toMatchObject({
      runId,
      status: 'error',
      error: 'gateway returned 401; the kiloToken may have expired during the review',
      input: { gitToken: '', kiloToken: '' },
    });
    expect(result?.githubToken).toBeUndefined();
  });

  it('ignores terminal notifications for an unrelated submission', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(id),
      async (instance: ReviewIsolate, durableState) => {
        const state = {
          runId,
          status: 'running',
          input: reviewBody(),
          githubToken: 'minted-github-token',
          submissionId: 'submission-expected',
        } satisfies RunState;
        await reviewPersistence(durableState).put('runState', state);
        await invokeSubmissionStatus(instance, {
          submissionId: 'submission-unrelated',
          idempotencyKey: runId,
          status: 'error',
          error: 'unrelated failure',
          createdAt: Date.now(),
        });
        return reviewPersistence(durableState).get<RunState>('runState');
      }
    );

    expect(result).toMatchObject({
      runId,
      status: 'running',
      submissionId: 'submission-expected',
      input: reviewBody(),
      githubToken: 'minted-github-token',
    });
  });

  it('retries operational clone failures and terminalizes the final attempt', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    const input = {
      ...reviewBody(),
      gitToken: undefined,
      userId: 'user-without-token-service',
    };

    await runInDurableObject(env.REVIEW_ISOLATE.get(id), async (_instance, durableState) => {
      await reviewPersistence(durableState).put('runState', {
        runId,
        status: 'pending',
        input,
      } satisfies RunState);
    });

    for (const attempt of [1, 2]) {
      await expect(
        runInDurableObject(env.REVIEW_ISOLATE.get(id), (instance: ReviewIsolate) =>
          instance.runClone({ runId })
        )
      ).rejects.toThrow('git-token-service binding is not configured');

      const state = await runInDurableObject(
        env.REVIEW_ISOLATE.get(id),
        async (_instance: ReviewIsolate, durableState) =>
          reviewPersistence(durableState).get<RunState>('runState')
      );
      expect(state).toMatchObject({ status: 'cloning', cloneAttempts: attempt });
    }

    await expect(
      runInDurableObject(env.REVIEW_ISOLATE.get(id), (instance: ReviewIsolate) =>
        instance.runClone({ runId })
      )
    ).resolves.toBeUndefined();

    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(id),
      async (_instance: ReviewIsolate, durableState) =>
        reviewPersistence(durableState).get<RunState>('runState')
    );
    expect(result).toMatchObject({
      status: 'error',
      cloneAttempts: MAX_CLONE_ATTEMPTS,
      input: { gitToken: '', kiloToken: '' },
    });
    expect(result?.error).toContain(`Clone failed after ${MAX_CLONE_ATTEMPTS} attempts`);
    expect(result?.error).toContain('git-token-service binding is not configured');
    expect(result?.githubToken).toBeUndefined();
  });

  it('stops rescheduling a clone after the attempt cap', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(id),
      async (instance: ReviewIsolate, durableState) => {
        await reviewPersistence(durableState).put('runState', {
          runId,
          status: 'cloning',
          cloneAttempts: MAX_CLONE_ATTEMPTS,
          input: reviewBody(),
        } satisfies RunState);
        await instance.runClone({ runId });
        return reviewPersistence(durableState).get<RunState>('runState');
      }
    );
    expect(result).toMatchObject({
      status: 'error',
      error: `Clone failed after ${MAX_CLONE_ATTEMPTS} attempts`,
      input: { gitToken: '', kiloToken: '' },
    });
  });

  it.each([
    { route: 'review status', suffix: '' },
    { route: 'review transcript', suffix: '/messages' },
  ])('returns an indistinguishable 404 for another user requesting $route', async ({ suffix }) => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    await runInDurableObject(env.REVIEW_ISOLATE.get(id), (instance: ReviewIsolate) =>
      instance.startReview(runId, reviewBody())
    );

    const ownerResponse = await SELF.fetch(`https://worker.test/reviews/${runId}${suffix}`, {
      headers: authHeaders(REVIEW_OWNER_ID),
    });
    expect(ownerResponse.status).toBe(200);
    await expect(ownerResponse.json()).resolves.toMatchObject({ runId });

    const otherUserResponse = await SELF.fetch(`https://worker.test/reviews/${runId}${suffix}`, {
      headers: authHeaders('another-user'),
    });
    const unknownRunResponse = await SELF.fetch(
      `https://worker.test/reviews/${crypto.randomUUID()}${suffix}`,
      { headers: authHeaders('another-user') }
    );

    expect(otherUserResponse.status).toBe(404);
    expect(unknownRunResponse.status).toBe(404);
    await expect(otherUserResponse.json()).resolves.toEqual({ error: 'Run not found' });
    await expect(unknownRunResponse.json()).resolves.toEqual({ error: 'Run not found' });
  });

  it('injects the verified JWT expiry and execution identity into an accepted raw request', async () => {
    const exp = Math.floor(Date.now() / 1000) + 90;
    const response = await SELF.fetch('https://worker.test/reviews', {
      method: 'POST',
      headers: { ...authHeaders(REVIEW_OWNER_ID, exp), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'fixture-token',
        dryRun: true,
      }),
    });
    expect(response.status).toBe(202);
    const { runId } = await response.json<{ runId: string }>();
    const state = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      (_instance, durableState) => reviewPersistence(durableState).get<RunState>('runState')
    );
    expect(state).toMatchObject({
      provenance: 'raw',
      credentialsExpireAt: exp * 1000,
      admissionDeadlineAt: exp * 1000,
      absoluteDeadlineAt: exp * 1000,
      input: { userId: REVIEW_OWNER_ID, credentialsExpireAt: exp * 1000 },
    });
    expect(state?.input.kiloToken).not.toBe('fixture-token');
  });

  it.each([
    { credentialsExpireAt: Date.now() + 86_400_000 },
    { kiloToken: 'forged-token' },
    { userId: 'forged-user' },
    { thinkingEffort: 'high' },
    { thinkingEffort: null },
    { model: 'a'.repeat(513) },
    { userPrompt: 'a'.repeat(64_001) },
    { baseTipSha: 'main' },
    { mergeBaseSha: 'main' },
    { dryRun: false, existingSummaryCommentId: 9 },
  ])('rejects invalid or unproven request authority before creating a DO', async extra => {
    const response = await SELF.fetch('https://worker.test/reviews', {
      method: 'POST',
      headers: { ...authHeaders(REVIEW_OWNER_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'fixture-token',
        ...extra,
      }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects prepared execution identity spoofing without accepting caller credentials', async () => {
    const snapshot = {
      headSha: 'a'.repeat(40),
      baseTipSha: 'b'.repeat(40),
      mergeBaseSha: 'c'.repeat(40),
    };
    const response = await SELF.fetch('https://worker.test/reviews', {
      method: 'POST',
      headers: { ...authHeaders(REVIEW_OWNER_ID), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        ...snapshot,
        model: 'fixture/model',
        expectedIntegrationId: 'integration-1',
        expectedInstallationId: 'installation-1',
        expectedAppType: 'standard',
        userPrompt: 'Complete prepared prompt',
        inference: {
          modelId: 'fixture/model',
          provider: 'openai-compatible',
          thinkingEffort: null,
          variant: null,
          reasoningSupported: false,
          maxOutputTokens: 8_000,
        },
        preparation: {
          version: 1,
          preparedAt: new Date().toISOString(),
          requestingUserId: REVIEW_OWNER_ID,
          executionUserId: 'another-user',
          settings: {
            reviewStyle: 'balanced',
            focusAreas: [],
            customInstructions: null,
            manualInstructions: null,
            model: 'fixture/model',
            thinkingEffort: null,
            modelSource: 'explicit',
            disableReviewMd: true,
            analyticsEnabled: false,
          },
          snapshot,
          github: {
            integrationId: 'integration-1',
            installationId: 'installation-1',
            appType: 'standard',
          },
          hashes: {
            settings: 'a'.repeat(64),
            context: 'b'.repeat(64),
            canonicalPrompt: 'c'.repeat(64),
            adaptedPrompt: 'd'.repeat(64),
            system: 'e'.repeat(64),
          },
          versions: { cli: '7.4.20', policy: '1', adapter: '1' },
          limitations: [],
        },
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Preparation does not match the authenticated execution user',
    });
  });

  it('does not permit another execution user to cancel a run', async () => {
    const runId = crypto.randomUUID();
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      async (instance, durableState) => {
        await reviewPersistence(durableState).put('runState', {
          runId,
          status: 'cloning',
          input: reviewBody(),
        } satisfies RunState);
        const cancelled = await instance.cancelReview('another-user');
        return {
          cancelled,
          state: await reviewPersistence(durableState).get<RunState>('runState'),
        };
      }
    );
    expect(result.cancelled).toBe(false);
    expect(result.state?.status).toBe('cloning');
  });

  it('returns 404 for an unknown run', async () => {
    const runId = crypto.randomUUID();
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      (instance: ReviewIsolate) => instance.getReview(REVIEW_OWNER_ID)
    );
    expect(result).toBeNull();
  });

  it.each([
    { method: 'getReview' as const, suffix: '' },
    { method: 'getTranscript' as const, suffix: '/messages' },
  ])(
    'disposes native $method RPC results after serializing the HTTP response',
    async ({ method, suffix }) => {
      const runId = crypto.randomUUID();
      const stub = env.REVIEW_ISOLATE.getByName(runId);
      const disposed = vi.fn();
      class ResultProbe extends RpcTarget {
        [Symbol.dispose]() {
          disposed();
        }
      }
      await runInDurableObject(stub, async (_instance, state) => {
        await reviewPersistence(state).put('runState', {
          runId,
          status: 'completed',
          input: reviewBody(),
        } satisfies RunState);
      });
      const original = ReviewIsolate.prototype[method];
      const read = vi
        .spyOn(ReviewIsolate.prototype, method)
        .mockImplementation(async function (userId) {
          const result = await original.call(this, userId);
          return result ? { ...result, disposalProbe: new ResultProbe() } : null;
        });
      try {
        const response = await SELF.fetch(`https://worker.test/reviews/${runId}${suffix}`, {
          headers: authHeaders(REVIEW_OWNER_ID),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ runId });
        await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce(), {
          timeout: 1_000,
          interval: 10,
        });
      } finally {
        read.mockRestore();
      }
    }
  );

  it('returns an empty transcript for a run with no messages', async () => {
    const runId = crypto.randomUUID();
    const id = env.REVIEW_ISOLATE.idFromName(runId);
    await runInDurableObject(env.REVIEW_ISOLATE.get(id), async (_instance, durableState) => {
      await reviewPersistence(durableState).put('runState', {
        runId,
        status: 'pending',
        input: reviewBody(),
      } satisfies RunState);
    });

    const result = await runInDurableObject(env.REVIEW_ISOLATE.get(id), (instance: ReviewIsolate) =>
      instance.getTranscript(REVIEW_OWNER_ID)
    );
    expect(result).toEqual({ runId, messages: [], toolCalls: [] });
  });

  it('returns 404 for transcript of an unknown run', async () => {
    const runId = crypto.randomUUID();
    const result = await runInDurableObject(
      env.REVIEW_ISOLATE.get(env.REVIEW_ISOLATE.idFromName(runId)),
      (instance: ReviewIsolate) => instance.getTranscript(REVIEW_OWNER_ID)
    );
    expect(result).toBeNull();
  });
});
