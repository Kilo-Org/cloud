import { sql } from 'drizzle-orm';
import type { UserDeletionTaskProgress } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import {
  USER_DELETION_ANONYMIZE_MIN_STATEMENT_TIMEOUT_MS,
  USER_DELETION_ANONYMIZE_PAGE_TIMEOUT_MS,
  USER_DELETION_ANONYMIZE_TIMEOUT_BUFFER_MS,
} from '@/lib/user/deletion-queue/deletion-constants';
import { userIdKeyedAbsenceOutcome } from '@/lib/user/deletion-queue/deletion-subject';
import type {
  DeletionHandlerContext,
  DeletionHandlerOutcome,
} from '@/lib/user/deletion-queue/deletion-types';
import {
  continueIfLowTime,
  incrementProcessed,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';
import {
  deleteOwnedByUserIdPage,
  OWNED_BY_USER_DELETE_PAGE_SIZE,
  OWNED_BY_USER_DELETE_TABLES,
  type OwnedByUserDeleteTable,
} from '@/lib/user/owned-by-user-batch-delete';

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

type DrainResult =
  | { kind: 'drained'; progress: UserDeletionTaskProgress | undefined }
  | DeletionHandlerOutcome;

async function drainOwnedTable(params: {
  userId: string;
  table: OwnedByUserDeleteTable;
  context: DeletionHandlerContext;
  progress: UserDeletionTaskProgress | undefined;
}): Promise<DrainResult> {
  let progress = params.progress;
  while (true) {
    const stop = continueIfLowTime(params.context, progress);
    if (stop) return stop;

    let deleted: number;
    try {
      deleted = await db.transaction(async tx => {
        await tx.execute(
          sql.raw(`SET LOCAL statement_timeout = ${USER_DELETION_ANONYMIZE_PAGE_TIMEOUT_MS}`)
        );
        return deleteOwnedByUserIdPage(
          tx,
          params.table,
          params.userId,
          OWNED_BY_USER_DELETE_PAGE_SIZE
        );
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === '57014') {
        return {
          kind: 'retry',
          errorCode: 'anonymize_page_timeout',
          httpStatusClass: 'error',
          progress,
        };
      }
      if (code === '40001' || code === '40P01') {
        return {
          kind: 'retry',
          errorCode: 'anonymize_page_failed',
          httpStatusClass: 'error',
          progress,
        };
      }
      throw error;
    }

    if (deleted === 0) return { kind: 'drained', progress };
    progress = incrementProcessed(progress, deleted);
  }
}

export const handleAnonymize: DeletionHandler = async ({ request, step, context }) => {
  const absence = userIdKeyedAbsenceOutcome(request);
  if (absence) return absence;
  const userId = request.user_id;
  if (!userId) return { kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' };

  const stop = continueIfLowTime(context);
  if (stop) return stop;

  let progress = step.progress_json;
  for (const table of OWNED_BY_USER_DELETE_TABLES) {
    const drained = await drainOwnedTable({ userId, table, context, progress });
    if (drained.kind !== 'drained') return drained;
    progress = drained.progress;
  }

  const remainingMs = context.remainingMs();
  if (
    remainingMs - USER_DELETION_ANONYMIZE_TIMEOUT_BUFFER_MS <
    USER_DELETION_ANONYMIZE_MIN_STATEMENT_TIMEOUT_MS
  ) {
    return { kind: 'continue', progress };
  }

  return (progress?.processed_count ?? 0) > 0 ? { kind: 'succeeded', progress } : { kind: 'succeeded' };
};
