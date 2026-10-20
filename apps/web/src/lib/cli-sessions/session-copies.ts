import 'server-only';

import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cliSessions, sharedCliSessions } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  SessionBlobCopyTooLargeError,
  copyBlobs,
  deleteBlobs,
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

/**
 * Reserve the share row for a session and state, or hand back the one that
 * already exists. A caller that gets `reused` must not copy anything: the
 * existing link keeps the snapshot it was published with.
 */
export async function reserveSharedSession({
  kiloUserId,
  sessionId,
  sharedState,
}: ReserveSharedSessionParams): Promise<{ shareId: string; reused: boolean }> {
  return db.transaction(async tx => {
    await lockOwnerCopies(tx, kiloUserId);

    const [existing] = await tx
      .select({ share_id: sharedCliSessions.share_id })
      .from(sharedCliSessions)
      .where(
        and(
          eq(sharedCliSessions.session_id, sessionId),
          eq(sharedCliSessions.kilo_user_id, kiloUserId),
          eq(sharedCliSessions.shared_state, sharedState)
        )
      )
      .limit(1);

    if (existing) return { shareId: existing.share_id, reused: true };

    const [totals] = await tx
      .select({ shareCount: count() })
      .from(sharedCliSessions)
      .where(eq(sharedCliSessions.kilo_user_id, kiloUserId));

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

    return { shareId: row.share_id, reused: false };
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
  values: Omit<typeof cliSessions.$inferInsert, 'session_id'>
): Promise<string> {
  return db.transaction(async tx => {
    await lockOwnerCopies(tx, kiloUserId);

    const [totals] = await tx
      .select({ forkCount: count() })
      .from(cliSessions)
      .where(and(eq(cliSessions.kilo_user_id, kiloUserId), isNotNull(cliSessions.forked_from)));

    if (totals.forkCount >= CLI_SESSION_FORK_MAX_PER_OWNER) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `An account can hold ${CLI_SESSION_FORK_MAX_PER_OWNER} forked sessions. Delete a forked session before forking another.`,
      });
    }

    const sessionId = crypto.randomUUID();
    await tx.insert(cliSessions).values({ session_id: sessionId, ...values });
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

/** Undo a share reservation whose copy did not complete. */
export async function discardReservedShare(shareId: string): Promise<void> {
  try {
    await deleteBlobs(shareId, sessionBlobRefs('shared-sessions'));
  } catch {
    // Whatever the copy managed to write is unreferenced once the row is gone,
    // and a cleanup failure must not replace the error that caused the discard.
  }
  await db.delete(sharedCliSessions).where(eq(sharedCliSessions.share_id, shareId));
}

/** Undo a fork reservation whose copy did not complete. */
export async function discardReservedFork(sessionId: string): Promise<void> {
  try {
    await deleteBlobs(sessionId, sessionBlobRefs('sessions'));
  } catch {
    // Same reasoning as {@link discardReservedShare}.
  }
  await db.delete(cliSessions).where(eq(cliSessions.session_id, sessionId));
}

/** Delete the shared-sessions object copies of the given shares. */
export async function deleteSharedSessionCopies(shareIds: string[]): Promise<void> {
  for (const shareId of shareIds) {
    await deleteBlobs(shareId, sessionBlobRefs('shared-sessions'));
  }
}
