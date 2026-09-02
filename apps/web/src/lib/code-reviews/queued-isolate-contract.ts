import { z } from 'zod';
import { CodeReviewProviderFailureReasonSchema } from '@kilocode/worker-utils/code-review-provider-failure';
import type { QueuedIsolateIdentity, QueuedIsolateSafety } from '@kilocode/db/schema-types';

export type { QueuedIsolateIdentity, QueuedIsolateSafety } from '@kilocode/db/schema-types';

const ShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const RepoFullNameSchema = z
  .string()
  .max(201)
  .regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/);

export const GithubPublicationTargetSchema = z
  .object({
    host: z.literal('github.com'),
    repoFullName: RepoFullNameSchema,
    prNumber: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export function githubPublicationTarget(repoFullName: string, prNumber: number) {
  return GithubPublicationTargetSchema.parse({
    host: 'github.com',
    repoFullName: repoFullName.toLowerCase(),
    prNumber,
  });
}

export const QueuedIsolateIdentitySchema = z
  .object({
    reviewId: z.uuid(),
    attemptId: z.uuid(),
    generation: z.uuid(),
    organizationId: z.uuid(),
    integrationId: z.uuid(),
    executionUserId: z.string().min(1).max(256),
    target: GithubPublicationTargetSchema,
    snapshot: z
      .object({ headSha: ShaSchema, baseTipSha: ShaSchema, mergeBaseSha: ShaSchema })
      .strict(),
  })
  .strict() satisfies z.ZodType<QueuedIsolateIdentity>;

export const QueuedIsolateSafetySchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    execution: z.enum(['not_started', 'running', 'completed', 'failed', 'cancelled']),
    cancellationRequested: z.boolean(),
    publication: z.enum(['not_started', 'pending', 'uncertain', 'settled']),
    quiescent: z.boolean(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    state =>
      !state.quiescent ||
      ((state.execution === 'completed' ||
        state.execution === 'failed' ||
        state.execution === 'cancelled') &&
        (state.publication === 'not_started' || state.publication === 'settled')),
    'Quiescence requires terminal execution and no unresolved publication'
  ) satisfies z.ZodType<QueuedIsolateSafety>;

export const QueuedIsolateAdmissionSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    identity: QueuedIsolateIdentitySchema,
    preparationHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine(request => request.runId === request.identity.attemptId, 'Run must match attempt');

export const QueuedIsolateAuthorityRequestSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    operation: z.enum(['execute', 'publish', 'reconcile']),
    operationId: z.uuid(),
    preparationHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const QueuedIsolateAuthorityResponseSchema = QueuedIsolateAuthorityRequestSchema.extend({
  authorized: z.boolean(),
  reconciliationUserId: z.string().min(1).max(256).optional(),
}).refine(
  response =>
    (response.authorized && response.operation === 'reconcile') ===
    Boolean(response.reconciliationUserId)
);

export const QueuedIsolateControlRequestSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    operation: z.enum(['status', 'cancel']),
  })
  .strict();

