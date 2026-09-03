import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { User } from '@kilocode/db';
import jwt from 'jsonwebtoken';

jest.mock('@/lib/config.server', () => ({
  ISOLATE_REVIEW_WORKER_URL: 'http://isolate-review',
  INTERNAL_API_SECRET: 'internal-secret',
  NEXTAUTH_SECRET: 'test-nextauth-secret',
}));

import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { JWT_TOKEN_VERSION, TOKEN_EXPIRY } from './tokens';
import {
  createIsolateReviewWorkerClient,
  createIsolateReviewWorkerClientForUser,
  IsolateReviewRequestSchema,
  IsolateReviewSelectionSchema,
  IsolateReviewWorkerError,
  MAX_REVIEW_SUMMARY_BYTES,
  type IsolateReviewInference,
  type IsolateReviewPreparation,
  type IsolateReviewSelection,
} from './isolate-review-worker-client';

const originalFetch = global.fetch;
const fixtureClientOptions = {
  baseUrl: 'http://isolate-review',
  internalApiSecret: 'internal-secret',
};
const inference: IsolateReviewInference = {
  modelId: 'openai/review-model',
  provider: 'openai',
  thinkingEffort: 'xhigh',
  variant: { reasoning: { effort: 'xhigh' }, verbosity: 'high' },
  reasoningSupported: true,
  maxOutputTokens: 16_000,
};
const preparation: IsolateReviewPreparation = {
  version: 1,
  preparedAt: '2026-08-27T09:00:00.000Z',
  requestingUserId: 'oauth/human',
  executionUserId: 'review-bot',
  organizationId: 'org-1',
  settings: {
    reviewStyle: 'balanced',
    focusAreas: ['correctness'],
    customInstructions: null,
    manualInstructions: null,
    model: inference.modelId,
    thinkingEffort: inference.thinkingEffort,
    modelSource: 'explicit',
    disableReviewMd: true,
    analyticsEnabled: false,
  },
  snapshot: { headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) },
  github: { integrationId: 'integration-1', installationId: 'installation-1', appType: 'standard' },
  hashes: {
    settings: 'd'.repeat(64),
    context: 'e'.repeat(64),
    canonicalPrompt: 'f'.repeat(64),
    adaptedPrompt: '1'.repeat(64),
    system: '2'.repeat(64),
  },
  versions: { cli: '7.4.20', policy: '1', adapter: '1' },
  limitations: [],
};
const preparedRequest = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 42,
  dryRun: true,
  ...preparation.snapshot,
  organizationId: 'org-1',
  model: inference.modelId,
  thinkingEffort: inference.thinkingEffort,
  inference,
  preparation,
  userPrompt: 'Complete canonical prepared prompt',
  expectedIntegrationId: preparation.github.integrationId,
  expectedInstallationId: preparation.github.installationId,
  expectedAppType: preparation.github.appType,
};

const previousRunId = '1c69229b-41bb-42c3-8363-b2bc548d370c';
const incrementalSelection = {
  requestedMode: 'incremental',
  effectiveMode: 'incremental',
  previousRunId,
  previousHeadSha: 'd'.repeat(40),
  previousSummaryHash: 'e'.repeat(64),
  changedFileCount: 2,
} satisfies IsolateReviewSelection;
const incrementalRequest = {
  ...preparedRequest,
  reviewMode: 'incremental',
  previousRunId,
  preparation: { ...preparation, reviewSelection: incrementalSelection },
} as const;

