import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import { and, asc, count, eq, gt, inArray, like, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@kilocode/web-shared/lib/r2/client';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
  CLOUD_AGENT_PENDING_UPLOAD_PURGE_BATCH,
  CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT,
} from '@/lib/cloud-agent/constants';
import { cloud_agent_pending_uploads } from '@kilocode/db/schema';

const CLOUD_AGENT_PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

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
 * admitted object key. Runs in one transaction: take the per-user advisory
 * lock, count live pending rows per message and per account, reject at either
 * bound, reject oversized uploads, then admit a pending row with a 24-hour
 * lease.
 *
 * A client Retry presigns the same ids. If the attachment already has a
 * 'pending' row, that row is refreshed in place, keeps its key (which can be
 * an earlier fresh key), and does not count against either bound. Otherwise a
 * row for objectKey in any other state keeps its key, and the upload gets freshObjectKey:
 * a release or reaper claim sets 'reaped' before its DeleteObject runs, so a
 * PUT to the old key could land before that delete, and a 'linked' key holds
 * a sent attachment. The row is later flipped to 'linked' by
 * linkPendingUploads when the message is actually sent, or to 'reaped' once
 * its object is deleted.
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
    // The composer presigns every attached file at once, and the account-wide
    // count below spans messages, so an unlocked count-then-insert lets
    // parallel admits all read the same count and insert past a bound. The
    // per-user lock covers both bounds and releases on commit or rollback.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`cloud-agent-pending-upload-user:${kiloUserId}`}))`
    );

    // A retry of this attachment: same id and same key suffix. A different
    // suffix is a different file type, so its row must not be reused.
    const suffix = objectKey.slice(objectKey.lastIndexOf('.'));
    const sameAttachment = and(
      eq(cloud_agent_pending_uploads.attachment_id, attachmentId),
      like(cloud_agent_pending_uploads.object_key, `%${suffix}`)
    );

    const messageCountFilter = and(
      eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
      eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
      eq(cloud_agent_pending_uploads.status, 'pending'),
      not(sameAttachment ?? sql`false`)
    );

    const messageRows = await tx
      .select({ messagePendingCount: count() })
      .from(cloud_agent_pending_uploads)
      .where(messageCountFilter);
    const messagePendingCount = messageRows[0]?.messagePendingCount ?? 0;

    if (messagePendingCount >= CLOUD_AGENT_ATTACHMENT_MAX_COUNT) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} attachments allowed per message`,
      });
    }

    const sameAttachmentInMessage = and(
      sameAttachment,
      eq(cloud_agent_pending_uploads.message_uuid, messageUuid)
    );
    const accountCountFilter = and(
      eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
      eq(cloud_agent_pending_uploads.status, 'pending'),
      not(sameAttachmentInMessage ?? sql`false`)
    );
    const accountRows = await tx
      .select({ accountPendingCount: count() })
      .from(cloud_agent_pending_uploads)
      .where(accountCountFilter);
    const accountPendingCount = accountRows[0]?.accountPendingCount ?? 0;

    if (accountPendingCount >= CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Maximum ${CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT} uploads allowed per account`,
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

/**
 * Flip pending ledger rows to 'linked' for a user's message in one
 * transaction. Rows whose object keys are not in the supplied set stay
 * 'pending', so a partial key set leaves unmatched uploads to be reaped.
 */
export async function linkPendingUploads(
  kiloUserId: string,
  messageUuid: string,
  objectKeys: string[]
): Promise<void> {
  if (objectKeys.length === 0) return;

  await db.transaction(async tx => {
    await tx
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
  });
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
 * Claiming first is what keeps a concurrent linkPendingUploads from losing a
 * sent attachment: after the claim the row is no longer 'pending', so the link
 * matches nothing and the object it needs is never deleted. Returns the number
 * of rows claimed and the number of objects actually deleted.
 */
async function claimAndDeleteUploadObjects(
  claim: SQL | undefined
): Promise<{ claimed: number; deleted: number }> {
  const claimed = await db
    .update(cloud_agent_pending_uploads)
    .set({ status: 'reaped' })
    .where(claim)
    .returning({ object_key: cloud_agent_pending_uploads.object_key });

  if (claimed.length === 0) return { claimed: 0, deleted: 0 };

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

  return { claimed: claimed.length, deleted: deletedKeys.length };
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
 * Delete the private objects behind every live upload row this user admitted,
 * one bounded batch at a time in id order, so account deletion removes the
 * objects together with their ledger rows.
 */
export async function purgeUserPendingUploads(kiloUserId: string): Promise<void> {
  let cursor = '';

  for (;;) {
    const batch = await db
      .select({ id: cloud_agent_pending_uploads.id })
      .from(cloud_agent_pending_uploads)
      .where(
        and(
          eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
          inArray(cloud_agent_pending_uploads.status, ['pending', 'linked']),
          gt(cloud_agent_pending_uploads.id, cursor)
        )
      )
      .orderBy(asc(cloud_agent_pending_uploads.id))
      .limit(CLOUD_AGENT_PENDING_UPLOAD_PURGE_BATCH);

    if (batch.length === 0) break;

    cursor = batch[batch.length - 1].id;

    await claimAndDeleteUploadObjects(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        inArray(cloud_agent_pending_uploads.status, ['pending', 'linked']),
        inArray(
          cloud_agent_pending_uploads.id,
          batch.map(row => row.id)
        )
      )
    );
  }

  // One more pass over the whole account: a delete that failed above put its
  // row back to 'pending', and the cursor has moved past it, so this retries
  // every such row once before account deletion drops the ledger rows.
  const restoredBatch = await db
    .select({ id: cloud_agent_pending_uploads.id })
    .from(cloud_agent_pending_uploads)
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        inArray(cloud_agent_pending_uploads.status, ['pending', 'linked'])
      )
    )
    .limit(CLOUD_AGENT_PENDING_UPLOAD_PURGE_BATCH);

  if (restoredBatch.length > 0) {
    await claimAndDeleteUploadObjects(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        inArray(
          cloud_agent_pending_uploads.id,
          restoredBatch.map(row => row.id)
        )
      )
    );
  }
}

/**
 * Delete the private R2 objects behind abandoned pending uploads whose
 * 24-hour lease has lapsed, one bounded batch per run. The batch is picked in
 * the same statement that claims it, and the claim still requires 'pending',
 * so a row linked since the pick is skipped rather than stripped of its object.
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

  const { deleted } = await claimAndDeleteUploadObjects(
    and(
      eq(cloud_agent_pending_uploads.status, 'pending'),
      inArray(cloud_agent_pending_uploads.id, expiredBatch)
    )
  );

  return { reaped: deleted };
}
