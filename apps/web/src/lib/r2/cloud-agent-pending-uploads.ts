import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import { and, count, eq, inArray, like, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@kilocode/web-shared/lib/r2/client';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
} from '@/lib/cloud-agent/constants';
import { cloud_agent_pending_uploads } from '@kilocode/db/schema';

const CLOUD_AGENT_PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Objects purged per reaper run, so one cron invocation always finishes. */
const CLOUD_AGENT_PENDING_UPLOAD_PURGE_BATCH = 500;

export type AdmitPendingUploadParams = {
  kiloUserId: string;
  messageUuid: string;
  attachmentId: string;
  objectKey: string;
  /** Key admitted instead of objectKey when objectKey's row is no longer 'pending'. */
  freshObjectKey: string;
  byteSize: number;
};

/**
 * Admit a presigned upload into the pending-upload ledger and return the
 * admitted object key. Runs in one transaction: take the per-(user, message)
 * advisory lock, count pending rows, reject at the file-count bound, reject
 * oversized uploads, then admit a pending row with a 24-hour lease.
 *
 * A client Retry presigns the same ids. If the attachment already has a
 * 'pending' row, that row is refreshed in place, keeps its key (which can be
 * an earlier fresh key), and does not count against the bound. Otherwise a
 * row for objectKey in any other state keeps its key, and the upload gets freshObjectKey:
 * a release or reaper claim sets 'reaped' before its DeleteObject runs, so a
 * PUT to the old key could land before that delete, and a 'linked' key holds
 * an attachment a dispatched message refers to. The row is later flipped to
 * 'linked' by linkPendingUploads before the message is dispatched, or to
 * 'reaped' once its object is deleted.
 */
