import { describe, expect, it } from 'vitest';
import { assertR2AttachmentDownloadConfigured } from './image-prompt-parts.js';
import { ExecutionError } from './errors.js';
import type { Env } from '../types.js';

const createEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: 'access-key-id',
    R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'secret-access-key',
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_ATTACHMENTS_BUCKET: 'attachments',
    ...overrides,
  }) as Env;

describe('assertR2AttachmentDownloadConfigured', () => {
  it('throws a retryable user-visible error when R2 download config is incomplete', () => {
    expect(() =>
      assertR2AttachmentDownloadConfigured(
        createEnv({ R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: undefined })
      )
    ).toThrow(ExecutionError);

    try {
      assertR2AttachmentDownloadConfigured(
        createEnv({ R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: undefined })
      );
      expect.fail('Expected missing R2 config to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionError);
      expect((error as ExecutionError).code).toBe('WORKSPACE_SETUP_FAILED');
      expect((error as ExecutionError).retryable).toBe(true);
      expect((error as ExecutionError).message).toBe(
        'Image attachments were requested, but R2 attachment download is not configured'
      );
    }
  });

  it('does not throw when all R2 download config is present', () => {
    expect(() => assertR2AttachmentDownloadConfigured(createEnv())).not.toThrow();
  });
});
