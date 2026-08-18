import { eq, inArray, or } from 'drizzle-orm';
import { cliSessions, sharedCliSessions } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { deleteBlobs, type FileName } from '@/lib/r2/cli-sessions';
import { USER_DELETION_RESOURCE_BATCH_SIZE } from '@/lib/user/deletion-queue/deletion-constants';
import { userIdKeyedAbsenceOutcome } from '@/lib/user/deletion-queue/deletion-subject';
import {
  continueIfLowTime,
  incrementProcessed,
  providerAbortSignal,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';

const SESSION_BLOB_COLUMNS = [
  'api_conversation_history_blob_url',
  'task_metadata_blob_url',
  'ui_messages_blob_url',
  'git_state_blob_url',
] as const;

type SessionBlobColumn = (typeof SESSION_BLOB_COLUMNS)[number];
type BlobFilename = SessionBlobColumn extends `${infer Base}_blob_url` ? Base : never;

const FILENAME_BY_COLUMN = {
  api_conversation_history_blob_url: 'api_conversation_history',
  task_metadata_blob_url: 'task_metadata',
  ui_messages_blob_url: 'ui_messages',
  git_state_blob_url: 'git_state',
} as const satisfies Record<SessionBlobColumn, BlobFilename>;

type SessionRow = {
  kind: 'session';
  id: string;
  api_conversation_history_blob_url: string | null;
  task_metadata_blob_url: string | null;
  ui_messages_blob_url: string | null;
  git_state_blob_url: string | null;
};

type SharedRow = {
  kind: 'shared';
  id: string;
  api_conversation_history_blob_url: string | null;
  task_metadata_blob_url: string | null;
  ui_messages_blob_url: string | null;
  git_state_blob_url: string | null;
};

type BlobRow = SessionRow | SharedRow;

function blobsForRow(
  row: BlobRow
): { folderName: 'sessions' | 'shared-sessions'; filename: FileName }[] {
  const folderName = row.kind === 'session' ? 'sessions' : 'shared-sessions';
  const blobs: { folderName: 'sessions' | 'shared-sessions'; filename: FileName }[] = [];
  for (const column of SESSION_BLOB_COLUMNS) {
    if (row[column]) {
      blobs.push({ folderName, filename: FILENAME_BY_COLUMN[column] });
    }
  }
  return blobs;
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const code =
    'Code' in error && typeof error.Code === 'string'
      ? error.Code
      : '$metadata' in error &&
          typeof error.$metadata === 'object' &&
          error.$metadata &&
          'httpStatusCode' in error.$metadata &&
          error.$metadata.httpStatusCode === 404
        ? 'NotFound'
        : '';
  return (
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    name === 'NotFoundException' ||
    code === 'NotFound' ||
    code === 'NoSuchKey'
  );
}

async function loadCliV1Rows(userId: string): Promise<BlobRow[]> {
  const userCliSessionIdsQuery = db
    .select({ session_id: cliSessions.session_id })
    .from(cliSessions)
    .where(eq(cliSessions.kilo_user_id, userId));

  const shared = await db
    .select({
      id: sharedCliSessions.share_id,
      api_conversation_history_blob_url: sharedCliSessions.api_conversation_history_blob_url,
      task_metadata_blob_url: sharedCliSessions.task_metadata_blob_url,
      ui_messages_blob_url: sharedCliSessions.ui_messages_blob_url,
      git_state_blob_url: sharedCliSessions.git_state_blob_url,
    })
    .from(sharedCliSessions)
    .where(
      or(
        eq(sharedCliSessions.kilo_user_id, userId),
        inArray(sharedCliSessions.session_id, userCliSessionIdsQuery)
      )
    )
    .limit(USER_DELETION_RESOURCE_BATCH_SIZE);

  const rows: BlobRow[] = shared.map(row => ({ kind: 'shared', ...row }));
  if (rows.length >= USER_DELETION_RESOURCE_BATCH_SIZE) return rows;

  const sessions = await db
    .select({
      id: cliSessions.session_id,
      api_conversation_history_blob_url: cliSessions.api_conversation_history_blob_url,
      task_metadata_blob_url: cliSessions.task_metadata_blob_url,
      ui_messages_blob_url: cliSessions.ui_messages_blob_url,
      git_state_blob_url: cliSessions.git_state_blob_url,
    })
    .from(cliSessions)
    .where(eq(cliSessions.kilo_user_id, userId))
    .limit(USER_DELETION_RESOURCE_BATCH_SIZE - rows.length);

  for (const row of sessions) {
    rows.push({ kind: 'session', ...row });
  }
  return rows;
}

async function deleteRow(row: BlobRow): Promise<void> {
  if (row.kind === 'shared') {
    await db.delete(sharedCliSessions).where(eq(sharedCliSessions.share_id, row.id));
    return;
  }
  await db.delete(cliSessions).where(eq(cliSessions.session_id, row.id));
}

export const handleCliV1Blobs: DeletionHandler = async ({ request, step, context }) => {
  const absence = userIdKeyedAbsenceOutcome(request);
  if (absence) return absence;
  const userId = request.user_id;
  if (!userId) return { kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' };

  const stop = continueIfLowTime(context, step.progress_json);
  if (stop) return stop;

  const rows = await loadCliV1Rows(userId);
  const startedEmpty = (step.progress_json.processed_count ?? 0) === 0 && rows.length === 0;
  if (rows.length === 0) {
    return startedEmpty
      ? { kind: 'not_applicable' }
      : { kind: 'succeeded', progress: step.progress_json };
  }

  let progress = step.progress_json;
  for (const row of rows) {
    const reserve = continueIfLowTime(context, progress);
    if (reserve) return reserve;

    const blobs = blobsForRow(row);
    if (blobs.length > 0) {
      try {
        await deleteBlobs(row.id, blobs, { signal: providerAbortSignal(context) });
      } catch (error) {
        if (!isMissingObjectError(error)) {
          return {
            kind: 'retry',
            errorCode: 'blob_delete_failed',
            httpStatusClass: 'error',
          };
        }
      }
    }

    const afterBlobs = continueIfLowTime(context, progress);
    if (afterBlobs) return afterBlobs;

    await deleteRow(row);
    progress = incrementProcessed(progress);
  }

  const remaining = await loadCliV1Rows(userId);
  if (remaining.length > 0) {
    return { kind: 'continue', progress };
  }
  return { kind: 'succeeded', progress };
};
