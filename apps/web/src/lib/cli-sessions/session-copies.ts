import 'server-only';

import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cliSessions, sharedCliSessions } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  SessionBlobCopyTooLargeError,
  copyBlobs,
  deleteBlobs,
  type BlobUrlKeys,
  type FileName,
  type FolderName,
} from '@/lib/r2/cli-sessions';

export const BLOB_TYPES = [
  'api_conversation_history',
  'task_metadata',
  'ui_messages',
  'git_state',
] as const satisfies readonly FileName[];

/** Largest blob the CLI session upload route accepts, per blob type. */
export const CLI_SESSION_BLOB_MAX_BYTES = 5 * 1024 * 1024;

/** A copy carries every blob type, so it is bounded by the upload cap times the blob count. */
export const CLI_SESSION_COPY_MAX_BYTES = BLOB_TYPES.length * CLI_SESSION_BLOB_MAX_BYTES;

/** Shared sessions one account may hold at a time. */
export const CLI_SESSION_SHARE_MAX_PER_OWNER = 200;

/** Forked sessions one account may hold at a time. */
export const CLI_SESSION_FORK_MAX_PER_OWNER = 200;

/**
 * Every object key of one session folder. Deleting the whole set is idempotent,
 * so callers do not have to know which blob types a session actually has.
 */
export function sessionBlobRefs(
  folderName: FolderName
): { folderName: FolderName; filename: FileName }[] {
  return BLOB_TYPES.map(filename => ({ folderName, filename }));
}

/**
 * Serialize the copy admission of one account. `pg_advisory_xact_lock` releases
 * on commit or rollback, so the lock never outlives the transaction that guards
 * the count-then-insert. A hash collision only serializes two accounts; it
 * never admits a copy that should have been refused.
 */
async function lockOwnerCopies(tx: DrizzleTransaction, kiloUserId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('cli_session_copy'), hashtext(${kiloUserId}))`
  );
}

export type ReserveSharedSessionParams = {
  kiloUserId: string;
  sessionId: string;
  sharedState: string;
};

/** One row per blob type; a missing copy is stored as NULL rather than left out. */
export function blobUrlColumns(copiedBlobs: Partial<Record<BlobUrlKeys, string>>) {
  return {
    api_conversation_history_blob_url: copiedBlobs.api_conversation_history_blob_url ?? null,
    task_metadata_blob_url: copiedBlobs.task_metadata_blob_url ?? null,
    ui_messages_blob_url: copiedBlobs.ui_messages_blob_url ?? null,
    git_state_blob_url: copiedBlobs.git_state_blob_url ?? null,
  };
}

const SHARED_SESSION_URL_COLUMNS = {
  share_id: sharedCliSessions.share_id,
  api_conversation_history_blob_url: sharedCliSessions.api_conversation_history_blob_url,
  task_metadata_blob_url: sharedCliSessions.task_metadata_blob_url,
  ui_messages_blob_url: sharedCliSessions.ui_messages_blob_url,
  git_state_blob_url: sharedCliSessions.git_state_blob_url,
} as const;

/**
 * Reserve the share row for a session and state, or hand back the one that
 * already exists. `needsCopy` is false only for a row that carries a copied
 * blob: the existing link keeps the snapshot it was published with.
 */
export async function reserveSharedSession({
  kiloUserId,
  sessionId,
  sharedState,
}: ReserveSharedSessionParams): Promise<{ shareId: string; needsCopy: boolean }> {
  return db.transaction(async tx => {
    await lockOwnerCopies(tx, kiloUserId);

    const [existing] = await tx
      .select(SHARED_SESSION_URL_COLUMNS)
      .from(sharedCliSessions)
      .where(
        and(
          eq(sharedCliSessions.session_id, sessionId),
          eq(sharedCliSessions.kilo_user_id, kiloUserId),
          eq(sharedCliSessions.shared_state, sharedState)
        )
      )
      .limit(1);

    if (existing) {
      const hasCopiedBlob = BLOB_TYPES.some(filename => existing[`${filename}_blob_url`] != null);
      return { shareId: existing.share_id, needsCopy: !hasCopiedBlob };
    }

    const [totals] = await tx
      .select({ shareCount: count() })
      .from(sharedCliSessions)
      .where(
        and(eq(sharedCliSessions.kilo_user_id, kiloUserId), isNotNull(sharedCliSessions.session_id))
      );

    if (totals.shareCount >= CLI_SESSION_SHARE_MAX_PER_OWNER) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `An account can hold ${CLI_SESSION_SHARE_MAX_PER_OWNER} shared sessions. Delete a shared session before sharing another.`,
      });
    }

    const [row] = await tx
      .insert(sharedCliSessions)
      .values({
        share_id: crypto.randomUUID(),
        session_id: sessionId,
        kilo_user_id: kiloUserId,
        shared_state: sharedState,
      })
      .returning({ share_id: sharedCliSessions.share_id });

    return { shareId: row.share_id, needsCopy: true };
  });
}

/**
 * Reserve the session row for a fork, or refuse once the account holds
 * {@link CLI_SESSION_FORK_MAX_PER_OWNER} forks. The row is inserted with no
 * blob urls; the caller adds them once the copy succeeds, so an admitted fork
 * can never publish a row that points at nothing.
 */
export async function reserveForkedSession(
  kiloUserId: string,
  values: Omit<typeof cliSessions.$inferInsert, 'session_id' | 'is_fork'>
): Promise<string> {
  return db.transaction(async tx => {
    await lockOwnerCopies(tx, kiloUserId);

    const [totals] = await tx
      .select({ forkCount: count() })
      .from(cliSessions)
      .where(and(eq(cliSessions.kilo_user_id, kiloUserId), eq(cliSessions.is_fork, true)));

    if (totals.forkCount >= CLI_SESSION_FORK_MAX_PER_OWNER) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `An account can hold ${CLI_SESSION_FORK_MAX_PER_OWNER} forked sessions. Delete a forked session before forking another.`,
      });
    }

    const sessionId = crypto.randomUUID();
    await tx.insert(cliSessions).values({ session_id: sessionId, is_fork: true, ...values });
    return sessionId;
  });
}

/** Copy every blob of one session into another folder under the copy size limit. */
export async function copySessionBlobs(
  sourceId: string,
  sourceFolder: FolderName,
  destinationId: string,
  destinationFolder: FolderName
) {
  try {
    return await copyBlobs(
      sourceId,
      sourceFolder,
      destinationId,
      destinationFolder,
      [...BLOB_TYPES],
      {
        maxBytes: CLI_SESSION_COPY_MAX_BYTES,
      }
    );
  } catch (error) {
    if (error instanceof SessionBlobCopyTooLargeError) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Session blobs are larger than the ${CLI_SESSION_COPY_MAX_BYTES} byte copy limit.`,
      });
    }
    throw error;
  }
}

/**
 * Undo a fork reservation whose copy did not complete. The row belongs to the
 * request that inserted it, so removing it together with whatever the copy
 * wrote leaves nothing behind.
 */
export async function discardReservedFork(sessionId: string): Promise<void> {
  try {
    await deleteBlobs(sessionId, sessionBlobRefs('sessions'));
  } catch {
    // The row delete below still runs; a cleanup failure must not replace the
    // error that caused the discard.
  }
  await db.delete(cliSessions).where(eq(cliSessions.session_id, sessionId));
}

/** Delete the shared-sessions object copies of the given shares. */
export async function deleteSharedSessionCopies(shareIds: string[]): Promise<void> {
  for (const shareId of shareIds) {
    await deleteBlobs(shareId, sessionBlobRefs('shared-sessions'));
  }
}
