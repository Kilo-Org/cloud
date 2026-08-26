import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
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
  byteSize: number;
};

/**
 * Admit a presigned upload into the pending-upload ledger. Runs in one
 * transaction: take the per-(user, message) advisory lock, count pending rows,
 * reject at the file-count bound, reject oversized uploads, then insert the
 * pending row with a 24-hour lease. The inserted row is later flipped to
 * 'linked' by linkPendingUploads when the message is actually sent, or to
 * 'reaped' once its object is deleted.
 */
export async function admitPendingUpload({
  kiloUserId,
  messageUuid,
  attachmentId,
  objectKey,
  byteSize,
}: AdmitPendingUploadParams): Promise<void> {
  await db.transaction(async tx => {
    // The composer presigns every attached file at once, so an unlocked
    // count-then-insert lets parallel admits all read the same count and
    // insert past the bound. The lock releases on commit or rollback.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`cloud-agent-pending-upload:${kiloUserId}:${messageUuid}`}))`
    );

    const pendingRows = await tx
      .select({ pendingCount: count() })
      .from(cloud_agent_pending_uploads)
      .where(
        and(
          eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
          eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
          eq(cloud_agent_pending_uploads.status, 'pending')
        )
      );
    const pendingCount = pendingRows[0]?.pendingCount ?? 0;

    if (pendingCount >= CLOUD_AGENT_ATTACHMENT_MAX_COUNT) {
      throw new Error(
        `Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} attachments allowed per message`
      );
    }

    if (byteSize > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES) {
      throw new Error('Attachment exceeds the maximum size');
    }

    await tx.insert(cloud_agent_pending_uploads).values({
      id: randomUUID(),
      kilo_user_id: kiloUserId,
      object_key: objectKey,
      message_uuid: messageUuid,
      attachment_id: attachmentId,
      byte_size: byteSize,
      status: 'pending',
      expires_at: new Date(Date.now() + CLOUD_AGENT_PENDING_UPLOAD_TTL_MS).toISOString(),
    });
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
 * of objects actually deleted.
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

  return {
    reaped: await claimAndDeleteUploadObjects(
      and(
        eq(cloud_agent_pending_uploads.status, 'pending'),
        inArray(cloud_agent_pending_uploads.id, expiredBatch)
      )
    ),
  };
}
