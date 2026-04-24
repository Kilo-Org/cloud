import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  CLOUD_AGENT_IMAGE_MAX_COUNT,
  CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES,
  CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION,
  type CloudAgentImageAllowedType,
} from '@/lib/cloud-agent/constants';
import type { Images } from '@/lib/images-schema';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
import { captureException } from '@sentry/nextjs';
import type { Attachment, Message } from 'chat';
import { randomUUID } from 'crypto';

const ALLOWED_TYPES_SET = new Set<string>(CLOUD_AGENT_IMAGE_ALLOWED_TYPES);

function isAllowedImageType(mimeType: string): mimeType is CloudAgentImageAllowedType {
  return ALLOWED_TYPES_SET.has(mimeType);
}

/**
 * Extract image attachments from a chat Message, download them via the
 * adapter's authenticated `fetchData()`, upload to R2, and return an
 * `Images` reference that can be passed to the Cloud Agent API.
 *
 * Returns `undefined` when the message has no usable image attachments.
 */
export async function extractAndUploadImages(
  message: Message,
  userId: string
): Promise<Images | undefined> {
  const imageAttachments = message.attachments.filter(
    (a): a is Attachment & { mimeType: string; fetchData: () => Promise<Buffer> } =>
      a.type === 'image' &&
      typeof a.mimeType === 'string' &&
      isAllowedImageType(a.mimeType) &&
      typeof a.fetchData === 'function'
  );

  if (imageAttachments.length === 0) return undefined;

  // Respect the Cloud Agent's per-message image limit
  const toProcess = imageAttachments.slice(0, CLOUD_AGENT_IMAGE_MAX_COUNT);

  const messageUuid = randomUUID();
  const uploadResults = await Promise.allSettled(
    toProcess.map(async attachment => {
      const imageId = randomUUID();
      const ext =
        CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION[attachment.mimeType as CloudAgentImageAllowedType];
      const filename = `${imageId}.${ext}`;
      const r2Key = `${userId}/cloud-agent/${messageUuid}/${filename}`;

      if (
        typeof attachment.size === 'number' &&
        attachment.size > CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES
      ) {
        throw new Error(
          `Image ${attachment.name ?? filename} exceeds ${CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES / (1024 * 1024)}MB limit (${(attachment.size / (1024 * 1024)).toFixed(1)}MB)`
        );
      }

      const data = await attachment.fetchData();

      if (data.byteLength > CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES) {
        throw new Error(
          `Image ${attachment.name ?? filename} exceeds ${CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES / (1024 * 1024)}MB limit (${(data.byteLength / (1024 * 1024)).toFixed(1)}MB)`
        );
      }

      await r2Client.send(
        new PutObjectCommand({
          Bucket: r2CloudAgentAttachmentsBucketName,
          Key: r2Key,
          Body: data,
          ContentType: attachment.mimeType,
          ContentLength: data.byteLength,
          Metadata: { userId, messageUuid, imageId },
        })
      );

      return filename;
    })
  );

  const filenames: string[] = [];
  for (const result of uploadResults) {
    if (result.status === 'fulfilled') {
      filenames.push(result.value);
    } else {
      console.error('[KiloBot] Failed to upload image attachment:', result.reason);
      captureException(result.reason, {
        tags: { component: 'kilo-bot', op: 'upload-slack-image' },
      });
    }
  }

  if (filenames.length === 0) return undefined;

  return { path: messageUuid, files: filenames };
}
