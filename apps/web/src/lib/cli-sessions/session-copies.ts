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
 * Serialize the row writes of one account. `pg_advisory_xact_lock` releases on
 * commit or rollback, so the lock never outlives the transaction that writes a
 * share row. A hash collision only serializes two accounts; it never admits a
 * copy that should have been refused.
 */
async function lockOwnerCopies(tx: DrizzleTransaction, kiloUserId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('cli_session_copy'), hashtext(${kiloUserId}))`
  );
}

/** Copy turns in flight in this process, one per account. */
const ownerCopyTurns = new Map<string, Promise<void>>();

/**
 * Run the storage work of one account's copy, keeping that account's copies to
 * one at a time in this process. An awaiting copy holds no database client.
 */
export async function withOwnerCopyTurn<T>(
  kiloUserId: string,
  copyWork: () => Promise<T>
): Promise<T> {
  const previous = ownerCopyTurns.get(kiloUserId) ?? Promise.resolve();
  const started = previous.then(copyWork, copyWork);
  const settled = started.then(
    () => undefined,
    () => undefined
  );
  ownerCopyTurns.set(kiloUserId, settled);

  try {
    return await started;
  } finally {
    if (ownerCopyTurns.get(kiloUserId) === settled) {
      ownerCopyTurns.delete(kiloUserId);
    }
  }
}

export type PublishSharedSessionCopyParams = {
  kiloUserId: string;
  sessionId: string;
  sharedState: string;
};

/** Blob urls one copy wrote, one entry per blob type the source had. */
export type CopiedSessionBlobUrls = Partial<Record<BlobUrlKeys, string>>;

/** One row per blob type; a missing copy is stored as NULL rather than left out. */
export function blobUrlColumns(copiedBlobs: CopiedSessionBlobUrls) {
  return {
    api_conversation_history_blob_url: copiedBlobs.api_conversation_history_blob_url ?? null,
    task_metadata_blob_url: copiedBlobs.task_metadata_blob_url ?? null,
    ui_messages_blob_url: copiedBlobs.ui_messages_blob_url ?? null,
    git_state_blob_url: copiedBlobs.git_state_blob_url ?? null,
  };
}

type SharedSessionCopyRow = Pick<
  typeof sharedCliSessions.$inferSelect,
  | 'share_id'
  | 'api_conversation_history_blob_url'
  | 'task_metadata_blob_url'
  | 'ui_messages_blob_url'
  | 'git_state_blob_url'
  | 'pending_copy_ids'
>;

/** Columns a copy decision reads; shared by the publish and fork paths. */
export const sharedSessionCopyColumns = {
  share_id: sharedCliSessions.share_id,
  api_conversation_history_blob_url: sharedCliSessions.api_conversation_history_blob_url,
  task_metadata_blob_url: sharedCliSessions.task_metadata_blob_url,
  ui_messages_blob_url: sharedCliSessions.ui_messages_blob_url,
  git_state_blob_url: sharedCliSessions.git_state_blob_url,
  pending_copy_ids: sharedCliSessions.pending_copy_ids,
} as const;

/**
 * Copy folders the published blob urls point at. A row whose urls are not
 * published yet has no folder of its own, so this never falls back to the
 * share id.
 */
export function publishedShareCopyIds(share: SharedSessionCopyRow): string[] {
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

  return [...copyIds];
}

export function sharedSessionCurrentCopyIds(share: SharedSessionCopyRow): string[] {
  const copyIds = publishedShareCopyIds(share);

  if (copyIds.length === 0) {
    copyIds.push(share.share_id);
  }

  return copyIds;
}

/** Current storage folder for a link, used when copying it into a fork. */
export function sharedSessionCurrentCopyId(share: SharedSessionCopyRow): string {
  return sharedSessionCurrentCopyIds(share)[0];
}

/** Current and pending shared-session folders, used by cleanup paths. */
export function sharedSessionCopyIds(share: SharedSessionCopyRow): string[] {
  return [...new Set([...sharedSessionCurrentCopyIds(share), ...share.pending_copy_ids])];
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
): Promise<CopiedSessionBlobUrls> {
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

/** Refuse a share once the account holds {@link CLI_SESSION_SHARE_MAX_PER_OWNER}. */
function shareAllowanceError(): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: `An account can hold ${CLI_SESSION_SHARE_MAX_PER_OWNER} shared sessions. Delete a shared session before sharing another.`,
  });
}

type ShareCountClient = Pick<DrizzleTransaction, 'select'>;

/** Shared sessions one account holds, the same count at admission and at publish. */
async function ownerShareCount(client: ShareCountClient, kiloUserId: string): Promise<number> {
  const [totals] = await client
    .select({ shareCount: count() })
    .from(sharedCliSessions)
    .where(
      and(eq(sharedCliSessions.kilo_user_id, kiloUserId), isNotNull(sharedCliSessions.session_id))
    );

  return totals?.shareCount ?? 0;
}

function shareRowWhere(kiloUserId: string, sessionId: string, sharedState: string) {
  return and(
    eq(sharedCliSessions.session_id, sessionId),
    eq(sharedCliSessions.kilo_user_id, kiloUserId),
    eq(sharedCliSessions.shared_state, sharedState)
  );
}

/**
 * Publish a fresh copy for an existing link or create a link after its first
 * copy completes. The row and the allowance are read first, the blobs are
 * copied next, and the row is written in a short transaction that takes the
 * owner lock and the row lock, so refreshes, first publications and deletion of
 * one published link stay serialized.
 */
export async function publishSharedSessionCopy({
  kiloUserId,
  sessionId,
  sharedState,
}: PublishSharedSessionCopyParams): Promise<{ share_id: string; session_id: string }> {
  const [admitted] = await db
    .select(sharedSessionCopyColumns)
    .from(sharedCliSessions)
    .where(shareRowWhere(kiloUserId, sessionId, sharedState))
    .limit(1);

  if (!admitted && (await ownerShareCount(db, kiloUserId)) >= CLI_SESSION_SHARE_MAX_PER_OWNER) {
    throw shareAllowanceError();
  }

  return withOwnerCopyTurn(kiloUserId, async () => {
    const pendingCopyIds = admitted?.pending_copy_ids ?? [];
    if (pendingCopyIds.length > 0) {
      await deleteSharedSessionCopies(pendingCopyIds);
    }

    const copyId = crypto.randomUUID();
    let published: { shareId: string; previousCopyIds: string[] };

    try {
      const copiedBlobs = await copySessionBlobs(sessionId, 'sessions', copyId, 'shared-sessions');

      published = await db.transaction(async tx => {
        await lockOwnerCopies(tx, kiloUserId);

        const [stored] = await tx
          .select(sharedSessionCopyColumns)
          .from(sharedCliSessions)
          .where(shareRowWhere(kiloUserId, sessionId, sharedState))
          .limit(1)
          .for('update');

        if (!stored) {
          if (admitted) {
            // The link we were refreshing is gone; its copy must not resurrect it.
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Shared session not found' });
          }

          if ((await ownerShareCount(tx, kiloUserId)) >= CLI_SESSION_SHARE_MAX_PER_OWNER) {
            throw shareAllowanceError();
          }

          const shareId = crypto.randomUUID();
          await tx.insert(sharedCliSessions).values({
            share_id: shareId,
            session_id: sessionId,
            kilo_user_id: kiloUserId,
            shared_state: sharedState,
            ...blobUrlColumns(copiedBlobs),
          });

          return { shareId, previousCopyIds: [] };
        }

        const previousCopyIds = publishedShareCopyIds(stored);
        await tx
          .update(sharedCliSessions)
          .set({
            ...blobUrlColumns(copiedBlobs),
            pending_copy_ids: previousCopyIds,
          })
          .where(eq(sharedCliSessions.share_id, stored.share_id));

        return { shareId: stored.share_id, previousCopyIds };
      });
    } catch (error) {
      try {
        await deleteSharedSessionCopies([copyId]);
      } catch {
        // A cleanup failure must not replace the error that stopped the publish.
      }
      throw error;
    }

    for (const previousCopyId of published.previousCopyIds) {
      try {
        await deleteSharedSessionCopies([previousCopyId]);
        await clearPendingSharedSessionCopy(published.shareId, previousCopyId);
      } catch {
        // The row retains this folder id so a later refresh or account cleanup can retry it.
      }
    }

    return { share_id: published.shareId, session_id: sessionId };
  });
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

/** Attempts at deleting a link's objects before the deletion reports failure. */
const SHARE_BLOB_DELETE_ATTEMPTS = 3;

async function deleteShareBlobsWithRetry(copyIds: string[]): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < SHARE_BLOB_DELETE_ATTEMPTS; attempt += 1) {
    try {
      await deleteSharedSessionCopies(copyIds);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** Attempts at removing one link row while publications of it keep landing. */
const SHARE_ROW_DELETE_ATTEMPTS = 3;

/**
 * Remove one published link together with every copy folder it can point at.
 * A short transaction under the owner lock records the row's folders in
 * pending_copy_ids, the objects are deleted outside any transaction, and a
 * second short transaction deletes the row only when no publication recorded a
 * folder in between. Otherwise the new folder is taken over and the deletion
 * repeats, so no folder a live row references is left behind. A failing object
 * deletion leaves the row and its pending ids for a later retry.
 */
export async function deleteSharedSessionCopyRow(shareId: string): Promise<void> {
  const [identified] = await db
    .select({ kilo_user_id: sharedCliSessions.kilo_user_id })
    .from(sharedCliSessions)
    .where(eq(sharedCliSessions.share_id, shareId))
    .limit(1);

  if (!identified) return;

  const kiloUserId = identified.kilo_user_id;
  let knownCopyIds: string[] = [];

  for (let attempt = 0; attempt < SHARE_ROW_DELETE_ATTEMPTS; attempt += 1) {
    const recordedCopyIds = await db.transaction(async tx => {
      await lockOwnerCopies(tx, kiloUserId);

      const [locked] = await tx
        .select(sharedSessionCopyColumns)
        .from(sharedCliSessions)
        .where(eq(sharedCliSessions.share_id, shareId))
        .limit(1)
        .for('update');

      if (!locked) return null;

      const copyIds = sharedSessionCopyIds(locked);
      await tx
        .update(sharedCliSessions)
        .set({ pending_copy_ids: copyIds })
        .where(eq(sharedCliSessions.share_id, shareId));

      return copyIds;
    });

    if (!recordedCopyIds) return;

    knownCopyIds = [...new Set([...knownCopyIds, ...recordedCopyIds])];
    await deleteShareBlobsWithRetry(knownCopyIds);

    const removed = await db.transaction(async tx => {
      await lockOwnerCopies(tx, kiloUserId);

      const [locked] = await tx
        .select(sharedSessionCopyColumns)
        .from(sharedCliSessions)
        .where(eq(sharedCliSessions.share_id, shareId))
        .limit(1)
        .for('update');

      if (!locked) return true;
      if (sharedSessionCopyIds(locked).some(copyId => !knownCopyIds.includes(copyId))) {
        return false;
      }

      await tx.delete(sharedCliSessions).where(eq(sharedCliSessions.share_id, shareId));
      return true;
    });

    if (removed) return;
  }

  throw new TRPCError({
    code: 'CONFLICT',
    message: 'The shared session changed while it was being deleted. Try deleting it again.',
  });
}

async function clearPendingSharedSessionCopy(shareId: string, copyId: string): Promise<void> {
  await db.transaction(async tx => {
    const [share] = await tx
      .select({ pending_copy_ids: sharedCliSessions.pending_copy_ids })
      .from(sharedCliSessions)
      .where(eq(sharedCliSessions.share_id, shareId))
      .for('update');

    if (!share) return;

    await tx
      .update(sharedCliSessions)
      .set({
        pending_copy_ids: share.pending_copy_ids.filter(pendingId => pendingId !== copyId),
      })
      .where(eq(sharedCliSessions.share_id, shareId));
  });
}
