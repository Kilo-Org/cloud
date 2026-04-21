import { createR2Client } from '@kilocode/worker-utils';
import { ExecutionError } from './errors.js';
import { logger } from '../logger.js';
import type { Images } from '../router/schemas.js';
import type { Env, ExecutionSession } from '../types.js';
import { deriveAttachmentService, downloadImagesToSandbox } from '../utils/image-download.js';

export type TextPromptPart = {
  type: 'text';
  text: string;
};

export type ImageFilePart = {
  type: 'file';
  mime: string;
  url: string;
  filename: string;
};

export type ImagePromptPart = TextPromptPart | ImageFilePart;

export type DownloadImagePromptPartsOptions = {
  env: Env;
  session: ExecutionSession;
  userId: string;
  images?: Images;
  createdOnPlatform?: string;
};

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
};

export function assertR2AttachmentDownloadConfigured(env: Env): asserts env is Env & {
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: string;
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  R2_ATTACHMENTS_BUCKET: string;
} {
  if (
    !env.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID ||
    !env.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY ||
    !env.R2_ENDPOINT ||
    !env.R2_ATTACHMENTS_BUCKET
  ) {
    throw ExecutionError.workspaceSetupFailed(
      'Image attachments were requested, but R2 attachment download is not configured'
    );
  }
}

export async function downloadImagePromptParts({
  env,
  session,
  userId,
  images,
  createdOnPlatform,
}: DownloadImagePromptPartsOptions): Promise<ImageFilePart[]> {
  if (!images) return [];

  if (
    !env.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID ||
    !env.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY ||
    !env.R2_ENDPOINT ||
    !env.R2_ATTACHMENTS_BUCKET
  ) {
    logger.warn('Image attachments requested but R2 download config is incomplete', {
      hasAccessKeyId: Boolean(env.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID),
      hasSecretAccessKey: Boolean(env.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY),
      hasEndpoint: Boolean(env.R2_ENDPOINT),
      hasBucket: Boolean(env.R2_ATTACHMENTS_BUCKET),
    });
  }

  assertR2AttachmentDownloadConfigured(env);

  const r2Client = createR2Client({
    accessKeyId: env.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID,
    secretAccessKey: env.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
  });

  const attachmentService = deriveAttachmentService(createdOnPlatform);
  const { localPaths, errors } = await downloadImagesToSandbox(
    r2Client,
    env.R2_ATTACHMENTS_BUCKET,
    session,
    userId,
    attachmentService,
    images
  );

  if (errors.length > 0) {
    logger
      .withFields({ errorCount: errors.length, attachmentService })
      .warn('Image attachment download failed');
    throw ExecutionError.workspaceSetupFailed('Failed to download image attachments');
  }

  return buildImageFileParts(images, localPaths);
}

export function buildImageFileParts(images: Images, localPaths: string[]): ImageFilePart[] {
  return localPaths.map<ImageFilePart>((localPath, index) => {
    const filename = images.files[index] ?? localPath.split('/').pop() ?? 'image';

    return {
      type: 'file',
      mime: inferMimeType(filename),
      url: `file://${localPath}`,
      filename,
    };
  });
}

export function buildImagePromptParts(
  prompt: string,
  imageFileParts: ImageFilePart[]
): ImagePromptPart[] {
  return [{ type: 'text', text: prompt }, ...imageFileParts];
}

function inferMimeType(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return 'application/octet-stream';
  const ext = filename.slice(dotIndex).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
