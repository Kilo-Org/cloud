import { ExecutionError } from './errors.js';
import type { Env } from '../types.js';

export type ImageFilePart = {
  type: 'file';
  mime: string;
  url: string;
  filename: string;
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
