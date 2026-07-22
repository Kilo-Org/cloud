import type { R2Client } from '@kilocode/worker-utils';
import { CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS, type Attachments } from '../router/schemas.js';

export type AttachmentService = 'app-builder' | 'cloud-agent';

export type PresignedAttachment = {
  filename: string;
  signedUrl: string;
  localPath: string;
};

const MESSAGE_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Relaxed post-S2 filename regex: UUID + any 1-16 character lowercase
 * alphanumeric extension. The deny-list is enforced as a second pass in
 * `validateAttachments`.
 */
const ATTACHMENT_RELAXED_FILENAME_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[a-z0-9]{1,16}$/;

const DENIED_EXTENSION_SET = new Set<string>(CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS);

export function deriveAttachmentService(createdOnPlatform?: string): AttachmentService {
  return createdOnPlatform === 'app-builder' ? 'app-builder' : 'cloud-agent';
}

function sanitizeLocalPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, '-');
}

function validateAttachments(attachments: Attachments): void {
  if (!MESSAGE_UUID_REGEX.test(attachments.path)) {
    throw new Error('Invalid attachment message UUID');
  }

  if (attachments.files.length === 0 || attachments.files.length > 5) {
    throw new Error('Invalid attachment file count');
  }

  for (const filename of attachments.files) {
    if (!ATTACHMENT_RELAXED_FILENAME_REGEX.test(filename)) {
      throw new Error('Invalid attachment filename');
    }
    const suffix = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    if (DENIED_EXTENSION_SET.has(suffix)) {
      throw new Error(`Attachment extension "${suffix}" is not allowed`);
    }
  }
}

export async function buildPresignedAttachments(
  r2Client: R2Client,
  bucketName: string,
  sessionId: string,
  userId: string,
  service: AttachmentService,
  attachments: Attachments
): Promise<PresignedAttachment[]> {
  validateAttachments(attachments);

  const messageUuid = attachments.path;
  const r2Prefix = `${userId}/${service}/${messageUuid}`;
  const tmpDir = `/tmp/attachments/${sanitizeLocalPathSegment(sessionId)}/${sanitizeLocalPathSegment(userId)}/${messageUuid}`;

  const presignedAttachments: PresignedAttachment[] = [];
  for (const filename of attachments.files) {
    presignedAttachments.push({
      filename,
      signedUrl: await r2Client.getSignedURL(bucketName, `${r2Prefix}/${filename}`),
      localPath: `${tmpDir}/${filename}`,
    });
  }
  return presignedAttachments;
}
