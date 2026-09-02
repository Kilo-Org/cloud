jest.mock('./legacy-code-review-worker-client', () => {
  const previous = process.env.CODE_REVIEW_WORKER_URL;
  process.env.CODE_REVIEW_WORKER_URL = 'https://legacy.test';
  const actual = jest.requireActual('./legacy-code-review-worker-client');
  if (previous === undefined) delete process.env.CODE_REVIEW_WORKER_URL;
  else process.env.CODE_REVIEW_WORKER_URL = previous;
  return actual;
});

const mockAttempt = jest.fn();
const mockFence = jest.fn();

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual('@/lib/config.server'),
  ISOLATE_REVIEW_WORKER_URL: 'https://isolate.test',
  CODE_REVIEW_WORKER_AUTH_TOKEN: 'legacy-fixture',
}));
jest.mock('../db/code-reviews', () => ({
  getCodeReviewAttemptForReview: (...args: unknown[]) => mockAttempt(...args),
  getLatestCodeReviewAttempt: (...args: unknown[]) => mockAttempt(...args),
}));
jest.mock('./queued-isolate-review-client', () => ({
  ...jest.requireActual('./queued-isolate-review-client'),
  getIsolateFenceForAttempt: (...args: unknown[]) => mockFence(...args),
}));

import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { codeReviewWorkerClient } from './code-review-worker-client';
import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import type { QueuedIsolateIdentity } from '../queued-isolate-contract';

const identity: QueuedIsolateIdentity = {
  reviewId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  generation: crypto.randomUUID(),
  organizationId: crypto.randomUUID(),
  integrationId: crypto.randomUUID(),
  executionUserId: 'oauth/github/fixture',
  target: { host: 'github.com', repoFullName: 'acme/widgets', prNumber: 42 },
  snapshot: { headSha: 'a'.repeat(40), baseTipSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) },
};

