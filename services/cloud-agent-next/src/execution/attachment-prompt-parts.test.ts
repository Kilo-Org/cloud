import { describe, expect, it, vi } from 'vitest';
import {
  assertR2AttachmentDownloadConfigured,
  buildSignedPromptAttachments,
} from './attachment-prompt-parts.js';
import { ExecutionError } from './errors.js';
import type { Attachments } from '../router/schemas.js';
import type { Env } from '../types.js';

const r2Mocks = vi.hoisted(() => ({
  getSignedURL: vi.fn(async (_bucket: string, key: string) => `https://r2.example.com/${key}`),
}));

vi.mock('@kilocode/worker-utils', () => ({
  createR2Client: vi.fn(() => ({ getSignedURL: r2Mocks.getSignedURL })),
}));

const createEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: 'access-key-id',
    R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'secret-access-key',
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_ATTACHMENTS_BUCKET: 'attachments',
    ...overrides,
  }) as Env;

describe('buildSignedPromptAttachments', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['pdf', 'application/pdf'],
    ['txt', 'text/plain'],
    ['md', 'text/plain'],
    ['csv', 'text/plain'],
  ])('maps .%s wrapper attachments to %s for Kilo', async (suffix, mime) => {
    const attachments = {
      path: '00000000-0000-4000-8000-000000000000',
      files: [`11111111-1111-4111-8111-111111111111.${suffix}`],
    } satisfies Attachments;

    const result = await buildSignedPromptAttachments({
      env: createEnv(),
      userId: 'user_test',
      sessionId: 'agent_test',
      attachments,
    });

    expect(result[0]).toEqual(expect.objectContaining({ filename: attachments.files[0], mime }));
  });
});

describe('assertR2AttachmentDownloadConfigured', () => {
  it('throws a retryable user-visible attachment error when R2 download config is incomplete', () => {
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
      if (!(error instanceof ExecutionError)) throw error;
      expect(error.code).toBe('WORKSPACE_SETUP_FAILED');
      expect(error.retryable).toBe(true);
      expect(error.message).toBe(
        'Attachments were requested, but R2 attachment download is not configured'
      );
    }
  });

  it('does not throw when all R2 download config is present', () => {
    expect(() => assertR2AttachmentDownloadConfigured(createEnv())).not.toThrow();
  });
});