describe('IsolateReviewWorkerClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('mints a one-hour review-specific bearer bound to the user, pepper, and environment', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ runId: 'run-1' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createIsolateReviewWorkerClientForUser(
      { id: 'user-1', api_token_pepper: 'review-pepper' } as User,
      {
        baseUrl: 'http://isolate-review',
        internalApiSecret: 'internal-secret',
      }
    );
    await expect(
      client.startReview({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        organizationId: 'org-1',
        model: 'kilo-auto/efficient',
        existingSummaryCommentId: 123,
        dryRun: true,
      })
    ).resolves.toEqual({ runId: 'run-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://isolate-review/reviews',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer .+/),
          'x-internal-api-key': 'internal-secret',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          owner: 'acme',
          repo: 'widget',
          pullNumber: 42,
          organizationId: 'org-1',
          model: 'kilo-auto/efficient',
          existingSummaryCommentId: 123,
          dryRun: true,
        }),
      })
    );

    const request = fetchMock.mock.calls[0]?.[1];
    const authorization = new Headers(request?.headers).get('authorization');
    const payload = jwt.verify(authorization?.slice('Bearer '.length) ?? '', NEXTAUTH_SECRET, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;

    expect(payload).toEqual(
      expect.objectContaining({
        env: process.env.NODE_ENV,
        kiloUserId: 'user-1',
        apiTokenPepper: 'review-pepper',
        version: JWT_TOKEN_VERSION,
        tokenSource: 'isolate-review',
        botId: 'reviewer',
        iat: expect.any(Number),
        exp: expect.any(Number),
      })
    );
    expect(payload.exp).toBe((payload.iat ?? 0) + TOKEN_EXPIRY.oneHour);
  });

  it('preserves run diagnostics and publication IDs returned by the worker', async () => {
    const status = {
      runId: 'run-1',
      status: 'completed',
      requestedModel: 'kilo-auto/efficient',
      dryRun: false,
      createdAt: '2026-08-27T09:00:00.000Z',
      startedAt: '2026-08-27T09:00:01.000Z',
      cloneCompletedAt: '2026-08-27T09:00:03.000Z',
      completedAt: '2026-08-27T09:01:00.000Z',
      cloneAttempts: 1,
      githubSizeKiB: 128,
      tipFileCount: 2,
      tipTotalBytes: 20,
      vfsTotalBytes: 40,
      cloneMs: 2_000,
      headSha: 'a'.repeat(40),
      finalText: 'Review complete',
      githubReviewId: 456,
      summaryCommentId: 789,
      published: true,
      publishedAt: '2026-08-27T09:00:59.000Z',
    };
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(Response.json(status));

    await expect(
      createIsolateReviewWorkerClient('kilo-jwt', {
        baseUrl: 'http://isolate-review',
        internalApiSecret: 'internal-secret',
      }).getReview('run-1')
    ).resolves.toEqual(status);
  });

  it('accepts a status without historical diagnostics', async () => {
    const status = {
      runId: 'run-1',
      status: 'running',
      requestedModel: 'kilo-auto/efficient',
      dryRun: true,
    };
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(Response.json(status));

    await expect(
      createIsolateReviewWorkerClient('kilo-jwt', {
        baseUrl: 'http://isolate-review',
        internalApiSecret: 'internal-secret',
      }).getReview('run-1')
    ).resolves.toEqual(status);
  });

  it.each([
    { cloneMs: '2000' },
    { createdAt: 'not-a-timestamp' },
    { systemPromptHash: 'not-a-hash' },
    { reviewReconciliationAttempts: 3 },
    { summaryReconciliationAttempts: -1 },
    { reviewReconciliationAttempts: 1.5 },
    { cleanupAt: '2026-08-28T09:00:00Z' },
    { cleanupAt: -1 },
    { cleanupAt: 1.5 },
    { summaryContent: { body: 'analysis', bodyHash: 'invalid' } },
    { summaryContent: { body: 'analysis' } },
    { summaryContent: { body: '', bodyHash: 'a'.repeat(64) } },
    { summaryContent: { body: 'analysis', bodyHash: 'a'.repeat(64), commentId: 9 } },
    {
      taskSessions: [
        { taskId: 'task', sessionId: 'child', parentSessionId: 'root', mode: 'publisher' },
      ],
    },
  ])('rejects malformed worker diagnostics: %j', async diagnostic => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(
      Response.json({
        runId: 'run-1',
        status: 'completed',
        requestedModel: 'kilo-auto/efficient',
        dryRun: true,
        ...diagnostic,
      })
    );

    await expect(
      createIsolateReviewWorkerClient('kilo-jwt', {
        baseUrl: 'http://isolate-review',
        internalApiSecret: 'internal-secret',
      }).getReview('run-1')
    ).rejects.toThrow();
  });

  it('rejects redirects on secret-bearing review requests', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockRejectedValue(new TypeError('unexpected redirect'));

    await expect(
      createIsolateReviewWorkerClient('kilo-jwt', {
        baseUrl: 'http://isolate-review',
        internalApiSecret: 'internal-secret',
      }).getReview('run-1')
    ).rejects.toThrow('unexpected redirect');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://isolate-review/reviews/run-1',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer kilo-jwt',
          'x-internal-api-key': 'internal-secret',
        }),
      })
    );
  });

  it('preserves prepared provenance, separate inference, ownership assertions, and bounded effort keys', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(Response.json({ runId: 'run-1' }, { status: 202 }));
    await createIsolateReviewWorkerClient('fixture-token', fixtureClientOptions).startReview({
      ...preparedRequest,
      previousRunId: 'prior-run',
      existingSummaryCommentId: 9,
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request');
    expect(JSON.parse(body)).toEqual({
      ...preparedRequest,
      previousRunId: 'prior-run',
      existingSummaryCommentId: 9,
    });
    expect(
      IsolateReviewRequestSchema.parse({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        model: 'a'.repeat(512),
        thinkingEffort: 'a'.repeat(50),
      })
    ).toMatchObject({ thinkingEffort: 'a'.repeat(50) });
    expect(
      IsolateReviewRequestSchema.parse({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        model: 'model',
        thinkingEffort: null,
      })
    ).toMatchObject({ thinkingEffort: null });
  });

  it.each([
    { model: 'a'.repeat(513) },
    { thinkingEffort: 'a'.repeat(51) },
    { model: 'other-model' },
    { userPrompt: '' },
    { userPrompt: 'a'.repeat(64_001) },
    { baseTipSha: 'c'.repeat(40) },
    { expectedInstallationId: 'different-installation' },
    { inference: { ...inference, token: 'untrusted' } },
    { preparation: { ...preparation, inference } },
    { credentialsExpireAt: Date.now() + 60_000 },
  ])('rejects invalid prepared input before transport', async override => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    await expect(
      createIsolateReviewWorkerClient('fixture-token', fixtureClientOptions).startReview({
        ...preparedRequest,
        ...override,
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows omission of prepared inference for resolution at admission', () => {
    const request = { ...preparedRequest, inference: undefined };
    expect(IsolateReviewRequestSchema.parse(request)).toEqual(request);
  });

  it.each([{ temperature: 0, topP: 0 }, { temperature: 0.55, topP: 1 }, { temperature: 2 }])(
    'preserves optional bounded inference sampling without adding defaults',
    sampling => {
      const request = { ...preparedRequest, inference: { ...inference, ...sampling } };
      expect(IsolateReviewRequestSchema.parse(request)).toEqual(request);
      expect(IsolateReviewRequestSchema.parse(preparedRequest).inference).not.toHaveProperty(
        'temperature'
      );
      expect(IsolateReviewRequestSchema.parse(preparedRequest).inference).not.toHaveProperty(
        'topP'
      );
    }
  );

  it.each([
    { temperature: -0.01 },
    { temperature: 2.01 },
    { topP: -0.01 },
    { topP: 1.01 },
    { temperature: NaN },
    { topP: Infinity },
    { temperature: '0.55' },
    { topP: null },
  ])('rejects invalid inference sampling', sampling => {
    expect(
      IsolateReviewRequestSchema.safeParse({
        ...preparedRequest,
        inference: { ...inference, ...sampling },
      }).success
    ).toBe(false);
  });

  it.each([4_000, 4_001])('bounds manual instructions to 4000 characters: %s', length => {
    const request = {
      ...preparedRequest,
      preparation: {
        ...preparation,
        settings: { ...preparation.settings, manualInstructions: 'x'.repeat(length) },
      },
    };
    expect(IsolateReviewRequestSchema.safeParse(request).success).toBe(length === 4_000);
  });

  it('allows saved instructions and focus areas that fit the prepared prompt budget', () => {
    const settings = {
      ...preparation.settings,
      customInstructions: 'x'.repeat(20_000),
      focusAreas: [...Array.from({ length: 200 }, () => 'correctness'), 'context'.repeat(500)],
    };
    const request = {
      ...preparedRequest,
      preparation: { ...preparation, settings },
      userPrompt: `${settings.customInstructions}\n${settings.focusAreas.join(', ')}`,
    };
    expect(IsolateReviewRequestSchema.parse(request)).toEqual(request);
    expect(
      IsolateReviewRequestSchema.safeParse({
        ...request,
        preparation: {
          ...preparation,
          settings: { ...settings, customInstructions: 'x'.repeat(64_001) },
        },
      }).success
    ).toBe(false);
  });

  it('rejects standalone effort and caller-selected execution credentials', () => {
    for (const extra of [
      { thinkingEffort: null },
      { thinkingEffort: 'high' },
      { userId: 'forged' },
      { kiloToken: 'forged' },
      { gitToken: 'forged' },
    ]) {
      expect(
        IsolateReviewRequestSchema.safeParse({
          owner: 'acme',
          repo: 'widget',
          pullNumber: 42,
          ...extra,
        }).success
      ).toBe(false);
    }
  });

  it('retains analysis and uncertain publication separately without inventing legacy outcomes', async () => {
    const status = {
      runId: 'run-1',
      status: 'error',
      requestedModel: inference.modelId,
      dryRun: false,
      owner: 'acme',
      repo: 'widget',
      pullNumber: 42,
      userId: 'review-bot',
      organizationId: 'org-1',
      ...preparation.snapshot,
      installationId: 'installation-1',
      appType: 'standard',
      summaryCommentId: 9,
      summaryBodyHash: 'a'.repeat(64),
      reviewFingerprint: 'b'.repeat(64),
      summaryFingerprint: 'c'.repeat(64),
      preparation: {
        ...preparation,
        hashes: { ...preparation.hashes, workerSystem: 'd'.repeat(64) },
        versions: { ...preparation.versions, workerSystem: 'isolate-system-v2' },
      },
      inference,
      provenance: 'prepared',
      analysisOutcome: {
        status: 'completed',
        stepCount: 12,
        parentFinishReason: 'stop',
        parentFinished: true,
      },
      publicationOutcome: { review: 'uncertain', summary: 'confirmed' },
      reviewReconciliationAttempts: 2,
      summaryReconciliationAttempts: 1,
      terminationReason: 'publication_incomplete',
      usageSessions: ['run-1', 'child-1'],
      taskSessions: [
        {
          taskId: 'investigation-1',
          sessionId: 'child-1',
          parentSessionId: 'run-1',
          mode: 'explore',
        },
      ],
      systemPromptHash: 'd'.repeat(64),
      systemPromptVersion: 'isolate-system-v2',
      requestIds: ['request-1'],
      published: true,
      summaryProposal: { fingerprint: 'c'.repeat(64), bodyHash: 'a'.repeat(64), publishable: true },
    };
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(
      Response.json({ ...status, kiloToken: 'must-not-leak', githubToken: 'must-not-leak' })
    );
    await expect(
      createIsolateReviewWorkerClient('fixture-token', fixtureClientOptions).getReview('run-1')
    ).resolves.toEqual(status);
  });

  it('preserves an explicit prepared incremental selection without requiring summary publication ownership', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(Response.json({ runId: 'run-1' }, { status: 202 }));

    await createIsolateReviewWorkerClient('fixture-token', fixtureClientOptions).startReview(
      incrementalRequest
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request');
    expect(JSON.parse(body)).toEqual(incrementalRequest);
    expect(JSON.parse(body)).not.toHaveProperty('existingSummaryCommentId');
  });

  it('accepts explicit full fallback only with its requested incremental mode, previous run and reason', () => {
    const request = {
      ...incrementalRequest,
      preparation: {
        ...preparation,
        reviewSelection: {
          requestedMode: 'incremental',
          effectiveMode: 'full',
          previousRunId,
          fallbackReason: 'comparison_incomplete',
        },
      },
    };
    expect(IsolateReviewRequestSchema.parse(request)).toEqual(request);
  });

  it('preserves legacy full requests and does not infer incremental mode from a previous run', () => {
    const legacy = { ...preparedRequest, previousRunId: 'legacy-full-run' };
    expect(IsolateReviewRequestSchema.parse(legacy)).toEqual(legacy);
    const explicitFull = {
      ...preparedRequest,
      reviewMode: 'full',
      previousRunId,
      preparation: {
        ...preparation,
        reviewSelection: { requestedMode: 'full', effectiveMode: 'full', previousRunId },
      },
    };
    expect(IsolateReviewRequestSchema.parse(explicitFull)).toEqual(explicitFull);
  });

  it.each([
    { preparation: undefined },
    { preparation },
    { previousRunId: undefined },
    { previousRunId: 'legacy-run' },
    { previousRunId: '2c69229b-41bb-42c3-8363-b2bc548d370c' },
    { reviewMode: 'full' },
    { reviewMode: undefined },
    { previousHeadSha: 'd'.repeat(40) },
    { previousSHA: 'd'.repeat(40) },
    { previousSummaryBody: 'caller summary' },
    { effectiveMode: 'incremental' },
    { fallbackReason: 'base_changed' },
    { reviewSelection: incrementalSelection },
  ])('rejects raw incremental input and mode/baseline/preparation mismatches: %j', override => {
    expect(
      IsolateReviewRequestSchema.safeParse({ ...incrementalRequest, ...override }).success
    ).toBe(false);
  });

  it.each([
    { requestedMode: 'full' },
    { previousRunId: undefined },
    { previousRunId: 'not-a-uuid' },
    { previousHeadSha: undefined },
    { previousHeadSha: 'main' },
    { previousSummaryHash: undefined },
    { previousSummaryHash: 'not-a-hash' },
    { changedFileCount: undefined },
    { changedFileCount: -1 },
    { changedFileCount: 300 },
    { changedFileCount: 1.5 },
    { changedFileCount: '1' },
    { fallbackReason: 'comparison_incomplete' },
    { summaryBody: 'untrusted' },
  ])('rejects incomplete or forged incremental selection fields: %j', override => {
    expect(
      IsolateReviewSelectionSchema.safeParse({ ...incrementalSelection, ...override }).success
    ).toBe(false);
  });

  it.each([0, 299])('allows a proven incremental changed-file count of %s', changedFileCount => {
    expect(
      IsolateReviewSelectionSchema.parse({ ...incrementalSelection, changedFileCount })
    ).toMatchObject({ changedFileCount });
  });

  it.each([
    { previousRunId: undefined },
    { fallbackReason: undefined },
    { fallbackReason: 'invented_reason' },
    { previousHeadSha: 'a'.repeat(40) },
    { previousSummaryHash: 'b'.repeat(64) },
    { changedFileCount: 1 },
  ])('rejects ambiguous or scope-leaking full fallbacks: %j', override => {
    expect(
      IsolateReviewSelectionSchema.safeParse({
        requestedMode: 'incremental',
        effectiveMode: 'full',
        previousRunId,
        fallbackReason: 'comparison_unavailable',
        ...override,
      }).success
    ).toBe(false);
  });

  it('preserves retained dry-run analysis separately from confirmed publication hashes', async () => {
    const status = {
      runId: previousRunId,
      status: 'completed',
      requestedModel: inference.modelId,
      dryRun: true,
      preparation: incrementalRequest.preparation,
      reviewSelection: incrementalSelection,
      cleanupAt: Date.now() + 60_000,
      summaryContent: { body: 'Persisted analysis', bodyHash: 'a'.repeat(64) },
      summaryBodyHash: 'b'.repeat(64),
      publicationOutcome: { review: 'not_requested', summary: 'proposed' },
    };
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(Response.json(status));

    const result = await createIsolateReviewWorkerClient(
      'fixture-token',
      fixtureClientOptions
    ).getReview(previousRunId);
    expect(result).toEqual(status);
    expect(result).not.toHaveProperty('summaryCommentId');
  });

  it.each([
    { body: 'x'.repeat(MAX_REVIEW_SUMMARY_BYTES), valid: true },
    { body: 'é'.repeat(MAX_REVIEW_SUMMARY_BYTES / 2), valid: true },
    { body: 'x'.repeat(MAX_REVIEW_SUMMARY_BYTES + 1), valid: false },
    { body: 'é'.repeat(MAX_REVIEW_SUMMARY_BYTES / 2 + 1), valid: false },
  ])('bounds retained analysis by UTF-8 bytes, valid=$valid', async ({ body, valid }) => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(
      Response.json({
        runId: previousRunId,
        status: 'completed',
        requestedModel: inference.modelId,
        dryRun: true,
        summaryContent: { body, bodyHash: 'a'.repeat(64) },
      })
    );
    const result = createIsolateReviewWorkerClient('fixture-token', fixtureClientOptions).getReview(
      previousRunId
    );
    if (valid) {
      await expect(result).resolves.toMatchObject({ summaryContent: { body } });
    } else {
      await expect(result).rejects.toThrow();
    }
  });

  it.each([401, 403])(
    'retains current Worker authorization failures as hard errors: %s',
    async status => {
      const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
      fetchMock.mockResolvedValue(new Response('Unauthorized', { status }));
      const result = createIsolateReviewWorkerClient(
        'fixture-token',
        fixtureClientOptions
      ).getReview(previousRunId);
      await expect(result).rejects.toBeInstanceOf(IsolateReviewWorkerError);
      await expect(result).rejects.toMatchObject({ status });
    }
  );

  it('never retries an ambiguous review-creation POST', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockRejectedValue(new Error('response lost after acceptance'));
    await expect(
      createIsolateReviewWorkerClient('fixture-token', fixtureClientOptions).startReview({
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
      })
    ).rejects.toThrow('response lost after acceptance');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown review', async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(
      createIsolateReviewWorkerClient('kilo-jwt', {
        baseUrl: 'http://isolate-review',
        internalApiSecret: 'internal-secret',
      }).getReview('missing')
    ).resolves.toBe(null);
  });
});
