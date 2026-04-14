import type { ExecutionSession } from '../types.js';
import type { Images } from '../router/schemas.js';
import { logger } from '../logger.js';
import type { R2Client } from '@kilocode/worker-utils';

export type AttachmentService = 'app-builder' | 'cloud-agent';

export type ImageDownloadResult = {
  localPaths: string[];
  errors: string[];
};

const MESSAGE_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IMAGE_FILENAME_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(png|jpg|jpeg|webp|gif)$/;
const MAX_IMAGE_BYTES = 5_242_880;

export function deriveAttachmentService(createdOnPlatform?: string): AttachmentService {
  return createdOnPlatform === 'app-builder' ? 'app-builder' : 'cloud-agent';
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellQuoteSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, '-');
}

function validateImages(images: NonNullable<Images>): void {
  if (!MESSAGE_UUID_REGEX.test(images.path)) {
    throw new Error('Invalid image attachment message UUID');
  }

  if (images.files.length === 0 || images.files.length > 5) {
    throw new Error('Invalid image attachment file count');
  }

  for (const filename of images.files) {
    if (!IMAGE_FILENAME_REGEX.test(filename)) {
      throw new Error('Invalid image attachment filename');
    }
  }
}

/**
 * Download images from R2 to the sandbox's /tmp folder using presigned URLs.
 *
 * R2 path structure: {userId}/{derivedService}/{messageUuid}/{filename}
 *
 * Uses presigned URLs so the sandbox can download files directly via curl.
 *
 * @param r2Client - R2 client for generating presigned URLs
 * @param bucketName - The R2 bucket name
 * @param session - Sandbox execution session for file operations
 * @param userId - Authenticated user ID (used in R2 path)
 * @param service - Server-derived service prefix for R2 objects
 * @param images - Images object with message UUID path and ordered files list
 * @returns Object with local paths and any errors
 */
type ImageDownloadSession = Pick<ExecutionSession, 'id' | 'exec'>;

export async function downloadImagesToSandbox(
  r2Client: R2Client,
  bucketName: string,
  session: ImageDownloadSession,
  userId: string,
  service: AttachmentService,
  images: NonNullable<Images>
): Promise<ImageDownloadResult> {
  validateImages(images);

  const localPaths: string[] = [];
  const errors: string[] = [];

  const { path: messageUuid, files } = images;
  const r2Prefix = `${userId}/${service}/${messageUuid}`;

  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '-');
  const tmpDir = `/tmp/attachments/${shellQuoteSegment(session.id)}/${sanitizedUserId}/${messageUuid}`;

  await session.exec(`mkdir -p ${shellQuote(tmpDir)}`);

  for (const filename of files) {
    const r2Key = `${r2Prefix}/${filename}`;
    const localPath = `${tmpDir}/${filename}`;

    try {
      const presignedUrl = await r2Client.getSignedURL(bucketName, r2Key);

      const curlCmd = [
        'curl',
        '-sSL',
        '--max-time',
        '120',
        '--retry',
        '3',
        '--fail',
        '--max-filesize',
        String(MAX_IMAGE_BYTES),
        shellQuote(presignedUrl),
        '-o',
        shellQuote(localPath),
      ].join(' ');
      const result = await session.exec(curlCmd);

      if (result.exitCode !== 0) {
        throw new Error('curl failed');
      }

      localPaths.push(localPath);
      logger.withFields({ service, messageUuid, filename }).debug('Downloaded image to sandbox');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to download image ${filename}`);
      logger
        .withFields({ service, messageUuid, filename, error: errorMsg })
        .error('Failed to download image');
    }
  }

  logger
    .withFields({
      service,
      messageUuid,
      fileCount: files.length,
      downloadedCount: localPaths.length,
      errorCount: errors.length,
    })
    .info('Image download complete');

  return { localPaths, errors };
}

/**
 * Build --attach CLI arguments from local image paths.
 */
export function buildAttachArgs(localPaths: string[]): string {
  if (localPaths.length === 0) return '';
  return localPaths.map(p => `--attach=${p}`).join(' ');
}
