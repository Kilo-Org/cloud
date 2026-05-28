import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
  CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION,
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  type CloudAgentAttachmentAllowedType,
  type CloudAgentAttachments,
} from '@/lib/cloud-agent/constants';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
import { captureException } from '@sentry/nextjs';
import type { Attachment, Message } from 'chat';
import { randomUUID } from 'crypto';

const IMAGE_TYPES_SET = new Set<string>(CLOUD_AGENT_IMAGE_ALLOWED_TYPES);

/**
 * Non-image MIME types accepted by the Cloud Agent attachments API.
 * These are forwarded via the canonical `attachments` field, separate from
 * the legacy `images` field used for image attachments.
 */
const NON_IMAGE_ALLOWED_TYPES: ReadonlyArray<CloudAgentAttachmentAllowedType> = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
];
const NON_IMAGE_TYPES_SET = new Set<string>(NON_IMAGE_ALLOWED_TYPES);

type UploadableFileAttachment = Attachment & {
  fetchData: () => Promise<Buffer>;
};

/**
 * Resolve the effective MIME type for a file attachment.
 *
 * Slack may report markdown files as `text/plain` even when the filename has
 * a `.md` extension. This function upgrades the MIME type based on the file
 * extension so that the worker receives accurate content-type metadata.
 */
function resolveMimeType(attachment: Attachment): CloudAgentAttachmentAllowedType | undefined {
  const raw = attachment.mimeType;

  // If it's already a recognised non-image type and not a generic text/plain,
  // use it as-is.
  if (raw && raw !== 'text/plain' && NON_IMAGE_TYPES_SET.has(raw)) {
    return raw as CloudAgentAttachmentAllowedType;
  }

  // Attempt to refine based on file extension (covers Slack's generic text/plain
  // for .md and .csv files).
  const name = attachment.name ?? '';
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.pdf') return 'application/pdf';

  // Fall back to the original MIME if it's in our allowed set.
  if (raw && NON_IMAGE_TYPES_SET.has(raw)) return raw as CloudAgentAttachmentAllowedType;

  return undefined;
}

function isUploadableFileAttachment(a: Attachment): a is UploadableFileAttachment {
  // Only process non-image files; images are handled separately via extractAndUploadImages.
  if (IMAGE_TYPES_SET.has(a.mimeType ?? '')) return false;
  if (a.type !== 'file') return false;
  if (typeof a.fetchData !== 'function') return false;
  return resolveMimeType(a) !== undefined;
}

/**
 * Extract non-image file attachments from a chat Message, download them via
 * the adapter's authenticated `fetchData()`, upload to R2, and return a
 * `CloudAgentAttachments` reference that can be passed to the Cloud Agent API.
 *
 * Handles: PDF, plain text (.txt), Markdown (.md), and CSV (.csv) files.
 * Images are handled separately by `extractAndUploadImages`.
 *
 * Returns `undefined` when the message has no supported non-image file attachments.
 */
export async function extractAndUploadFileAttachments(
  message: Message,
  userId: string
): Promise<CloudAgentAttachments | undefined> {
  const fileAttachments = message.attachments.filter(isUploadableFileAttachment);

  if (fileAttachments.length === 0) return undefined;

  // Respect the Cloud Agent's per-message attachment limit.
  const toProcess = fileAttachments.slice(0, CLOUD_AGENT_ATTACHMENT_MAX_COUNT);

  const messageUuid = randomUUID();
  const filenames: string[] = [];

  for (const attachment of toProcess) {
    try {
      const mimeType = resolveMimeType(attachment);
      if (!mimeType) continue;

      const fileId = randomUUID();
      const ext = CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION[mimeType];
      const filename = `${fileId}.${ext}`;
      const r2Key = `${userId}/cloud-agent/${messageUuid}/${filename}`;

      if (
        typeof attachment.size === 'number' &&
        attachment.size > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES
      ) {
        throw new Error(
          `File ${attachment.name ?? filename} exceeds ${CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES / (1024 * 1024)}MB limit (${(attachment.size / (1024 * 1024)).toFixed(1)}MB)`
        );
      }

      const data = await attachment.fetchData();

      if (data.byteLength > CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES) {
        throw new Error(
          `File ${attachment.name ?? filename} exceeds ${CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES / (1024 * 1024)}MB limit (${(data.byteLength / (1024 * 1024)).toFixed(1)}MB)`
        );
      }

      await r2Client.send(
        new PutObjectCommand({
          Bucket: r2CloudAgentAttachmentsBucketName,
          Key: r2Key,
          Body: data,
          ContentType: mimeType,
          ContentLength: data.byteLength,
          Metadata: { userId, messageUuid, fileId },
        })
      );

      filenames.push(filename);
    } catch (error) {
      console.error('[KiloBot] Failed to upload file attachment:', error);
      captureException(error, {
        tags: { component: 'kilo-bot', op: 'upload-bot-file-attachment' },
      });
    }
  }

  if (filenames.length === 0) return undefined;

  return { path: messageUuid, files: filenames };
}
