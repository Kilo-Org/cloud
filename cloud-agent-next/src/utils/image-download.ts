import { basename } from 'node:path';
import type { ExecutionSession } from '../types.js';
import type { Images } from '../router/schemas.js';
import { logger } from '../logger.js';
import type { R2Client } from './r2-client.js';

export type ImageDownloadResult = {
  localPaths: string[];
  errors: string[];
};

/**
 * Download images from R2 to the sandbox's /tmp folder using presigned URLs.
 *
 * R2 path structure: {userId}/{path}/{filename}
 *
 * Uses presigned URLs so the sandbox can download files directly via curl.
 *
 * @param r2Client - R2 client for generating presigned URLs
 * @param bucketName - The R2 bucket name
 * @param session - Sandbox execution session for file operations
 * @param userId - Authenticated user ID (used in R2 path)
 * @param images - Images object with path and ordered files list
 * @returns Object with local paths and any errors
 */
export async function downloadImagesToSandbox(
  r2Client: R2Client,
  bucketName: string,
  session: ExecutionSession,
  userId: string,
  images: NonNullable<Images>
): Promise<ImageDownloadResult> {
  const localPaths: string[] = [];
  const errors: string[] = [];

  const { path, files } = images;
  const r2Prefix = `${userId}/${path}`;

  const sanitizedPath = path.replace(/[^a-zA-Z0-9-_]/g, '-');
  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '-');
  const tmpDir = `/tmp/attachments/${session.id}/${sanitizedUserId}/${sanitizedPath}`;

  // Create tmp directory
  await session.exec(`mkdir -p ${tmpDir}`);

  // Download each file using presigned URLs
  for (const filename of files) {
    const r2Key = `${r2Prefix}/${filename}`;
    // Sanitize filename to prevent path traversal
    const sanitizedFilename = basename(filename);
    const localPath = `${tmpDir}/${sanitizedFilename}`;

    try {
      // Generate presigned URL for this object
      const presignedUrl = await r2Client.getSignedURL(bucketName, r2Key);

      // Download directly in sandbox using curl
      const curlCmd = `curl -sSL --max-time 120 --retry 3 --fail "${presignedUrl}" -o "${localPath}"`;
      const result = await session.exec(curlCmd);

      if (result.exitCode !== 0) {
        throw new Error(`curl failed: ${result.stderr || 'unknown error'}`);
      }

      localPaths.push(localPath);
      logger.withFields({ r2Key, localPath }).debug('Downloaded image to sandbox');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to download ${r2Key}: ${errorMsg}`);
      logger.withFields({ r2Key, error: errorMsg }).error('Failed to download image');
    }
  }

  logger
    .withFields({
      downloadedCount: localPaths.length,
      errorCount: errors.length,
      tmpDir,
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
