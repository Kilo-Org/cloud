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
  mimeType: CloudAgentAttachmentAllowedType;
};


export type AttachmentRetrievalOptions = {
  fetchAttachmentUrl?: (url: string) => Promise<Response>;
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

function toUploadableAttachment(
  attachment: Attachment,
  options: AttachmentRetrievalOptions
): UploadableAttachment | undefined {
  const readable =
    attachment.data !== undefined ||
    typeof attachment.fetchData === 'function' ||
    (options.fetchAttachmentUrl !== undefined && typeof attachment.url === 'string');
  if (!readable) return undefined;

  const mimeType = resolveAttachmentMimeType(attachment);
  if (!mimeType) return undefined;

  return { attachment, mimeType };
}


function attachmentTooLargeError(label: string, byteLength: number): Error {
  return new Error(
    `Attachment ${label} exceeds ${CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES / (1024 * 1024)}MB limit (${(byteLength / (1024 * 1024)).toFixed(1)}MB)`
  );
}


function attachmentUnreadableBodyError(label: string): Error {
  return new Error(`Attachment ${label} could not be read under the attachment size cap`);
}


async function readBoundedBody(
  stream: ReadableStream<Uint8Array>,
  label: string,
  declaredLength: number | undefined
): Promise<Buffer> {
  const maxBytes = CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES;
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await stream.cancel().catch(() => undefined);
    throw attachmentTooLargeError(label, declaredLength);
  }

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw attachmentTooLargeError(label, byteLength);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, byteLength);
}

async function readAttachmentBody(
  attachment: Attachment,
  label: string,
  options: AttachmentRetrievalOptions
): Promise<Buffer> {
  if (attachment.data !== undefined) {
    const data = attachment.data;
    const residentLength = Buffer.isBuffer(data) ? data.byteLength : data.size;
    if (residentLength > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES) {
      throw attachmentTooLargeError(label, residentLength);
    }
    const body = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
    if (body.byteLength > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES) {
      throw attachmentTooLargeError(label, body.byteLength);
    }
    return body;
  }

  if (typeof attachment.url === 'string' && options.fetchAttachmentUrl) {
    const body = await readAttachmentUrl(attachment.url, label, options.fetchAttachmentUrl);
    if (body) return body;
    throw attachmentUnreadableBodyError(label);
  }

  if (typeof attachment.fetchData === 'function') {
    if (
      typeof attachment.size !== 'number' ||
      !Number.isFinite(attachment.size) ||
      attachment.size > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES
    ) {
      throw attachmentUnreadableBodyError(label);
    }
    const data = await attachment.fetchData();
    if (data.byteLength > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES) {
      throw attachmentTooLargeError(label, data.byteLength);
    }
    return data;
  }

  throw new Error(`Attachment ${label} has no readable body`);
}


export type UploadedBotAttachments = {
  
  attachments?: CloudAgentAttachments;
  objectKeys: string[];
  declinedFilenames: string[];
};

const MAX_DECLINED_FILENAME_LENGTH = 120;
const UNNAMED_DECLINED_ATTACHMENT = 'an unnamed attachment';


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

export async function extractAndUploadAttachments(
  message: Message,
  userId: string,
  options: AttachmentRetrievalOptions = {}
): Promise<UploadedBotAttachments | undefined> {
  const uploadableAttachments = message.attachments
    .flatMap(attachment => {
      const uploadableAttachment = toUploadableAttachment(attachment, options);
      return uploadableAttachment ? [uploadableAttachment] : [];
    })
    .slice(0, CLOUD_AGENT_ATTACHMENT_MAX_COUNT);

  if (uploadableAttachments.length === 0) return undefined;

  const messageUuid = randomUUID();
  const uploaded: { filename: string; objectKey: string }[] = [];
  const declinedFilenames: string[] = [];

  for (const { attachment, mimeType } of uploadableAttachments) {
    const attachmentId = randomUUID();
    const extension = CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION[mimeType];
    const filename = `${attachmentId}.${extension}`;
    const label = attachment.name ?? filename;
    const keyPrefix = `${userId}/cloud-agent/${messageUuid}`;
    const admittedUpload = {
      kiloUserId: userId,
      messageUuid,
      attachmentId,
      objectKey: `${keyPrefix}/${filename}`,
      freshObjectKey: `${keyPrefix}/${randomUUID()}.${extension}`,
    };
    let admittedKey: string | undefined;

    try {
      if (
        typeof attachment.size === 'number' &&
        attachment.size > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES
      ) {
        throw attachmentTooLargeError(label, attachment.size);
      }

      admittedKey = await admitPendingUpload({
        ...admittedUpload,
        byteSize:
          typeof attachment.size === 'number' && Number.isFinite(attachment.size)
            ? attachment.size
            : CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
      });

      const data = await readAttachmentBody(attachment, label, options);

      admittedKey = await admitPendingUpload({ ...admittedUpload, byteSize: data.byteLength });

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
      if (admittedKey) await discardPendingUploads(userId, [admittedKey]);
      declinedFilenames.push(describeDeclinedAttachment(attachment));
      if (isLedgerRefusal(error)) {
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


async function discardPendingUploads(kiloUserId: string, objectKeys: string[]): Promise<void> {
  try {
    await releasePendingUploads(kiloUserId, objectKeys);
  } catch (error) {
    logAttachmentFailure('discard-bot-attachments', error);
  }
}


export async function discardUploadedAttachments(
  userId: string,
  uploaded: UploadedBotAttachments | undefined
): Promise<void> {
  if (!uploaded || uploaded.objectKeys.length === 0) return;
  await discardPendingUploads(userId, uploaded.objectKeys);
}


export async function linkUploadedAttachments(
  userId: string,
  attachments: CloudAgentAttachments | undefined
): Promise<string[]> {
  if (!attachments || attachments.files.length === 0) return [];
  return linkAttachmentsForDispatch(userId, attachments);
}


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
