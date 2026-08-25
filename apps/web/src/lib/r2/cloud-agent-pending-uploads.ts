import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
} from '@/lib/cloud-agent/constants';
import { cloud_agent_pending_uploads } from '@kilocode/db/schema';

const CLOUD_AGENT_PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type AdmitPendingUploadParams = {
  kiloUserId: string;
  messageUuid: string;
  attachmentId: string;
  objectKey: string;
  byteSize: number;
};

/**
 * Admit a presigned upload into the pending-upload ledger. Runs in one
 * transaction: count pending rows for this user + message, reject at the
 * file-count bound, reject oversized uploads, then insert the pending row
 * with a 24-hour lease. The inserted row is later flipped to 'linked' by
 * linkPendingUploads when the message is actually sent, or to 'reaped' by
 * reapAbandonedUploads once the lease lapses.
 */
export async function admitPendingUpload({
  kiloUserId,
  messageUuid,
  attachmentId,
  objectKey,
  byteSize,
}: AdmitPendingUploadParams): Promise<void> {
  await db.transaction(async tx => {
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
 * Delete the private R2 objects behind abandoned pending uploads whose
 * 24-hour lease has lapsed, then record those rows as 'reaped'. Single-key
 * deletes are enough here because the ledger already knows each object key;
 * a delete of an already-absent key is a no-op, so re-runs are safe.
 */
export async function reapAbandonedUploads(): Promise<ReapAbandonedUploadsSummary> {
  const expired = await db
    .select()
    .from(cloud_agent_pending_uploads)
    .where(
      and(
        eq(cloud_agent_pending_uploads.status, 'pending'),
        sql`${cloud_agent_pending_uploads.expires_at} < now()`
      )
    );

  for (const row of expired) {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: r2CloudAgentAttachmentsBucketName,
        Key: row.object_key,
      })
    );
  }

  const expiredIds = expired.map(row => row.id);
  if (expiredIds.length > 0) {
    await db
      .update(cloud_agent_pending_uploads)
      .set({ status: 'reaped' })
      .where(inArray(cloud_agent_pending_uploads.id, expiredIds));
  }

  return { reaped: expiredIds.length };
}