function status(overrides = {}) {
  return {
    version: 1,
    identity,
    safety: {
      sequence: 1,
      execution: 'running',
      cancellationRequested: false,
      publication: 'pending',
      quiescent: false,
      observedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe('affinity-aware code review worker client', () => {
  beforeEach(() => {
    mockAttempt
      .mockReset()
      .mockResolvedValue({ id: identity.attemptId, reviewer_backend: 'isolate' });
    mockFence.mockReset().mockResolvedValue({ identity, released_at: null });
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json(status()));
  });
  afterEach(() => jest.restoreAllMocks());

  it('cancels isolate work with operation-bound authentication and no execution bearer', async () => {
    expect(
      await codeReviewWorkerClient.cancelReview(identity.reviewId, 'Cancelled', identity.attemptId)
    ).toEqual({ success: true, reviewId: identity.reviewId });
    const token = await deriveCallbackToken({
      secret: INTERNAL_API_SECRET,
      scope: 'queued-isolate-control',
      resourceParts: ['cancel', JSON.stringify(identity)],
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://isolate.test/queued-reviews/${identity.attemptId}/control`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-key': INTERNAL_API_SECRET,
          'x-isolate-control-token': token,
        },
        body: JSON.stringify({ version: 1, identity, operation: 'cancel' }),
      })
    );
  });

  it('resolves omitted attempt IDs from persisted current affinity', async () => {
    expect(await codeReviewWorkerClient.getReviewStatus(identity.reviewId)).toEqual({
      reviewId: identity.reviewId,
      attemptId: identity.attemptId,
      status: 'running',
    });
    expect(mockAttempt).toHaveBeenCalledWith(identity.reviewId);
    expect(mockFence).toHaveBeenCalledWith(identity.reviewId, identity.attemptId);
  });

  it.each([
    'reviewId',
    'attemptId',
    'generation',
    'organizationId',
    'integrationId',
    'executionUserId',
  ] as const)('rejects mismatched status identity %s', async field => {
    jest
      .mocked(fetch)
      .mockResolvedValue(
        Response.json(status({ identity: { ...identity, [field]: crypto.randomUUID() } }))
      );
    await expect(
      codeReviewWorkerClient.getReviewStatus(identity.reviewId, identity.attemptId)
    ).rejects.toThrow('identity mismatch');
  });

  it('rejects oversized responses without waiting for cancellation', async () => {
    jest.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(16_385)));
          },
          cancel() {
            return new Promise(() => {});
          },
        })
      )
    );
    await expect(
      codeReviewWorkerClient.getReviewStatus(identity.reviewId, identity.attemptId)
    ).rejects.toThrow('too large');
  });

  it('does not reflect remote error bodies or fall back on unavailable control', async () => {
    jest.mocked(fetch).mockResolvedValue(new Response('private fixture content', { status: 503 }));
    await expect(
      codeReviewWorkerClient.cancelReview(identity.reviewId, undefined, identity.attemptId)
    ).rejects.toThrow('Queued isolate request failed: 503');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not treat missing state as a release certificate', async () => {
    jest.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    expect(
      await codeReviewWorkerClient.getReviewStatus(identity.reviewId, identity.attemptId)
    ).toBeNull();
    expect(mockFence).toHaveBeenCalledTimes(1);
  });

  it('rejects Cloud Agent fresh-session retries for isolate affinity', async () => {
    await expect(
      codeReviewWorkerClient.retryReviewFresh(identity.reviewId, {
        reason: 'infra_failure',
        failedAttemptId: identity.attemptId,
      })
    ).rejects.toThrow('legacy-only');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects accidental legacy dispatch for isolate affinity', async () => {
    await expect(
      codeReviewWorkerClient.dispatchReview({
        reviewId: identity.reviewId,
        attemptId: identity.attemptId,
      } as CodeReviewPayload)
    ).rejects.toThrow('Legacy attempt affinity required');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps historical legacy cancellation and status on the original transport', async () => {
    mockAttempt.mockResolvedValue({ id: identity.attemptId, reviewer_backend: 'legacy' });
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(Response.json({ success: true, reviewId: identity.reviewId }))
      .mockResolvedValueOnce(
        Response.json({ reviewId: identity.reviewId, status: 'running', sessionId: 'agent-legacy' })
      );
    expect(
      await codeReviewWorkerClient.cancelReview(identity.reviewId, 'Cancelled', identity.attemptId)
    ).toEqual({ success: true, reviewId: identity.reviewId });
    expect(
      await codeReviewWorkerClient.getReviewStatus(identity.reviewId, identity.attemptId)
    ).toMatchObject({ sessionId: 'agent-legacy' });
    for (const [url] of jest.mocked(fetch).mock.calls) {
      expect(String(url)).not.toContain('isolate.test');
      expect(String(url)).toContain(`attemptId=${identity.attemptId}`);
    }
    expect(mockFence).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'status'] as const)(
    'forwards the same resolved legacy attempt for omitted-ID %s calls',
    async operation => {
      mockAttempt
        .mockResolvedValueOnce({ id: identity.attemptId, reviewer_backend: 'legacy' })
        .mockResolvedValue({ id: crypto.randomUUID(), reviewer_backend: 'isolate' });
      jest
        .mocked(fetch)
        .mockResolvedValue(
          Response.json({ success: true, reviewId: identity.reviewId, status: 'running' })
        );

      if (operation === 'cancel') await codeReviewWorkerClient.cancelReview(identity.reviewId);
      else await codeReviewWorkerClient.getReviewStatus(identity.reviewId);

      expect(mockAttempt).toHaveBeenCalledTimes(1);
      expect(mockAttempt).toHaveBeenCalledWith(identity.reviewId);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = jest.mocked(fetch).mock.calls[0];
      expect(String(url)).toBe(
        `https://legacy.test/reviews/${identity.reviewId}/${operation}?attemptId=${identity.attemptId}`
      );
      if (operation === 'cancel')
        expect(options?.body).toBe(JSON.stringify({ attemptId: identity.attemptId }));
      expect(mockFence).not.toHaveBeenCalled();
    }
  );

  it.each(['cancel', 'status'] as const)(
    'keeps bare review-ID %s transport only when no attempt exists',
    async operation => {
      mockAttempt.mockResolvedValue(null);
      jest
        .mocked(fetch)
        .mockResolvedValue(
          Response.json({ success: true, reviewId: identity.reviewId, status: 'running' })
        );

      if (operation === 'cancel') await codeReviewWorkerClient.cancelReview(identity.reviewId);
      else await codeReviewWorkerClient.getReviewStatus(identity.reviewId);

      const [url, options] = jest.mocked(fetch).mock.calls[0];
      expect(String(url)).toBe(`https://legacy.test/reviews/${identity.reviewId}/${operation}`);
      if (operation === 'cancel') expect(options?.body).toBe('{}');
      expect(mockFence).not.toHaveBeenCalled();
    }
  );

  it('dispatches an omitted-ID legacy payload with its resolved attempt identity', async () => {
    mockAttempt.mockResolvedValue({ id: identity.attemptId, reviewer_backend: 'legacy' });
    jest.mocked(fetch).mockResolvedValue(
      Response.json({
        reviewId: identity.reviewId,
        attemptId: identity.attemptId,
        status: 'queued',
      })
    );
    const payload = {
      reviewId: identity.reviewId,
      owner: { type: 'user', id: identity.executionUserId, userId: identity.executionUserId },
    } as CodeReviewPayload;

    await codeReviewWorkerClient.dispatchReview(payload);

    expect(mockAttempt).toHaveBeenCalledTimes(1);
    expect(jest.mocked(fetch).mock.calls[0][1]?.body).toBe(
      JSON.stringify({ ...payload, attemptId: identity.attemptId })
    );
  });

  it.each([true, false])(
    'retains resolved legacy retry identity when attempt exists: %s',
    async exists => {
      mockAttempt.mockResolvedValue(
        exists ? { id: identity.attemptId, reviewer_backend: 'legacy' } : null
      );
      jest
        .mocked(fetch)
        .mockResolvedValue(Response.json({ success: true, reviewId: identity.reviewId }));

      await codeReviewWorkerClient.retryReviewFresh(identity.reviewId, { reason: 'infra_failure' });

      expect(mockAttempt).toHaveBeenCalledTimes(1);
      expect(jest.mocked(fetch).mock.calls[0][1]?.body).toBe(
        JSON.stringify({
          reason: 'infra_failure',
          failedAttemptId: exists ? identity.attemptId : undefined,
        })
      );
    }
  );

  it('rejects explicit attempts outside the requested review', async () => {
    mockAttempt.mockResolvedValue(null);
    await expect(
      codeReviewWorkerClient.cancelReview(identity.reviewId, undefined, identity.attemptId)
    ).rejects.toThrow('does not belong');
    await expect(
      codeReviewWorkerClient.getReviewStatus(identity.reviewId, identity.attemptId)
    ).rejects.toThrow('does not belong');
    await expect(
      codeReviewWorkerClient.dispatchReview({
        reviewId: identity.reviewId,
        attemptId: identity.attemptId,
      } as CodeReviewPayload)
    ).rejects.toThrow('does not belong');
    await expect(
      codeReviewWorkerClient.retryReviewFresh(identity.reviewId, {
        reason: 'infra_failure',
        failedAttemptId: identity.attemptId,
      })
    ).rejects.toThrow('does not belong');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not send an unselected attempt to either backend', async () => {
    mockAttempt.mockResolvedValue({ id: identity.attemptId, reviewer_backend: 'unselected' });
    expect(
      await codeReviewWorkerClient.cancelReview(identity.reviewId, undefined, identity.attemptId)
    ).toEqual({ success: false, reviewId: identity.reviewId });
    expect(
      await codeReviewWorkerClient.getReviewStatus(identity.reviewId, identity.attemptId)
    ).toBeNull();
    await expect(
      codeReviewWorkerClient.dispatchReview({ reviewId: identity.reviewId } as CodeReviewPayload)
    ).rejects.toThrow('Legacy attempt affinity required');
    await expect(
      codeReviewWorkerClient.retryReviewFresh(identity.reviewId, { reason: 'infra_failure' })
    ).rejects.toThrow('legacy-only');
    expect(fetch).not.toHaveBeenCalled();
  });
});
