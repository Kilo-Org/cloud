import type { R2Client } from '@kilocode/worker-utils';
import type { Attachments } from '../router/schemas.js';

export type AttachmentService = 'app-builder' | 'cloud-agent';

export type PresignedAttachment = {
  filename: string;
  signedUrl: string;
  localPath: string;
};

const MESSAGE_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ATTACHMENT_FILENAME_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpg|jpeg|webp|gif|pdf|txt|md|csv)$/;

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
    if (!ATTACHMENT_FILENAME_REGEX.test(filename)) {
      throw new Error('Invalid attachment filename');
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
