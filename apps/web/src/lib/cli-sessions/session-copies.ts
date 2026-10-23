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

export type PublishSharedSessionCopyParams = {
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

/** Copy-folder ids referenced by a shared-session row. */
export function sharedSessionCopyIds(
  share: Pick<
    typeof sharedCliSessions.$inferSelect,
    | 'share_id'
    | 'api_conversation_history_blob_url'
    | 'task_metadata_blob_url'
    | 'ui_messages_blob_url'
    | 'git_state_blob_url'
  >
): string[] {
  const copyIds = new Set<string>();

  for (const blobUrl of [
    share.api_conversation_history_blob_url,
    share.task_metadata_blob_url,
    share.ui_messages_blob_url,
    share.git_state_blob_url,
  ]) {
    const [folderName, copyId] = blobUrl?.split('/') ?? [];
    if (folderName === 'shared-sessions' && copyId) {
      copyIds.add(copyId);
    }
  }

  if (copyIds.size === 0) {
    copyIds.add(share.share_id);
  }

  return [...copyIds];
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
 * Publish a fresh copy for an existing link or create a link after its first
 * copy completes. The owner lock keeps allowance accounting atomic, while the
 * row lock serializes refreshes and deletion of one published link.
 */
export async function publishSharedSessionCopy({
  kiloUserId,
  sessionId,
  sharedState,
}: PublishSharedSessionCopyParams): Promise<{ share_id: string; session_id: string }> {
  let copyId: string | undefined;
  let previousCopyIds: string[] = [];

  let shareId: string;
  try {
    shareId = await db.transaction(async tx => {
      await lockOwnerCopies(tx, kiloUserId);

      const [existing] = await tx
        .select({
          share_id: sharedCliSessions.share_id,
          api_conversation_history_blob_url: sharedCliSessions.api_conversation_history_blob_url,
          task_metadata_blob_url: sharedCliSessions.task_metadata_blob_url,
          ui_messages_blob_url: sharedCliSessions.ui_messages_blob_url,
          git_state_blob_url: sharedCliSessions.git_state_blob_url,
        })
        .from(sharedCliSessions)
        .where(
          and(
            eq(sharedCliSessions.session_id, sessionId),
            eq(sharedCliSessions.kilo_user_id, kiloUserId),
            eq(sharedCliSessions.shared_state, sharedState)
          )
        )
        .limit(1)
        .for('update');

      if (!existing) {
        const [totals] = await tx
          .select({ shareCount: count() })
          .from(sharedCliSessions)
          .where(
            and(
              eq(sharedCliSessions.kilo_user_id, kiloUserId),
              isNotNull(sharedCliSessions.session_id)
            )
          );

        if (totals.shareCount >= CLI_SESSION_SHARE_MAX_PER_OWNER) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `An account can hold ${CLI_SESSION_SHARE_MAX_PER_OWNER} shared sessions. Delete a shared session before sharing another.`,
          });
        }
      }

      shareId = existing?.share_id ?? crypto.randomUUID();
      copyId = crypto.randomUUID();
      const copiedBlobs = await copySessionBlobs(sessionId, 'sessions', copyId, 'shared-sessions');

      if (existing) {
        previousCopyIds = sharedSessionCopyIds(existing);
        await tx
          .update(sharedCliSessions)
          .set(blobUrlColumns(copiedBlobs))
          .where(eq(sharedCliSessions.share_id, shareId));
      } else {
        await tx.insert(sharedCliSessions).values({
          share_id: shareId,
          session_id: sessionId,
          kilo_user_id: kiloUserId,
          shared_state: sharedState,
          ...blobUrlColumns(copiedBlobs),
        });
      }

      return shareId;
    });
  } catch (error) {
    if (copyId) {
      try {
        await deleteSharedSessionCopies([copyId]);
      } catch {
        // A cleanup failure must not replace the error that caused the rollback.
      }
    }
    throw error;
  }

  if (previousCopyIds.length > 0) {
    await deleteSharedSessionCopies(previousCopyIds);
  }

  return { share_id: shareId, session_id: sessionId };
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

/** Delete the shared-sessions object copies in the given copy folders. */
export async function deleteSharedSessionCopies(copyIds: string[]): Promise<void> {
  for (const copyId of copyIds) {
    await deleteBlobs(copyId, sessionBlobRefs('shared-sessions'));
  }
}
