import { createR2Client } from '@kilocode/worker-utils';
import { ExecutionError } from './errors.js';
import { logger } from '../logger.js';
import type { Attachments } from '../router/schemas.js';
import {
  buildPresignedAttachments,
  deriveAttachmentService,
} from '../utils/attachment-download.js';
import type { WrapperBootstrapAttachment } from '../shared/wrapper-bootstrap.js';
import { readCloudAgentNextSecret, type CloudAgentNextSecretsEnv } from '../secrets.js';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';

type R2AttachmentDownloadEnv = CloudAgentNextSecretsEnv & {
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID?: string;
  R2_ENDPOINT?: string;
  R2_ATTACHMENTS_BUCKET?: string;
};

/** The four values the download client needs, with the secret resolved by the reader. */
type R2AttachmentDownloadConfig = {
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID?: string;
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  R2_ATTACHMENTS_BUCKET?: string;
};

/**
 * Canonical extension → MIME table (no leading dot). The stored extension is
 * the single source of truth for the prompt MIME. Mirrors the web-side
 * `CLOUD_AGENT_ATTACHMENT_EXTENSION_TO_MIME` constant; the wrapper
 * `getPromptMime` resolves this exact table for the same filename suffix.
 */
export const PROMPT_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/plain',
  log: 'text/plain',
  json: 'text/plain',
  xml: 'text/plain',
  yaml: 'text/plain',
  yml: 'text/plain',
  toml: 'text/plain',
  ini: 'text/plain',
  html: 'text/plain',
  css: 'text/plain',
  js: 'text/plain',
  jsx: 'text/plain',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/plain',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  sh: 'text/plain',
  sql: 'text/plain',
};

export const PROMPT_MIME_FALLBACK = 'application/octet-stream';

export function assertR2AttachmentDownloadConfigured<T extends R2AttachmentDownloadConfig>(
  config: T
): asserts config is T & {
  R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: string;
  R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  R2_ATTACHMENTS_BUCKET: string;
} {
  if (
    !config.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID ||
    !config.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY ||
    !config.R2_ENDPOINT ||
    !config.R2_ATTACHMENTS_BUCKET
  ) {
    logger.warn('Attachments requested but R2 download config is incomplete', {
      hasAccessKeyId: Boolean(config.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID),
      hasSecretAccessKey: Boolean(config.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY),
      hasEndpoint: Boolean(config.R2_ENDPOINT),
      hasBucket: Boolean(config.R2_ATTACHMENTS_BUCKET),
    });
    throw ExecutionError.workspaceSetupFailed(
      'Attachments were requested, but R2 attachment download is not configured'
    );
  }
}

export async function buildSignedPromptAttachments({
  env,
  ctx,
  userId,
  sessionId,
  attachments,
  createdOnPlatform,
}: {
  env: R2AttachmentDownloadEnv;
  /** The invocation's context, for a secret read's bundle revalidation. */
  ctx?: SecretsExecutionContext;
  userId: string;
  sessionId: string;
  attachments?: Attachments;
  createdOnPlatform?: string;
}): Promise<WrapperBootstrapAttachment[]> {
  if (!attachments) return [];

  // A missing or unreadable secret keeps the existing fail-closed configuration error.
  const secretAccessKey = await readCloudAgentNextSecret(
    env,
    'R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY',
    ctx
  ).catch(() => undefined);
  const config = { ...env, R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: secretAccessKey };
  assertR2AttachmentDownloadConfigured(config);

  const r2Client = createR2Client({
    accessKeyId: config.R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID,
    secretAccessKey: config.R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY,
    endpoint: config.R2_ENDPOINT,
  });
  const presignedAttachments = await buildPresignedAttachments(
    r2Client,
    config.R2_ATTACHMENTS_BUCKET,
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
  const extension = dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';
  // No MIME-based extension inference anywhere: an unknown / missing /
  // invalid extension (including the legacy `bin` no-extension fallback) is
  // always treated as `application/octet-stream`.
  return PROMPT_MIME_BY_EXTENSION[extension] ?? PROMPT_MIME_FALLBACK;
}
