import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  user_deletion_activity,
  user_deletion_audit_events,
  user_deletion_requests,
  user_deletion_steps,
  type UserDeletionActivity,
  type UserDeletionAuditEvent,
  type UserDeletionRequest,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import {
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
} from '@kilocode/db/schema-types';
import { readDb } from '@/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { catalogForVersion } from '@/lib/user/deletion-queue/deletion-catalog';
import { USER_DELETION_STALE_REQUEST_MS } from '@/lib/user/deletion-queue/deletion-constants';
import {
  cancelPendingDeletionRequest,
  enqueueUserDeletionTargets,
} from '@/lib/user/deletion-queue/deletion-enqueue';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import { inspectDeletionTargets } from '@/lib/user/deletion-queue/deletion-preview';
import {
  markTaskManuallyVerified,
  retryAttentionTask,
  retryBlockedPreflight,
} from '@/lib/user/deletion-queue/deletion-outcomes';
import {
  deleteSubstackCredential,
  getSubstackCredentialMeta,
  replaceSubstackCredential,
  testStoredSubstackCredential,
  testSubstackCredentialMaterial,
} from '@/lib/user/deletion-queue/deletion-substack-credential';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

const ACTIVE_STATUS_CONDITION = inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES);

const ListTabSchema = z.enum([
  'open',
  'needs_attention',
  'rate_limited',
  'in_progress',
  'completed',
  'cancelled',
]);

const StepKeySchema = z.enum([
  UserDeletionStepKey.KiloclawDestroy,
  UserDeletionStepKey.Customerio,
  UserDeletionStepKey.CliV1Blobs,
  UserDeletionStepKey.CliV2Sessions,
  UserDeletionStepKey.UsagePromptPrefixes,
  UserDeletionStepKey.Posthog,
  UserDeletionStepKey.Substack,
  UserDeletionStepKey.Anonymize,
  UserDeletionStepKey.PylonReply,
  UserDeletionStepKey.PylonContact,
]);

const EntrySchema = z
  .object({
    email: z.string().max(320).optional(),
    pylonTicket: z.string().max(256).optional(),
  })
  .refine(entry => Boolean(entry.email?.trim() || entry.pylonTicket?.trim()));

const EntriesInputSchema = z.object({
  entries: z.array(EntrySchema).min(1).max(100),
});

const ListInputSchema = z.object({
  tab: ListTabSchema,
  searchEmail: z.string().trim().min(1).max(320).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(512).optional(),
});

const RequestIdSchema = z.object({ requestId: z.string().uuid() });

const RetryTaskInputSchema = z.object({
  requestId: z.string().uuid(),
  stepKey: StepKeySchema,
  reason: z.string().trim().min(1).max(500),
});

const RetryPreflightInputSchema = z.object({
  requestId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});

const VerifyTaskInputSchema = z.object({
  requestId: z.string().uuid(),
  stepKey: StepKeySchema,
  reason: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(2000),
});

const ReplaceCredentialInputSchema = z.object({
  material: z.string().min(1).max(16_000),
});

const COMPLETED_WINDOW_DAYS = 7;

type ListTab = z.infer<typeof ListTabSchema>;

function iso(value: string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: string | null): string | null {
  return value === null ? null : iso(value);
}

