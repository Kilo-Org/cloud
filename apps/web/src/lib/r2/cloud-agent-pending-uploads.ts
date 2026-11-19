import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import { and, asc, count, eq, gt, inArray, like, ne, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@kilocode/web-shared/lib/r2/client';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
  CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS,
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
  export async function admitPendingUpload({
  kiloUserId,
  messageUuid,
  attachmentId,
  objectKey,
  freshObjectKey,
  byteSize,
}: AdmitPendingUploadParams): Promise<string> {
  return db.transaction(async tx => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`cloud-agent-pending-upload-user:${kiloUserId}`}))`
    );

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
  
  linkedObjectKeys: string[];
  
  unlinkedObjectKeys: string[];
};


export type DispatchAttachments = { path: string; files: string[] };


export function attachmentObjectKeys(
  kiloUserId: string,
  attachments: DispatchAttachments
): string[] {
  return attachments.files.map(file => `${kiloUserId}/cloud-agent/${attachments.path}/${file}`);
}


async function linkPendingUploadsInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  kiloUserId: string,
  messageUuid: string,
  objectKeys: string[]
): Promise<LinkPendingUploadsResult> {
  if (objectKeys.length === 0) return { linkedObjectKeys: [], unlinkedObjectKeys: [] };

  const linked = await tx
    .update(cloud_agent_pending_uploads)
    .set({ status: 'linked' })
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
        eq(cloud_agent_pending_uploads.status, 'pending'),
        inArray(cloud_agent_pending_uploads.object_key, objectKeys)
      )
    )
    .returning({ object_key: cloud_agent_pending_uploads.object_key });

  const rows = await tx
    .select({ object_key: cloud_agent_pending_uploads.object_key })
    .from(cloud_agent_pending_uploads)
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
        ne(cloud_agent_pending_uploads.status, 'linked'),
        inArray(cloud_agent_pending_uploads.object_key, objectKeys)
      )
    );

  return {
    linkedObjectKeys: linked.map(row => row.object_key),
    unlinkedObjectKeys: rows.map(row => row.object_key),
  };
}


export async function linkPendingUploads(
  kiloUserId: string,
  messageUuid: string,
  objectKeys: string[]
): Promise<LinkPendingUploadsResult> {
  if (objectKeys.length === 0) return { linkedObjectKeys: [], unlinkedObjectKeys: [] };

  return db.transaction(tx =>
    linkPendingUploadsInTransaction(tx, kiloUserId, messageUuid, objectKeys)
  );
}


export const CLOUD_AGENT_ATTACHMENT_EXPIRED_MESSAGE =
  'Attachment upload expired. Add the file again to send it.';


export async function linkAttachmentsForDispatch(
  kiloUserId: string,
  attachments: DispatchAttachments | undefined
): Promise<string[]> {
  if (!attachments || attachments.files.length === 0) return [];

  return db.transaction(async tx => {
    const { linkedObjectKeys, unlinkedObjectKeys } = await linkPendingUploadsInTransaction(
      tx,
      kiloUserId,
      attachments.path,
      attachmentObjectKeys(kiloUserId, attachments)
    );
    if (unlinkedObjectKeys.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: CLOUD_AGENT_ATTACHMENT_EXPIRED_MESSAGE,
      });
    }
    return linkedObjectKeys;
  });
}


export async function releaseUnadmittedUploads(
  kiloUserId: string,
  messageUuid: string,
  linkedObjectKeys: string[]
): Promise<number> {
  if (linkedObjectKeys.length === 0) return 0;

  const released = await db
    .update(cloud_agent_pending_uploads)
    .set({ status: 'pending' })
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        eq(cloud_agent_pending_uploads.message_uuid, messageUuid),
        eq(cloud_agent_pending_uploads.status, 'linked'),
        inArray(cloud_agent_pending_uploads.object_key, linkedObjectKeys)
      )
    )
    .returning({ id: cloud_agent_pending_uploads.id });

  return released.length;
}

export type ReapAbandonedUploadsSummary = {
  reaped: number;
};


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

export async function releasePendingUploads(
  kiloUserId: string,
  objectKeys: string[]
): Promise<void> {
  if (objectKeys.length === 0) return;

  const claimed = await db
    .update(cloud_agent_pending_uploads)
    .set({
      status: 'released',
      expires_at: new Date(
        Date.now() + CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS * 1000
      ).toISOString(),
    })
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        eq(cloud_agent_pending_uploads.status, 'pending'),
        inArray(cloud_agent_pending_uploads.object_key, objectKeys)
      )
    )
    .returning({ object_key: cloud_agent_pending_uploads.object_key });

  if (claimed.length === 0) return;

  const { failedKeys } = await deletePendingUploadObjects(claimed.map(row => row.object_key));
  if (failedKeys.length > 0) {
    console.error(
      '[cloud-agent] Failed to delete released upload objects; the reaper will retry',
      failedKeys
    );
  }
}


export async function purgeUserPendingUploads(kiloUserId: string): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    let cursor = '';

    for (;;) {
      const batch = await db
        .select({ id: cloud_agent_pending_uploads.id })
        .from(cloud_agent_pending_uploads)
        .where(
          and(
            eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
            inArray(cloud_agent_pending_uploads.status, ['pending', 'linked', 'released']),
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
          inArray(cloud_agent_pending_uploads.status, ['pending', 'linked', 'released']),
          inArray(
            cloud_agent_pending_uploads.id,
            batch.map(row => row.id)
          )
        )
      );
    }
  }

  const remaining = await db
    .select({ id: cloud_agent_pending_uploads.id })
    .from(cloud_agent_pending_uploads)
    .where(
      and(
        eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
        inArray(cloud_agent_pending_uploads.status, ['pending', 'linked', 'released'])
      )
    )
    .limit(1);

  if (remaining.length > 0) {
    throw new Error('Cloud Agent attachment cleanup incomplete');
  }
}


export async function reapAbandonedUploads(): Promise<ReapAbandonedUploadsSummary> {
  const expiredBatch = db
    .select({ id: cloud_agent_pending_uploads.id })
    .from(cloud_agent_pending_uploads)
    .where(
      and(
        inArray(cloud_agent_pending_uploads.status, ['pending', 'released']),
        sql`${cloud_agent_pending_uploads.expires_at} < now()`
      )
    )
    .limit(CLOUD_AGENT_PENDING_UPLOAD_PURGE_BATCH);

  const { deleted } = await claimAndDeleteUploadObjects(
    and(
      inArray(cloud_agent_pending_uploads.status, ['pending', 'released']),
      sql`${cloud_agent_pending_uploads.expires_at} < now()`,
      inArray(cloud_agent_pending_uploads.id, expiredBatch)
    )
  );

  return { reaped: deleted };
}
