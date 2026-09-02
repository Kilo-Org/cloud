import { createHash } from 'node:crypto';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import {
  classifyCodeReviewProviderFailure,
  type CodeReviewProviderFailureReason,
} from '@kilocode/worker-utils/code-review-provider-failure';
import { z } from 'zod';
import { resolveSecret } from './auth';
import {
  QueuedIsolateAcknowledgementSchema,
  QueuedIsolateAdmissionSchema,
  QueuedIsolateAuthorityRequestSchema,
  QueuedIsolateAuthorityResponseSchema,
  QueuedIsolateIdentitySchema,
  queuedIdentityKey,
  QueuedIsolateNotificationSchema,
  QueuedIsolateSafetySchema,
  QueuedIsolateResultSchema,
  StartReviewRequestSchema,
  type Env,
  type QueuedIsolateIdentity,
  type RunState,
  type StartReviewRequest,
} from './types';

export const QueuedReviewRequestSchema = z
  .object({ admission: QueuedIsolateAdmissionSchema, review: StartReviewRequestSchema })
  .strict()
  .superRefine(({ admission, review }, ctx) => {
    const identity = admission.identity;
    if (
      review.dryRun !== false ||
      review.gitToken !== undefined ||
      review.previousRunId !== undefined ||
      (review.reviewMode !== undefined && review.reviewMode !== 'full') ||
      !review.preparation ||
      !review.inference ||
      review.expectedAppType !== 'standard' ||
      review.preparation.executionUserId !== identity.executionUserId ||
      review.organizationId !== identity.organizationId ||
      review.expectedIntegrationId !== identity.integrationId ||
      `${review.owner}/${review.repo}`.toLowerCase() !== identity.target.repoFullName ||
      review.pullNumber !== identity.target.prNumber ||
      review.headSha !== identity.snapshot.headSha ||
      review.baseTipSha !== identity.snapshot.baseTipSha ||
      review.mergeBaseSha !== identity.snapshot.mergeBaseSha ||
      createHash('sha256').update(JSON.stringify(review)).digest('hex') !==
        admission.preparationHash
    ) {
      ctx.addIssue({ code: 'custom', message: 'Queued review does not match canonical admission' });
    }
  });
export type QueuedReviewRequest = z.infer<typeof QueuedReviewRequestSchema>;

const QueuedPublicationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['review', 'summary']),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(['prepared', 'sent', 'confirmed', 'rejected', 'not_sent']),
    requestBody: z.string().max(263_168).optional(),
    responseId: z.number().int().positive().safe().optional(),
    commentId: z.number().int().positive().safe().optional(),
    bodyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type QueuedPublication = z.infer<typeof QueuedPublicationSchema>;

