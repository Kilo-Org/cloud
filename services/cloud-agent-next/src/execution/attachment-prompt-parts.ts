import { createR2Client } from '@kilocode/worker-utils';
import { ExecutionError } from './errors.js';
import { logger } from '../logger.js';
import type { Attachments } from '../router/schemas.js';
import {
  buildPresignedAttachments,
  deriveAttachmentService,
} from '../utils/attachment-download.js';
import type { WrapperBootstrapAttachment } from '../shared/wrapper-bootstrap.js';

type R2AttachmentDownloadEnv = {
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID?: string;
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  R2_ATTACHMENTS_BUCKET?: string;
};

const PROMPT_MIME_BY_SUFFIX: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/plain',
};

export function assertR2AttachmentDownloadConfigured<T extends R2AttachmentDownloadEnv>(
  env: T
): asserts env is T & {
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
    logger.warn('Attachments requested but R2 download config is incomplete', {
      hasAccessKeyId: Boolean(env.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID),
      hasSecretAccessKey: Boolean(env.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY),
      hasEndpoint: Boolean(env.R2_ENDPOINT),
      hasBucket: Boolean(env.R2_ATTACHMENTS_BUCKET),
    });
    throw ExecutionError.workspaceSetupFailed(
      'Attachments were requested, but R2 attachment download is not configured'
    );
  }
}

export async function buildSignedPromptAttachments({
  env,
  userId,
  sessionId,
  attachments,
  createdOnPlatform,
}: {
  env: R2AttachmentDownloadEnv;
  userId: string;
  sessionId: string;
  attachments?: Attachments;
  createdOnPlatform?: string;
}): Promise<WrapperBootstrapAttachment[]> {
  if (!attachments) return [];

  assertR2AttachmentDownloadConfigured(env);

  const r2Client = createR2Client({
    accessKeyId: env.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID,
    secretAccessKey: env.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
  });
  const presignedAttachments = await buildPresignedAttachments(
    r2Client,
    env.R2_ATTACHMENTS_BUCKET,
    sessionId,
    userId,
    deriveAttachmentService(createdOnPlatform),
    attachments
  );

  return presignedAttachments.map(attachment => ({
    ...attachment,
    mime: getPromptMime(attachment.filename),
  }));
}

function getPromptMime(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  const suffix = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
  const mime = PROMPT_MIME_BY_SUFFIX[suffix];
  if (!mime) {
    throw new Error('Invalid attachment filename');
  }
  return mime;
}
