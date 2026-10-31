import { PutObjectCommand } from '@aws-sdk/client-s3';
import { TRPCError } from '@trpc/server';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
  CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION,
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  type CloudAgentAttachmentAllowedType,
  type CloudAgentAttachments,
  type CloudAgentImageAllowedType,
} from '@/lib/cloud-agent/constants';
import {
  admitPendingUpload,
  linkAttachmentsForDispatch,
  releasePendingUploads,
  releaseUnadmittedUploads,
} from '@/lib/r2/cloud-agent-pending-uploads';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@kilocode/web-shared/lib/r2/client';
import { captureException } from '@sentry/nextjs';
import type { Attachment, Message } from 'chat';
import { randomUUID } from 'crypto';

const DOCUMENT_ALLOWED_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const satisfies readonly CloudAgentAttachmentAllowedType[];

type CloudAgentDocumentAllowedType = (typeof DOCUMENT_ALLOWED_TYPES)[number];

type UploadableAttachment = {
  attachment: Attachment;
  fetchData: () => Promise<Buffer>;
  mimeType: CloudAgentAttachmentAllowedType;
};

function isAllowedImageType(mimeType: string): mimeType is CloudAgentImageAllowedType {
  return CLOUD_AGENT_IMAGE_ALLOWED_TYPES.some(allowedType => allowedType === mimeType);
}

function isAllowedDocumentType(mimeType: string): mimeType is CloudAgentDocumentAllowedType {
  return DOCUMENT_ALLOWED_TYPES.some(allowedType => allowedType === mimeType);
}

function getFileExtension(name: string | undefined): string {
  if (!name) return '';
  const extensionIndex = name.lastIndexOf('.');
  return extensionIndex < 0 ? '' : name.slice(extensionIndex).toLowerCase();
}

function resolveDocumentMimeType(
  attachment: Attachment
): CloudAgentDocumentAllowedType | undefined {
  const mimeType = attachment.mimeType;
  if (mimeType && mimeType !== 'text/plain' && isAllowedDocumentType(mimeType)) {
    return mimeType;
  }

  // Slack commonly labels text-based documents as text/plain. Keep a typed
  // R2 object/suffix here; the worker intentionally provides .md/.csv prompt
  // parts to Kilo as text/plain context.
  switch (getFileExtension(attachment.name)) {
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.csv':
      return 'text/csv';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain';
    default:
      return mimeType && isAllowedDocumentType(mimeType) ? mimeType : undefined;
  }
}

function resolveAttachmentMimeType(
  attachment: Attachment
): CloudAgentAttachmentAllowedType | undefined {
  if (attachment.type === 'image') {
    return attachment.mimeType && isAllowedImageType(attachment.mimeType)
      ? attachment.mimeType
      : undefined;
  }

  return attachment.type === 'file' ? resolveDocumentMimeType(attachment) : undefined;
}

function toUploadableAttachment(attachment: Attachment): UploadableAttachment | undefined {
  if (typeof attachment.fetchData !== 'function') return undefined;

  const mimeType = resolveAttachmentMimeType(attachment);
  if (!mimeType) return undefined;

  return { attachment, fetchData: attachment.fetchData, mimeType };
}

/**
 * The result of forwarding one chat message's attachments: the ordered
 * references for the session prompt, the ledger object keys behind them so the
 * caller can link or discard exactly this message's uploads, and the names of
 * the referenced files this message did not forward, so the run can say they
 * are missing.
 */
export type UploadedBotAttachments = {
  /** Absent when every referenced file was declined. */
  attachments?: CloudAgentAttachments;
  objectKeys: string[];
  declinedFilenames: string[];
};

const MAX_DECLINED_FILENAME_LENGTH = 120;
const UNNAMED_DECLINED_ATTACHMENT = 'an unnamed attachment';

/** A user-supplied name is prompt data, so keep it single-line and bounded. */
function describeDeclinedAttachment(attachment: Attachment): string {
  const name = (attachment.name ?? '')
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return name.slice(0, MAX_DECLINED_FILENAME_LENGTH) || UNNAMED_DECLINED_ATTACHMENT;
}

function logAttachmentFailure(op: string, error: unknown): void {
  console.error(`[KiloBot] ${op}:`, error);
  captureException(error, {
    tags: { component: 'kilo-bot', op },
  });
}

/** A per-message or per-account ledger bound is an expected refusal. */
function isLedgerRefusal(error: unknown): error is TRPCError {
  return error instanceof TRPCError && error.code === 'BAD_REQUEST';
}

/**
 * Upload supported Slack attachments to the canonical Cloud Agent attachment
 * location and return one ordered reference for the initial session prompt.
 *
 * Every file is admitted into the shared pending-upload ledger before its
 * first R2 write, so a bot message counts against the same per-account live
 * upload ceiling as the presigned composer path and the hourly reaper can
 * reclaim anything the run never hands to a session.
 */
