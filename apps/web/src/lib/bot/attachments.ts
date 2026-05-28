import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
  CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION,
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  type CloudAgentAttachmentAllowedType,
  type CloudAgentAttachments,
  type CloudAgentImageAllowedType,
} from '@/lib/cloud-agent/constants';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
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
 * Upload supported Slack attachments to the canonical Cloud Agent attachment
 * location and return one ordered reference for the initial session prompt.
 */
export async function extractAndUploadAttachments(
  message: Message,
  userId: string
): Promise<CloudAgentAttachments | undefined> {
  const uploadableAttachments = message.attachments
    .flatMap(attachment => {
      const uploadableAttachment = toUploadableAttachment(attachment);
      return uploadableAttachment ? [uploadableAttachment] : [];
    })
    .slice(0, CLOUD_AGENT_ATTACHMENT_MAX_COUNT);

  if (uploadableAttachments.length === 0) return undefined;

  const messageUuid = randomUUID();
  const filenames: string[] = [];

  for (const { attachment, fetchData, mimeType } of uploadableAttachments) {
    try {
      const attachmentId = randomUUID();
      const extension = CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION[mimeType];
      const filename = `${attachmentId}.${extension}`;
      const r2Key = `${userId}/cloud-agent/${messageUuid}/${filename}`;

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

      await r2Client.send(
        new PutObjectCommand({
          Bucket: r2CloudAgentAttachmentsBucketName,
          Key: r2Key,
          Body: data,
          ContentType: mimeType,
          ContentLength: data.byteLength,
          Metadata: { userId, messageUuid, attachmentId },
        })
      );

      filenames.push(filename);
    } catch (error) {
      console.error('[KiloBot] Failed to upload attachment:', error);
      captureException(error, {
        tags: { component: 'kilo-bot', op: 'upload-bot-attachment' },
      });
    }
  }

  return filenames.length > 0 ? { path: messageUuid, files: filenames } : undefined;
}