export const QueuedReviewStateSchema = z
  .object({
    identity: QueuedIsolateIdentitySchema,
    preparationHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    admitted: z.boolean(),
    cancellationRequested: z.boolean(),
    callback: z.object({ url: z.url(), token: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    maintenanceScheduleId: z.string().min(1).max(256),
    operations: z.array(QueuedPublicationSchema).max(4),
    safety: QueuedIsolateSafetySchema,
    result: QueuedIsolateResultSchema.optional(),
    fenceReleased: z.boolean().default(false),
    pendingNotification: QueuedIsolateNotificationSchema.optional(),
    acknowledgedSequence: z.number().int().nonnegative().safe(),
    cleaned: z.boolean(),
  })
  .strict();
export type QueuedReviewState = z.infer<typeof QueuedReviewStateSchema>;

export class QueuedReviewConflictError extends Error {
  constructor() {
    super('Queued review identity or accepted preparation conflicts with this attempt');
    this.name = 'QueuedReviewConflictError';
  }
}

export function queuedPreparationHash(review: StartReviewRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(StartReviewRequestSchema.parse(review)))
    .digest('hex');
}

export function getQueuedReviewIsolateStub(env: Env, attemptId: string) {
  return env.REVIEW_ISOLATE.getByName(`queued-review:${z.uuid().parse(attemptId)}`);
}

export function assertQueuedIdentity(state: RunState, identity: QueuedIsolateIdentity): void {
  if (!state.queued || queuedIdentityKey(state.queued.identity) !== queuedIdentityKey(identity)) {
    throw new QueuedReviewConflictError();
  }
}

export async function queuedCallback(env: Env, identity: QueuedIsolateIdentity) {
  const base = new URL(env.KILOCODE_BACKEND_BASE_URL ?? 'https://app.kilo.ai');
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    (env.ENVIRONMENT === 'production'
      ? base.origin !== 'https://app.kilo.ai'
      : base.protocol !== 'https:' &&
        !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  )
    throw new Error('Invalid queued review backend origin');
  const url = new URL(`/api/internal/code-review-status/${identity.reviewId}`, base);
  url.searchParams.set('attemptId', identity.attemptId);
  url.searchParams.set('backend', 'isolate');
  return {
    url: url.toString(),
    token: await deriveCallbackToken({
      secret: await resolveSecret(env.INTERNAL_API_SECRET),
      scope: 'queued-isolate-callback',
      resourceParts: [queuedIdentityKey(identity)],
    }),
  };
}

export function updateQueuedSafety(state: RunState, finalText?: string): RunState {
  if (!state.queued) return state;
  const queued = QueuedReviewStateSchema.parse(state.queued);
  const terminal = state.status === 'completed' || state.status === 'error';
  const lastLine = finalText
    ?.trimEnd()
    .split(/\r\n|\n|\r/)
    .at(-1);
  const marker = lastLine?.startsWith('<!-- kilo-review-analytics:') ? lastLine : null;
  const markerFits = marker !== null && new TextEncoder().encode(marker).byteLength <= 17_000;
  const result =
    queued.result ??
    (terminal
      ? QueuedIsolateResultSchema.parse({
          reason:
            state.terminationReason ??
            (state.status === 'completed' ? 'completed' : 'submission_error'),
          completedAt: state.completedAt ?? new Date().toISOString(),
          sessions: [
            { sessionId: state.runId, parentSessionId: null },
            ...(state.taskSessions ?? []).map(({ sessionId, parentSessionId }) => ({
              sessionId,
              parentSessionId,
            })),
          ].map(session => ({
            ...session,
            requestCount:
              state.usageRequestCounts || !state.requestIds?.length
                ? (state.usageRequestCounts?.[session.sessionId] ?? 0)
                : undefined,
          })),
          summary:
            state.summaryPublished && state.summaryCommentId && state.summaryBodyHash
              ? { commentId: state.summaryCommentId, bodyHash: state.summaryBodyHash }
              : null,
          gateResult: state.gateResult ?? null,
          analytics: {
            marker: markerFits ? marker : null,
            omitted: marker !== null && !markerFits,
          },
        })
      : undefined);
  const operations = queued.operations.map(operation =>
    terminal && operation.state === 'prepared'
      ? { ...operation, state: 'not_sent' as const }
      : operation
  );
  const unresolved = operations.some(operation => operation.state === 'sent');
  const publication = unresolved
    ? terminal
      ? 'uncertain'
      : 'pending'
    : operations.length
      ? 'settled'
      : 'not_started';
  const execution = terminal
    ? state.terminationReason === 'cancelled'
      ? 'cancelled'
      : state.status === 'completed'
        ? 'completed'
        : 'failed'
    : queued.safety.execution === 'running' ||
        state.status === 'running' ||
        state.status === 'cloning'
      ? 'running'
      : 'not_started';
  const next = {
    ...queued.safety,
    execution,
    cancellationRequested: queued.cancellationRequested,
    publication,
    quiescent: terminal && !unresolved,
  } satisfies z.infer<typeof QueuedIsolateSafetySchema>;
  const changed = JSON.stringify(next) !== JSON.stringify(queued.safety);
  const safety = QueuedIsolateSafetySchema.parse(
    changed ? { ...next, sequence: next.sequence + 1, observedAt: new Date().toISOString() } : next
  );
  return {
    ...state,
    queued: {
      ...queued,
      operations,
      safety,
      result,
      pendingNotification:
        queued.pendingNotification ??
        (safety.sequence > queued.acknowledgedSequence
          ? { version: 1, identity: queued.identity, safety, ...(result ? { result } : {}) }
          : undefined),
    },
  };
}

async function callbackRequest(
  callback: QueuedReviewState['callback'],
  body: unknown
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(callback.url, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Callback-Token': callback.token },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Queued review callback unavailable');
    }
    return await readQueuedJson(response);
  } finally {
    clearTimeout(timeout);
  }
}

export async function readQueuedJson(response: Response, maxBytes = 16_384): Promise<unknown> {
  if (!response.body) throw new Error('Missing queued response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error('Queued response is not a byte stream');
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Queued response exceeds limit');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const GatewayFailureSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  message: z.string().optional(),
  error_type: z.string().optional(),
});

export async function readQueuedProviderFailure(
  response: Response
): Promise<CodeReviewProviderFailureReason | null> {
  try {
    const parsed = GatewayFailureSchema.safeParse(await readQueuedJson(response));
    if (!parsed.success) return null;
    const { error, message, error_type } = parsed.data;
    return (
      classifyCodeReviewProviderFailure(typeof error === 'string' ? error : error?.message) ??
      classifyCodeReviewProviderFailure(message) ??
      (error_type === 'provider_not_allowed' ? 'selected_model_unavailable' : null)
    );
  } catch {
    return null;
  }
}

async function queuedAuthorityResponse(
  queued: QueuedReviewState,
  operation: 'execute' | 'publish' | 'reconcile',
  operationId: string
) {
  const request = QueuedIsolateAuthorityRequestSchema.parse({
    version: 1,
    identity: queued.identity,
    operation,
    operationId,
    preparationHash: queued.preparationHash,
  });
  const response = QueuedIsolateAuthorityResponseSchema.parse(
    await callbackRequest(queued.callback, request)
  );
  const { authorized, reconciliationUserId, ...echo } = response;
  return authorized && JSON.stringify(echo) === JSON.stringify(request)
    ? { authorized, reconciliationUserId }
    : null;
}

export async function requestQueuedAuthority(
  queued: QueuedReviewState,
  operation: 'execute' | 'publish' | 'reconcile',
  operationId: string
): Promise<boolean> {
  return Boolean(await queuedAuthorityResponse(queued, operation, operationId));
}

export async function requestQueuedReconciliation(queued: QueuedReviewState, operationId: string) {
  return (await queuedAuthorityResponse(queued, 'reconcile', operationId))?.reconciliationUserId;
}

export async function notifyQueuedReview(
  queued: QueuedReviewState
): Promise<z.infer<typeof QueuedIsolateAcknowledgementSchema> | undefined> {
  const pending = queued.pendingNotification;
  if (!pending) return undefined;
  const response = QueuedIsolateAcknowledgementSchema.parse(
    await callbackRequest(queued.callback, pending)
  );
  if (
    queuedIdentityKey(response.identity) !== queuedIdentityKey(pending.identity) ||
    response.sequence !== pending.safety.sequence
  )
    throw new Error('Queued review acknowledgement scope mismatch');
  return response;
}