export const QueuedIsolateResultSchema = z
  .object({
    reason: z.enum([
      'completed',
      'cancelled',
      'credentials_expired',
      'admission_deadline',
      'execution_deadline',
      'absolute_deadline',
      'step_limit',
      'parent_incomplete',
      'missing_summary',
      'required_context_incomplete',
      'child_incomplete',
      'publication_incomplete',
      'admission_failed',
      'submission_error',
      ...CodeReviewProviderFailureReasonSchema.options,
      'cleanup',
    ]),
    completedAt: z.iso.datetime(),
    sessions: z
      .array(
        z
          .object({
            sessionId: z.uuid(),
            parentSessionId: z.uuid().nullable(),
            requestCount: z.number().int().nonnegative().max(1_000).optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
    summary: z
      .object({
        commentId: z.number().int().positive().safe(),
        bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
    gateResult: z.enum(['pass', 'fail']).nullable(),
    analytics: z
      .object({
        marker: z
          .string()
          .max(17_000)
          .refine(value => new TextEncoder().encode(value).byteLength <= 17_000)
          .nullable(),
        omitted: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const QueuedIsolatePreparationBindingSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    preparedAt: z.iso.datetime(),
    installationId: z.string().min(1).max(256),
    model: z.string().min(1).max(512),
    gateThreshold: z.enum(['off', 'all', 'warning', 'critical']),
    reviewGuidance: z
      .object({ used: z.boolean(), ref: z.string().max(256).nullable(), truncated: z.boolean() })
      .strict(),
  })
  .strict();

export const QueuedIsolateUsageSettlementSchema = z
  .object({
    unavailableReason: z.literal('billing_incomplete').optional(),
    totals: z
      .object({
        tokensIn: z.number().int().nonnegative().max(2_147_483_647),
        tokensOut: z.number().int().nonnegative().max(2_147_483_647),
        cacheHit: z.number().int().nonnegative().safe(),
        cacheWrite: z.number().int().nonnegative().safe(),
        cost: z.number().int().nonnegative().max(2_147_483_647),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(value => !value.unavailableReason || value.totals === null, {
    message: 'Incomplete billing cannot provide total usage',
  });

export const IsolateWebPublicationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['gate', 'footer']),
    targetId: z.number().int().positive().safe(),
    state: z.enum(['prepared', 'sent', 'confirmed', 'rejected', 'suppressed']),
    body: z.string().max(70_000).optional(),
    previousBodyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    conclusion: z.enum(['success', 'failure', 'cancelled', 'action_required']).optional(),
  })
  .strict();

export const QueuedIsolateNotificationSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    safety: QueuedIsolateSafetySchema,
    result: QueuedIsolateResultSchema.optional(),
  })
  .strict()
  .superRefine((notification, ctx) => {
    const terminal = ['completed', 'failed', 'cancelled'].includes(notification.safety.execution);
    if (terminal !== Boolean(notification.result))
      ctx.addIssue({ code: 'custom', message: 'Terminal notifications require a result' });
    if (notification.result) {
      const { sessions, reason } = notification.result;
      const root = notification.identity.attemptId;
      const seen = new Set<string>();
      for (const session of sessions) {
        if (
          seen.has(session.sessionId) ||
          (session.sessionId === root
            ? session.parentSessionId !== null
            : !session.parentSessionId || !seen.has(session.parentSessionId))
        )
          ctx.addIssue({ code: 'custom', message: 'Invalid execution session tree' });
        seen.add(session.sessionId);
      }
      if (
        sessions[0]?.sessionId !== root ||
        (notification.safety.execution === 'completed') !== (reason === 'completed') ||
        (notification.safety.execution === 'cancelled') !== (reason === 'cancelled')
      )
        ctx.addIssue({ code: 'custom', message: 'Result does not match execution' });
    }
  });

export const QueuedIsolateAcknowledgementSchema = z
  .object({
    version: z.literal(1),
    identity: QueuedIsolateIdentitySchema,
    sequence: z.number().int().positive().safe(),
    notificationRecorded: z.literal(true),
    fenceReleased: z.boolean(),
    usageSettled: z.boolean().default(false),
  })
  .strict();

export function serializeQueuedIsolateSafety(state: QueuedIsolateSafety): QueuedIsolateSafety {
  return QueuedIsolateSafetySchema.parse({
    ...state,
    observedAt: new Date(state.observedAt).toISOString(),
  });
}

export function sameQueuedIsolateIdentity(
  left: QueuedIsolateIdentity,
  right: QueuedIsolateIdentity
): boolean {
  return (
    left.reviewId === right.reviewId &&
    left.attemptId === right.attemptId &&
    left.generation === right.generation &&
    left.organizationId === right.organizationId &&
    left.integrationId === right.integrationId &&
    left.executionUserId === right.executionUserId &&
    left.target.host === right.target.host &&
    left.target.repoFullName === right.target.repoFullName &&
    left.target.prNumber === right.target.prNumber &&
    left.snapshot.headSha === right.snapshot.headSha &&
    left.snapshot.baseTipSha === right.snapshot.baseTipSha &&
    left.snapshot.mergeBaseSha === right.snapshot.mergeBaseSha
  );
}
