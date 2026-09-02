import 'server-only';

import { z } from 'zod';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  prepareIsolateRecoveryControl,
  publicationFromAttempt,
  updateIsolatePublicationOn,
} from '../db/publication-fences';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { cloud_agent_code_review_attempts } from '@kilocode/db/schema';
import { INTERNAL_API_SECRET, ISOLATE_REVIEW_WORKER_URL } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { IsolateReviewRequestSchema } from '@/lib/isolate-review-worker-client';
import {
  QueuedIsolateAdmissionSchema,
  QueuedIsolateIdentitySchema,
  QueuedIsolateSafetySchema,
  sameQueuedIsolateIdentity,
  type QueuedIsolateIdentity,
} from '../queued-isolate-contract';
import type { prepareIsolateReviewPayload } from '../triggers/prepare-isolate-review-payload';
import type { TryDispatchPendingReviewsOptions } from '../dispatch/dispatch-pending-reviews';

export async function recoverQueuedIsolateReviews(options: TryDispatchPendingReviewsOptions = {}) {
  const attempts = await db.transaction(async tx => {
    const candidates = await tx
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(
        and(
          isNotNull(cloud_agent_code_review_attempts.publication_state),
          sql`(${cloud_agent_code_review_attempts.publication_state}->>'released_at' IS NULL OR ${cloud_agent_code_review_attempts.publication_state}->>'queue_wakeup_at' IS NULL)`,
          sql`${cloud_agent_code_review_attempts.updated_at} < now() - interval '30 seconds'`
        )
      )
      .orderBy(cloud_agent_code_review_attempts.updated_at)
      .limit(4)
      .for('update', { skipLocked: true });
    for (const attempt of candidates)
      await tx
        .update(cloud_agent_code_review_attempts)
        .set({ updated_at: new Date().toISOString() })
        .where(
          and(
            eq(cloud_agent_code_review_attempts.id, attempt.id),
            eq(cloud_agent_code_review_attempts.code_review_id, attempt.code_review_id)
          )
        );
    return candidates;
  });
  for (const attempt of attempts) {
    try {
      const fence = publicationFromAttempt(attempt);
      if (!fence) continue;
      if (fence.released_at && fence.identity_cleanup_requested) {
        const { getUnblockedBotUserForOrg } = await import('@/lib/bot-users/bot-user-service');
        const { tryDispatchPendingReviews } = await import('../dispatch/dispatch-pending-reviews');
        const bot = await getUnblockedBotUserForOrg(fence.identity.organizationId, 'code-review');
        if (!bot) continue;
        await tryDispatchPendingReviews(
          {
            type: 'org',
            id: fence.identity.organizationId,
            userId: bot.id,
          },
          options
        );
        await db.transaction(tx =>
          updateIsolatePublicationOn(tx, fence.identity, {
            queue_wakeup_at: new Date().toISOString(),
          })
        );
        continue;
      }
      const { resumeQueuedIsolateFinalization } = await import('../queued-isolate-lifecycle');
      if (!fence.released_at && !fence.safety?.quiescent) {
        const operation = await prepareIsolateRecoveryControl(fence.identity);
        if (operation) {
          const status = await controlQueuedIsolateReview(fence.identity, operation);
          if (!status && operation === 'status')
            await controlQueuedIsolateReview(fence.identity, 'cancel');
        }
      }
      await resumeQueuedIsolateFinalization(fence.identity, options);
    } catch {
      continue;
    }
  }
}

const StatusSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    safety: QueuedIsolateSafetySchema,
  })
  .strict();

export type QueuedIsolatePayload = Awaited<ReturnType<typeof prepareIsolateReviewPayload>>;

export async function getIsolateFenceForAttempt(reviewId: string, attemptId: string) {
  const [attempt] = await db
    .select()
    .from(cloud_agent_code_review_attempts)
    .where(
      and(
        eq(cloud_agent_code_review_attempts.code_review_id, reviewId),
        eq(cloud_agent_code_review_attempts.id, attemptId)
      )
    );
  const fence = attempt ? publicationFromAttempt(attempt) : null;
  if (!fence) throw new Error('Isolate attempt publication fence is missing');
  if (
    attempt.reviewer_backend !== 'isolate' ||
    attempt.reviewer_execution_id !== attemptId ||
    fence.identity.reviewId !== reviewId ||
    fence.identity.attemptId !== attemptId
  )
    throw new Error('Isolate attempt publication identity mismatch');
  return fence;
}

async function request(
  path: string,
  identity: QueuedIsolateIdentity,
  body: unknown,
  headers: Record<string, string>
) {
  if (!ISOLATE_REVIEW_WORKER_URL || !INTERNAL_API_SECRET)
    throw new Error('ISOLATE_REVIEW_WORKER_URL or INTERNAL_API_SECRET is not configured');
  const response = await fetch(`${ISOLATE_REVIEW_WORKER_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': INTERNAL_API_SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Queued isolate request failed: ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Queued isolate response is empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 16_384) {
      void reader.cancel().catch(() => {});
      throw new Error('Queued isolate response is too large');
    }
    chunks.push(chunk.value);
  }
  const status = StatusSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!sameQueuedIsolateIdentity(status.identity, identity))
    throw new Error('Queued isolate response identity mismatch');
  return status;
}

export async function startQueuedIsolateReview(payload: QueuedIsolatePayload) {
  const admission = QueuedIsolateAdmissionSchema.parse(payload.admission);
  const review = IsolateReviewRequestSchema.parse(payload.review);
  const status = await request(
    '/queued-reviews',
    admission.identity,
    { admission, review },
    {
      Authorization: `Bearer ${payload.authToken}`,
    }
  );
  if (!status) throw new Error('Queued isolate admission is unavailable');
  return status;
}

export async function controlQueuedIsolateReview(
  input: QueuedIsolateIdentity,
  operation: 'status' | 'cancel'
) {
  const identity = QueuedIsolateIdentitySchema.parse(input);
  if (!INTERNAL_API_SECRET) throw new Error('Isolate control secret is unavailable');
  const token = await deriveCallbackToken({
    secret: INTERNAL_API_SECRET,
    scope: 'queued-isolate-control',
    resourceParts: [operation, JSON.stringify(identity)],
  });
  return request(
    `/queued-reviews/${identity.attemptId}/control`,
    identity,
    { version: 1, identity, operation },
    {
      'x-isolate-control-token': token,
    }
  );
}
