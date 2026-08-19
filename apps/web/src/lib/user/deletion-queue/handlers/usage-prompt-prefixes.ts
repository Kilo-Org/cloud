import { and, eq, sql } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionStepStatus, type UserDeletionTaskProgress } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_USAGE_PREFIX_BATCH_SIZE,
  USER_DELETION_USAGE_PREFIX_STATEMENT_TIMEOUT_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import { continueIfLowTime } from '@/lib/user/deletion-queue/handlers/common';
import type { DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';
import { userIdKeyedAbsenceOutcome } from '@/lib/user/deletion-queue/deletion-subject';
import { scrubUsagePromptPrefixesPage, type UsagePromptPrefixCursor } from '@/lib/user';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParsedUsagePrefixProgress = {
  cursor: UsagePromptPrefixCursor | null;
  processedCount: number;
  scannedCount: number;
};

function parseOptionalCount(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function parseUsagePrefixProgress(
  progress: UserDeletionTaskProgress
): ParsedUsagePrefixProgress | null {
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) {
    return null;
  }

  const rawProgress = progress as {
    processed_count?: unknown;
    scanned_count?: unknown;
    cursor?: unknown;
  };
  const processedCount = parseOptionalCount(rawProgress.processed_count);
  const scannedCount = parseOptionalCount(rawProgress.scanned_count);
  if (processedCount === null || scannedCount === null) return null;

  const rawCursor = rawProgress.cursor;
  if (rawCursor === undefined || rawCursor === '') {
    return { cursor: null, processedCount, scannedCount };
  }
  if (typeof rawCursor !== 'string') return null;

  const separator = rawCursor.indexOf('\t');
  if (
    separator <= 0 ||
    separator !== rawCursor.lastIndexOf('\t') ||
    separator === rawCursor.length - 1
  ) {
    return null;
  }

  const createdAt = rawCursor.slice(0, separator);
  const id = rawCursor.slice(separator + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !UUID_RE.test(id)) return null;

  return {
    cursor: { createdAt, id },
    processedCount,
    scannedCount,
  };
}

function encodeCursor(cursor: UsagePromptPrefixCursor): string {
  return `${cursor.createdAt}\t${cursor.id}`;
}

function postgresErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return null;
}

class UsagePrefixClaimLostError extends Error {
  constructor() {
    super('usage prompt prefix claim lost');
    this.name = 'UsagePrefixClaimLostError';
  }
}

export const handleUsagePromptPrefixes: DeletionHandler = async ({ request, step, context }) => {
  const absence = userIdKeyedAbsenceOutcome(request);
  if (absence) return absence;
  const userId = request.user_id;
  if (!userId) return { kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' };

  let parsedProgress = parseUsagePrefixProgress(step.progress_json);
  if (!parsedProgress) {
    return { kind: 'needs_attention', errorCode: 'usage_prefix_progress_invalid' };
  }

  let progress: UserDeletionTaskProgress = step.progress_json;

  while (true) {
    const stop = continueIfLowTime(context, progress);
    if (stop) return stop;

    try {
      const result = await db.transaction(async tx => {
        await tx.execute(
          sql.raw(
            `SET LOCAL statement_timeout = ${USER_DELETION_USAGE_PREFIX_STATEMENT_TIMEOUT_MS}`
          )
        );

        const [lockedStep] = await tx
          .select({ id: user_deletion_steps.id })
          .from(user_deletion_steps)
          .where(
            and(
              eq(user_deletion_steps.request_id, request.id),
              eq(user_deletion_steps.step_key, context.stepKey),
              eq(user_deletion_steps.claim_token, context.claimToken),
              eq(user_deletion_steps.status, UserDeletionStepStatus.Running)
            )
          )
          .for('update');
        if (!lockedStep) throw new UsagePrefixClaimLostError();

        const page = await scrubUsagePromptPrefixesPage(
          tx,
          userId,
          parsedProgress.cursor,
          USER_DELETION_USAGE_PREFIX_BATCH_SIZE
        );
        if (page.pageSize === 0) return { page, progress };

        const nextProgress: UserDeletionTaskProgress = {
          processed_count: parsedProgress.processedCount + page.updatedCount,
          scanned_count: parsedProgress.scannedCount + page.pageSize,
          cursor: page.lastCursor ? encodeCursor(page.lastCursor) : undefined,
        };
        const checkpoint = await tx
          .update(user_deletion_steps)
          .set({ progress_json: nextProgress })
          .where(eq(user_deletion_steps.id, lockedStep.id))
          .returning({ id: user_deletion_steps.id });
        if (checkpoint.length !== 1) throw new UsagePrefixClaimLostError();

        await tx
          .update(user_deletion_requests)
          .set({ last_progress_at: sql`now()` })
          .where(eq(user_deletion_requests.id, request.id));

        return { page, progress: nextProgress };
      });

      if (result.page.pageSize === 0) {
        return parsedProgress.processedCount === 0 && parsedProgress.scannedCount === 0
          ? { kind: 'not_applicable' }
          : { kind: 'succeeded', progress };
      }

      progress = result.progress;
      parsedProgress = {
        cursor: result.page.lastCursor,
        processedCount: parsedProgress.processedCount + result.page.updatedCount,
        scannedCount: parsedProgress.scannedCount + result.page.pageSize,
      };
      if (result.page.pageSize < USER_DELETION_USAGE_PREFIX_BATCH_SIZE) {
        return { kind: 'succeeded', progress };
      }
      if (result.page.updatedCount > 0) {
        return { kind: 'continue', progress };
      }
    } catch (error) {
      if (error instanceof UsagePrefixClaimLostError) {
        return { kind: 'retry', errorCode: 'claim_lost', httpStatusClass: 'error' };
      }
      const code = postgresErrorCode(error);
      if (code === '57014') {
        return {
          kind: 'retry',
          errorCode: 'usage_prefix_page_timeout',
          httpStatusClass: 'error',
        };
      }
      if (code === '40001' || code === '40P01') {
        return {
          kind: 'retry',
          errorCode: 'usage_prefix_page_failed',
          httpStatusClass: 'error',
        };
      }
      throw error;
    }
  }
};