export async function extractAndUploadAttachments(
  message: Message,
  userId: string
): Promise<UploadedBotAttachments | undefined> {
  const uploadableAttachments = message.attachments
    .flatMap(attachment => {
      const uploadableAttachment = toUploadableAttachment(attachment);
      return uploadableAttachment ? [uploadableAttachment] : [];
    })
    .slice(0, CLOUD_AGENT_ATTACHMENT_MAX_COUNT);

  if (uploadableAttachments.length === 0) return undefined;

  const messageUuid = randomUUID();
  const uploaded: { filename: string; objectKey: string }[] = [];
  const declinedFilenames: string[] = [];

  for (const { attachment, fetchData, mimeType } of uploadableAttachments) {
    const attachmentId = randomUUID();
    const extension = CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION[mimeType];
    const filename = `${attachmentId}.${extension}`;
    const keyPrefix = `${userId}/cloud-agent/${messageUuid}`;
    let admittedKey: string | undefined;

    try {
      if (
        typeof attachment.size === 'number' &&
        attachment.size > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES
      ) {
        throw new Error(
          `Attachment ${attachment.name ?? filename} exceeds ${CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES / (1024 * 1024)}MB limit (${(attachment.size / (1024 * 1024)).toFixed(1)}MB)`
        );
      }

      const data = await fetchData();

      if (data.byteLength > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES) {
        throw new Error(
          `Attachment ${attachment.name ?? filename} exceeds ${CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES / (1024 * 1024)}MB limit (${(data.byteLength / (1024 * 1024)).toFixed(1)}MB)`
        );
      }

      // Admit before the write: the ledger owns the per-account ceiling and the
      // reaper's lease, so a refused file is never stored at all.
      admittedKey = await admitPendingUpload({
        kiloUserId: userId,
        messageUuid,
        attachmentId,
        objectKey: `${keyPrefix}/${filename}`,
        freshObjectKey: `${keyPrefix}/${randomUUID()}.${extension}`,
        byteSize: data.byteLength,
      });

      await r2Client.send(
        new PutObjectCommand({
          Bucket: r2CloudAgentAttachmentsBucketName,
          Key: admittedKey,
          Body: data,
          ContentType: mimeType,
          ContentLength: data.byteLength,
          Metadata: { userId, messageUuid, attachmentId },
        })
      );

      uploaded.push({
        filename: admittedKey.slice(admittedKey.lastIndexOf('/') + 1),
        objectKey: admittedKey,
      });
    } catch (error) {
      // A row whose write failed holds ceiling budget without an object, so
      // give it back now instead of waiting for its lease to lapse.
      if (admittedKey) await discardPendingUploads(userId, [admittedKey]);
      // Whatever the cause, this file is not in the run: name it so the model
      // does not answer as if it received every file the user referenced, and
      // the other files of the message still go through.
      declinedFilenames.push(describeDeclinedAttachment(attachment));
      if (isLedgerRefusal(error)) {
        // A ledger bound is an expected answer to this message, not an
        // incident.
        console.warn('[KiloBot] Attachment not forwarded:', error.message);
      } else {
        logAttachmentFailure('upload-bot-attachment', error);
      }
    }
  }

  if (uploaded.length === 0 && declinedFilenames.length === 0) return undefined;

  return {
    ...(uploaded.length > 0
      ? { attachments: { path: messageUuid, files: uploaded.map(entry => entry.filename) } }
      : {}),
    objectKeys: uploaded.map(entry => entry.objectKey),
    declinedFilenames,
  };
}

/** Delete pending ledger rows and their objects, never throwing. */
async function discardPendingUploads(kiloUserId: string, objectKeys: string[]): Promise<void> {
  try {
    await releasePendingUploads(kiloUserId, objectKeys);
  } catch (error) {
    logAttachmentFailure('discard-bot-attachments', error);
  }
}

/**
 * Delete the objects of a bot run that never handed them to a Cloud Agent
 * session. Rows a session already linked are left alone, so an accepted
 * session keeps its attachments.
 */
export async function discardUploadedAttachments(
  userId: string,
  uploaded: UploadedBotAttachments | undefined
): Promise<void> {
  if (!uploaded || uploaded.objectKeys.length === 0) return;
  await discardPendingUploads(userId, uploaded.objectKeys);
}

/**
 * Link a message's rows before its session is prepared, so the reaper keeps
 * them. Refuses when a row is gone, because a session must not reference an
 * object that was already reclaimed.
 */
export async function linkUploadedAttachments(
  userId: string,
  attachments: CloudAgentAttachments | undefined
): Promise<string[]> {
  if (!attachments || attachments.files.length === 0) return [];
  return linkAttachmentsForDispatch(userId, attachments);
}

/**
 * Hand a refused dispatch's rows back to 'pending' and keep their objects, so a
 * retried tool call can link them again and run-level cleanup can delete them.
 */
export async function releaseRefusedAttachments(
  userId: string,
  attachments: CloudAgentAttachments | undefined,
  linkedObjectKeys: string[]
): Promise<void> {
  if (!attachments || linkedObjectKeys.length === 0) return;
  try {
    await releaseUnadmittedUploads(userId, attachments.path, linkedObjectKeys);
  } catch (error) {
    logAttachmentFailure('release-refused-bot-attachments', error);
  }
}