export async function admitPendingUpload({
  kiloUserId,
  messageUuid,
  attachmentId,
  objectKey,
  freshObjectKey,
  byteSize,
}: AdmitPendingUploadParams): Promise<string> {
  return db.transaction(async tx => {
    // The composer presigns every attached file at once, so an unlocked
    // count-then-insert lets parallel admits all read the same count and
    // insert past the bound. The lock releases on commit or rollback.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`cloud-agent-pending-upload:${kiloUserId}:${messageUuid}`}))`
    );

    // A retry of this attachment: same id and same key suffix. A different
    // suffix is a different file type, so its row must not be reused.
    const suffix = objectKey.slice(objectKey.lastIndexOf('.'));
    const sameAttachment = and(
      eq(cloud_agent_pending_uploads.attachment_id, attachmentId),
      like(cloud_agent_pending_uploads.object_key, `%${suffix}`)
    );

    const pendingRows = await tx
      .select({ pendingCount: count() })
      .from(cloud_agent_pending_uploads)
      .where(
        and(
          eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
          eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
          eq(cloud_agent_pending_uploads.status, 'pending'),
          not(sameAttachment ?? sql`false`)
        )
      );
    const pendingCount = pendingRows[0]?.pendingCount ?? 0;

    if (pendingCount >= CLOUD_AGENT_ATTACHMENT_MAX_COUNT) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} attachments allowed per message`,
      });
    }

    if (byteSize > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Attachment exceeds the maximum size',
      });
    }

    const expiresAt = new Date(Date.now() + CLOUD_AGENT_PENDING_UPLOAD_TTL_MS).toISOString();

    // Release, the reaper and linkPendingUploads do not take this lock, so the
    // status check must be in the same statement as the refresh.
    const refreshed = await tx
      .update(cloud_agent_pending_uploads)
      .set({ byte_size: byteSize, expires_at: expiresAt })
      .where(
        and(
          eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
          eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
          sameAttachment,
          eq(cloud_agent_pending_uploads.status, 'pending')
        )
      )
      .returning({ object_key: cloud_agent_pending_uploads.object_key });
    const refreshedKey = refreshed[0]?.object_key;
    if (refreshedKey !== undefined) return refreshedKey;

    const row = {
      kilo_user_id: kiloUserId,
      message_uuid: messageUuid,
      attachment_id: attachmentId,
      byte_size: byteSize,
      status: 'pending',
      expires_at: expiresAt,
    };
    const inserted = await tx
      .insert(cloud_agent_pending_uploads)
      .values({ ...row, id: randomUUID(), object_key: objectKey })
      .onConflictDoNothing({ target: cloud_agent_pending_uploads.object_key })
      .returning({ id: cloud_agent_pending_uploads.id });
    if (inserted.length > 0) return objectKey;

    await tx
      .insert(cloud_agent_pending_uploads)
      .values({ ...row, id: randomUUID(), object_key: freshObjectKey });
    return freshObjectKey;
  });
}

export type LinkPendingUploadsResult = {
  /**
   * Requested keys whose row is 'reaped', so the object behind them is gone or
   * being deleted. A message referencing one of these must not be dispatched.
   */
  reapedObjectKeys: string[];
};

/**
 * Flip pending ledger rows to 'linked' for a user's message in one guarded
 * update. Rows whose object keys are not in the supplied set stay 'pending',
 * so a partial key set leaves unmatched uploads to be reaped. A row already
 * 'linked' belongs to an earlier dispatch of the same message and is reported
 * as neither linked now nor reaped.
 */
export async function linkPendingUploads(
  kiloUserId: string,
  messageUuid: string,
  objectKeys: string[]
): Promise<LinkPendingUploadsResult> {
  if (objectKeys.length === 0) return { reapedObjectKeys: [] };

  await db
    .update(cloud_agent_pending_uploads)
    .set({ status: 'linked' })
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
        eq(cloud_agent_pending_uploads.status, 'pending'),
        inArray(cloud_agent_pending_uploads.object_key, objectKeys)
      )
    );

  // Read back what the guarded update could not link. A row that a release or
  // a reaper claim already took out of 'pending' is 'reaped', and its object is
  // going away, so the caller must not dispatch a message that references it.
  const rows = await db
    .select({
      object_key: cloud_agent_pending_uploads.object_key,
      status: cloud_agent_pending_uploads.status,
    })
    .from(cloud_agent_pending_uploads)
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
        eq(cloud_agent_pending_uploads.status, 'reaped'),
        inArray(cloud_agent_pending_uploads.object_key, objectKeys)
      )
    );

  return { reapedObjectKeys: rows.map(row => row.object_key) };
}

/** Message for a send or prepare whose attachment object is already gone. */
export const CLOUD_AGENT_ATTACHMENT_EXPIRED_MESSAGE =
  'Attachment upload expired. Add the file again to send it.';

/**
 * Link the ledger rows of one message's attachments before its dispatch, so
 * the objects survive the reaper, and refuse the dispatch when a row was
 * already reaped. Keys with no ledger row belong to an uploader that predates
 * the ledger and are left alone.
 */
export async function linkAttachmentsForDispatch(
  kiloUserId: string,
  attachments: { path: string; files: string[] } | undefined
): Promise<void> {
  if (!attachments || attachments.files.length === 0) return;

  const { reapedObjectKeys } = await linkPendingUploads(
    kiloUserId,
    attachments.path,
    attachments.files.map(file => `${kiloUserId}/cloud-agent/${attachments.path}/${file}`)
  );

  if (reapedObjectKeys.length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: CLOUD_AGENT_ATTACHMENT_EXPIRED_MESSAGE,
    });
  }
}

export type ReapAbandonedUploadsSummary = {
  reaped: number;
};

/**
 * Delete these private objects one by one and report which keys succeeded and
 * which failed. Deleting an absent key is a no-op, so a retry is safe.
 */
async function deletePendingUploadObjects(
  objectKeys: string[]
): Promise<{ deletedKeys: string[]; failedKeys: string[] }> {
  const deletedKeys: string[] = [];
  const failedKeys: string[] = [];
  for (const objectKey of objectKeys) {
    try {
      await r2Client.send(
        new DeleteObjectCommand({
          Bucket: r2CloudAgentAttachmentsBucketName,
          Key: objectKey,
        })
      );
      deletedKeys.push(objectKey);
    } catch (error) {
      console.error('[cloud-agent] Failed to delete abandoned upload', objectKey, error);
      failedKeys.push(objectKey);
    }
  }
  return { deletedKeys, failedKeys };
}

/**
 * Claim these rows in one statement, delete their objects, then put back to
 * 'pending' any row whose delete failed so a later reaper run retries it.
 * Claiming in the same guarded update that selects the rows is what makes the
 * ledger the single authority for a delete: a row that a link or a release has
 * already moved out of the predicate is never claimed, and the flip to
 * 'reaped' commits before DeleteObject runs. Every dispatch links a message's
 * attachment rows before the worker can accept the turn, so a row that is
 * still claimable belongs to no accepted message. Returns the number of objects
 * actually deleted.
 */
async function claimAndDeleteUploadObjects(claim: SQL | undefined): Promise<number> {
  const claimed = await db
    .update(cloud_agent_pending_uploads)
    .set({ status: 'reaped' })
    .where(claim)
    .returning({ object_key: cloud_agent_pending_uploads.object_key });

  if (claimed.length === 0) return 0;

  const { deletedKeys, failedKeys } = await deletePendingUploadObjects(
    claimed.map(row => row.object_key)
  );

  if (failedKeys.length > 0) {
    await db
      .update(cloud_agent_pending_uploads)
      .set({ status: 'pending' })
      .where(
        and(
          eq(cloud_agent_pending_uploads.status, 'reaped'),
          inArray(cloud_agent_pending_uploads.object_key, failedKeys)
        )
      );
  }

  return deletedKeys.length;
}

/**
 * Release a set of pending rows back out of the per-message quota when the
 * caller abandons the files before sending (e.g. removes them from the
 * composer). Only the caller's own 'pending' rows are claimed; 'linked' rows
 * (already sent) and other users' rows stay untouched.
 */
export async function releasePendingUploads(
  kiloUserId: string,
  objectKeys: string[]
): Promise<void> {
  if (objectKeys.length === 0) return;

  await claimAndDeleteUploadObjects(
    and(
      eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
      eq(cloud_agent_pending_uploads.status, 'pending'),
      inArray(cloud_agent_pending_uploads.object_key, objectKeys)
    )
  );
}

/**
 * Delete the private objects behind every pending upload this user admitted,
 * so account deletion does not drop the only handle the reaper has on them.
 */
export async function purgeUserPendingUploads(kiloUserId: string): Promise<void> {
  await claimAndDeleteUploadObjects(
    and(
      eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
      eq(cloud_agent_pending_uploads.status, 'pending')
    )
  );
}

/**
 * Delete the private R2 objects behind abandoned pending uploads whose
 * 24-hour lease has lapsed, one bounded batch per run. The batch is picked in
 * the same statement that claims it, and the claim re-checks 'pending' and the
 * lease, so a row linked or refreshed since the pick is skipped rather than
 * stripped of its object.
 */
export async function reapAbandonedUploads(): Promise<ReapAbandonedUploadsSummary> {
  const expiredBatch = db
    .select({ id: cloud_agent_pending_uploads.id })
    .from(cloud_agent_pending_uploads)
    .where(
      and(
        eq(cloud_agent_pending_uploads.status, 'pending'),
        sql`${cloud_agent_pending_uploads.expires_at} < now()`
      )
    )
    .limit(CLOUD_AGENT_PENDING_UPLOAD_PURGE_BATCH);

  return {
    reaped: await claimAndDeleteUploadObjects(
      and(
        eq(cloud_agent_pending_uploads.status, 'pending'),
        // The row is re-read when the claim writes it, so a lease that a retry
        // presign refreshed after the batch was picked must not be reaped.
        sql`${cloud_agent_pending_uploads.expires_at} < now()`,
        inArray(cloud_agent_pending_uploads.id, expiredBatch)
      )
    ),
  };
}
