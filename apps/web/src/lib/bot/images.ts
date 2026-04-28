import {
  CLOUD_AGENT_IMAGE_ALLOWED_TYPES,
  CLOUD_AGENT_IMAGE_MAX_COUNT,
  type CloudAgentImageAllowedType,
} from '@/lib/cloud-agent/constants';
import type { Images } from '@/lib/images-schema';
import { assertImageAttachmentSize, uploadImageAttachment } from '@/lib/r2/cloud-agent-attachments';
import { captureException } from '@sentry/nextjs';
import type { Attachment, Message } from 'chat';
import { randomUUID } from 'crypto';

const ALLOWED_TYPES_SET = new Set<string>(CLOUD_AGENT_IMAGE_ALLOWED_TYPES);

type UploadableImageAttachment = Attachment & {
  mimeType: CloudAgentImageAllowedType;
  fetchData: () => Promise<Buffer>;
};

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
    (a): a is UploadableImageAttachment =>
      a.type === 'image' &&
      typeof a.mimeType === 'string' &&
      isAllowedImageType(a.mimeType) &&
      typeof a.fetchData === 'function'
  );

  if (imageAttachments.length === 0) return undefined;

  // Respect the Cloud Agent's per-message image limit
  const toProcess = imageAttachments.slice(0, CLOUD_AGENT_IMAGE_MAX_COUNT);

  const messageUuid = randomUUID();
  const filenames: string[] = [];

  for (const attachment of toProcess) {
    try {
      const imageId = randomUUID();

      if (typeof attachment.size === 'number') {
        assertImageAttachmentSize({
          service: 'cloud-agent',
          contentLength: attachment.size,
          name: attachment.name ?? imageId,
        });
      }

      const data = await attachment.fetchData();

      const { filename } = await uploadImageAttachment({
        service: 'cloud-agent',
        userId,
        messageUuid,
        imageId,
        contentType: attachment.mimeType,
        body: data,
        name: attachment.name,
      });

      filenames.push(filename);
    } catch (error) {
      console.error('[KiloBot] Failed to upload image attachment:', error);
      captureException(error, {
        tags: { component: 'kilo-bot', op: 'upload-slack-image' },
      });
    }
  }

  if (filenames.length === 0) return undefined;

  return { path: messageUuid, files: filenames };
}