function failClosed(code: TRPCError['code'], message: string): never {
  throw new TRPCError({ code, message });
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\t${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const split = decoded.indexOf('\t');
    if (split <= 0) return null;
    const createdAt = decoded.slice(0, split);
    const id = decoded.slice(split + 1);
    if (!createdAt || !z.string().uuid().safeParse(id).success) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function isTerminalStatus(status: UserDeletionRequestStatus): boolean {
  return (
    status === UserDeletionRequestStatus.Completed || status === UserDeletionRequestStatus.Cancelled
  );
}

function isStaleRequest(lastProgressAt: string, asOf: string): boolean {
  return (
    new Date(asOf).getTime() - new Date(lastProgressAt).getTime() >= USER_DELETION_STALE_REQUEST_MS
  );
}

function taskProgress(step: UserDeletionStep) {
  return {
    processedCount: step.progress_json.processed_count ?? 0,
    scannedCount: step.progress_json.scanned_count ?? 0,
    pageOffset: step.progress_json.page_offset ?? null,
    cleanPass: step.progress_json.clean_pass ?? false,
  };
}

function serializeTaskSummary(step: UserDeletionStep) {
  const progress = taskProgress(step);
  return {
    stepKey: step.step_key,
    status: step.status,
    lastErrorCode: step.last_error_code,
    windowAttemptCount: step.window_attempt_count,
    lifetimeAttemptCount: step.lifetime_attempt_count,
    availableAt: iso(step.available_at),
    processedCount: progress.processedCount,
    scannedCount: progress.scannedCount,
    pageOffset: progress.pageOffset,
    cleanPass: progress.cleanPass,
    rateLimitedSince: nullableIso(step.rate_limited_since),
  };
}

function serializeRequest(request: UserDeletionRequest, tasks: UserDeletionStep[], asOf: string) {
  const terminal = isTerminalStatus(request.status);
  const catalog = catalogForVersion(request.catalog_version);
  const byKey = new Map(tasks.map(task => [task.step_key, task]));
  return {
    id: request.id,
    status: request.status,
    catalogVersion: request.catalog_version,
    email: terminal ? null : request.target_email,
    userId: terminal ? null : request.user_id,
    pylonTicket: terminal ? null : request.pylon_ticket_ref,
    requestedByKiloUserId: request.requested_by_kilo_user_id,
    cloudSubjectResolution: request.cloud_subject_resolution,
    preflightAttentionCode: request.preflight_attention_code,
    createdAt: iso(request.created_at),
    lastProgressAt: iso(request.last_progress_at),
    anonymizedAt: nullableIso(request.anonymized_at),
    completedAt: nullableIso(request.completed_at),
    cancelledAt: nullableIso(request.cancelled_at),
    stale: !terminal && isStaleRequest(request.last_progress_at, asOf),
    tasks: catalog.map(entry => {
      const step = byKey.get(entry.stepKey);
      if (!step) {
        return {
          stepKey: entry.stepKey,
          status: UserDeletionStepStatus.Pending,
          lastErrorCode: null,
          windowAttemptCount: 0,
          lifetimeAttemptCount: 0,
          availableAt: iso(request.created_at),
          processedCount: 0,
          scannedCount: 0,
          pageOffset: null,
          cleanPass: false,
          rateLimitedSince: null,
          allowsManualVerification: entry.allowsManualVerification,
        };
      }
      return {
        ...serializeTaskSummary(step),
        allowsManualVerification: entry.allowsManualVerification,
      };
    }),
  };
}

function serializeActivity(row: UserDeletionActivity) {
  return {
    id: row.id,
    stepKey: row.step_key,
    eventType: row.event_type,
    details: {
      durationMs: row.details_json.duration_ms ?? null,
      processedCount: row.details_json.processed_count ?? null,
      scannedCount: row.details_json.scanned_count ?? null,
      httpStatusClass: row.details_json.http_status_class ?? null,
      retryAt: row.details_json.retry_at ?? null,
      errorCode: row.details_json.error_code ?? null,
      resourceHmac: row.details_json.resource_hmac ?? null,
    },
    createdAt: iso(row.created_at),
  };
}

function serializeAudit(row: UserDeletionAuditEvent) {
  return {
    id: row.id,
    eventType: row.event_type,
    actorKiloUserId: row.actor_kilo_user_id,
    subjectKey: row.subject_key,
    details: row.details_json,
    createdAt: iso(row.created_at),
  };
}

function tabCondition(tab: ListTab) {
  if (tab === 'open') {
    return ACTIVE_STATUS_CONDITION;
  }
  if (tab === 'in_progress') {
    return sql`${user_deletion_requests.status} = 'in_progress'`;
  }
  if (tab === 'completed') {
    return sql`${user_deletion_requests.status} = 'completed'`;
  }
  if (tab === 'cancelled') {
    return sql`${user_deletion_requests.status} = 'cancelled'`;
  }
  if (tab === 'needs_attention') {
    return sql`${ACTIVE_STATUS_CONDITION}
      AND (
        ${user_deletion_requests.preflight_attention_code} IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM user_deletion_steps s
          WHERE s.request_id = ${user_deletion_requests.id}
            AND s.status IN ('needs_attention', 'manual_action_required')
        )
      )`;
  }
  return sql`${ACTIVE_STATUS_CONDITION}
    AND EXISTS (
      SELECT 1 FROM user_deletion_steps s
      WHERE s.request_id = ${user_deletion_requests.id}
        AND (
          s.rate_limited_since IS NOT NULL
          OR (s.status = 'retry_wait' AND s.last_error_code = 'rate_limited')
        )
    )`;
}

export const adminUserDeletionQueueRouter = createTRPCRouter({
  preview: adminProcedure.input(EntriesInputSchema).mutation(({ ctx, input }) => {
    return inspectDeletionTargets(input.entries, {
      id: ctx.user.id,
      email: ctx.user.google_user_email,
    });
  }),

  submit: adminProcedure.input(EntriesInputSchema).mutation(async ({ ctx, input }) => {
    return enqueueUserDeletionTargets({
      actor: { kiloUserId: ctx.user.id, email: ctx.user.google_user_email },
      targets: input.entries,
    });
  }),

  list: adminProcedure.input(ListInputSchema).query(async ({ input }) => {
    const asOfResult = await readDb.execute<{ as_of: string }>(sql`SELECT now() AS as_of`);
    const asOf = iso(asOfResult.rows[0]?.as_of ?? new Date().toISOString());
    const conditions = [tabCondition(input.tab)];

    if (input.searchEmail) {
      conditions.push(
        eq(
          user_deletion_requests.target_email_hmac,
          hmacDeletionEmail(input.searchEmail.trim().toLowerCase())
        )
      );
    }

    const parsedCursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (parsedCursor) {
      conditions.push(
        sql`(${user_deletion_requests.created_at}, ${user_deletion_requests.id}) < (${parsedCursor.createdAt}::timestamptz, ${parsedCursor.id}::uuid)`
      );
    }

    const rows = await readDb
      .select()
      .from(user_deletion_requests)
      .where(and(...conditions))
      .orderBy(desc(user_deletion_requests.created_at), desc(user_deletion_requests.id))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last ? encodeCursor(last.created_at, last.id) : null;

    const requestIds = page.map(row => row.id);
    const steps =
      requestIds.length === 0
        ? []
        : await readDb
            .select()
            .from(user_deletion_steps)
            .where(inArray(user_deletion_steps.request_id, requestIds));

    const stepsByRequest = new Map<string, UserDeletionStep[]>();
    for (const step of steps) {
      const existing = stepsByRequest.get(step.request_id) ?? [];
      existing.push(step);
      stepsByRequest.set(step.request_id, existing);
    }

    return {
      asOf,
      nextCursor,
      rows: page.map(request =>
        serializeRequest(request, stepsByRequest.get(request.id) ?? [], asOf)
      ),
    };
  }),

  detail: adminProcedure.input(RequestIdSchema).query(async ({ input }) => {
    const asOfResult = await readDb.execute<{ as_of: string }>(sql`SELECT now() AS as_of`);
    const asOf = iso(asOfResult.rows[0]?.as_of ?? new Date().toISOString());
    const [request] = await readDb
      .select()
      .from(user_deletion_requests)
      .where(eq(user_deletion_requests.id, input.requestId))
      .limit(1);
    if (!request) failClosed('NOT_FOUND', 'Deletion request not found');

    const [tasks, activity, audit] = await Promise.all([
      readDb
        .select()
        .from(user_deletion_steps)
        .where(eq(user_deletion_steps.request_id, input.requestId)),
      readDb
        .select()
        .from(user_deletion_activity)
        .where(eq(user_deletion_activity.request_id, input.requestId))
        .orderBy(desc(user_deletion_activity.created_at))
        .limit(100),
      readDb
        .select()
        .from(user_deletion_audit_events)
        .where(eq(user_deletion_audit_events.request_id, input.requestId))
        .orderBy(desc(user_deletion_audit_events.created_at))
        .limit(100),
    ]);

    const serialized = serializeRequest(request, tasks, asOf);
    return {
      asOf,
      request: serialized,
      tasks: serialized.tasks.map(task => {
        const step = tasks.find(row => row.step_key === task.stepKey);
        const evidence = step?.manual_evidence_json;
        return {
          ...task,
          manualEvidence: evidence
            ? {
                reason: evidence.reason,
                evidence: evidence.evidence,
                actorKiloUserId: evidence.actor_kilo_user_id,
                recordedAt: evidence.recorded_at,
              }
            : null,
        };
      }),
      activity: activity.map(serializeActivity),
      audit: audit.map(serializeAudit),
    };
  }),

  summary: adminProcedure.query(async () => {
    const count = async (condition: ReturnType<typeof tabCondition>) => {
      const [row] = await readDb
        .select({ count: sql<number>`count(*)::int` })
        .from(user_deletion_requests)
        .where(condition);
      return Number(row?.count ?? 0) || 0;
    };

    const [queued, needsAttention, [completed]] = await Promise.all([
      count(tabCondition('open')),
      count(tabCondition('needs_attention')),
      readDb
        .select({ count: sql<number>`count(*)::int` })
        .from(user_deletion_requests)
        .where(
          and(
            eq(user_deletion_requests.status, UserDeletionRequestStatus.Completed),
            sql`${user_deletion_requests.completed_at} >= now() - interval '7 days'`
          )
        ),
    ]);

    return {
      queued,
      needsAttention,
      completedLast7Days: Number(completed?.count ?? 0) || 0,
      completedWindowDays: COMPLETED_WINDOW_DAYS,
    };
  }),

  cancel: adminProcedure.input(RequestIdSchema).mutation(async ({ ctx, input }) => {
    const result = await cancelPendingDeletionRequest({
      requestId: input.requestId,
      actorKiloUserId: ctx.user.id,
    });
    if (result.cancelled) return { cancelled: true as const };
    if (result.code === 'not_found') failClosed('NOT_FOUND', 'Deletion request not found');
    failClosed('PRECONDITION_FAILED', 'Only pending requests can be cancelled');
  }),

  retryTask: adminProcedure.input(RetryTaskInputSchema).mutation(async ({ ctx, input }) => {
    try {
      const retried = await retryAttentionTask({
        requestId: input.requestId,
        stepKey: input.stepKey,
        actorKiloUserId: ctx.user.id,
        reason: input.reason,
      });
      if (!retried) {
        failClosed('PRECONDITION_FAILED', 'Task is not eligible for retry');
      }
      return { retried: true as const };
    } catch (error) {
      if (error instanceof Error && error.message === 'Retry reason is required') {
        failClosed('BAD_REQUEST', error.message);
      }
      throw error;
    }
  }),

  retryPreflight: adminProcedure
    .input(RetryPreflightInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const retried = await retryBlockedPreflight({
          requestId: input.requestId,
          actorKiloUserId: ctx.user.id,
          reason: input.reason,
        });
        if (!retried) {
          failClosed('PRECONDITION_FAILED', 'Preflight is not eligible for retry');
        }
        return { retried: true as const };
      } catch (error) {
        if (error instanceof Error && error.message === 'Retry reason is required') {
          failClosed('BAD_REQUEST', error.message);
        }
        throw error;
      }
    }),

  verifyTask: adminProcedure.input(VerifyTaskInputSchema).mutation(async ({ ctx, input }) => {
    try {
      const verified = await markTaskManuallyVerified({
        requestId: input.requestId,
        stepKey: input.stepKey,
        actorKiloUserId: ctx.user.id,
        reason: input.reason,
        evidence: input.evidence,
      });
      if (!verified) {
        failClosed('PRECONDITION_FAILED', 'Task is not eligible for manual verification');
      }
      return { verified: true as const };
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message === 'Manual verification requires reason and evidence' ||
          error.message === 'Manual verification evidence must not contain email addresses'
        ) {
          failClosed('BAD_REQUEST', error.message);
        }
      }
      throw error;
    }
  }),

  substackCredential: adminProcedure.query(async () => {
    return getSubstackCredentialMeta();
  }),

  testSubstackCredential: adminProcedure
    .input(z.object({ material: z.string().min(1).max(16_000).optional() }))
    .mutation(async ({ input }) => {
      if (input.material) {
        return testSubstackCredentialMaterial(input.material);
      }
      return testStoredSubstackCredential();
    }),

  replaceSubstackCredential: adminProcedure
    .input(ReplaceCredentialInputSchema)
    .mutation(async ({ ctx, input }) => {
      await replaceSubstackCredential({
        material: input.material,
        actorKiloUserId: ctx.user.id,
      });
      return { stored: true as const };
    }),

  deleteSubstackCredential: adminProcedure.mutation(async () => {
    return deleteSubstackCredential();
  }),
});
