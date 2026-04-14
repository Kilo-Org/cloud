import { describe, expect, it } from 'vitest';
import {
  assertR2AttachmentDownloadConfigured,
  buildImageFileParts,
  buildImagePromptParts,
} from './image-prompt-parts.js';
import { ExecutionError } from './errors.js';
import type { Images } from '../router/schemas.js';
import type { Env } from '../types.js';

const createEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: 'access-key-id',
    R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'secret-access-key',
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_ATTACHMENTS_BUCKET: 'attachments',
    ...overrides,
  }) as Env;

const images = {
  path: '00000000-0000-4000-8000-000000000000',
  files: ['11111111-1111-4111-8111-111111111111.png', '22222222-2222-4222-8222-222222222222.jpeg'],
} satisfies Images;

describe('buildImageFileParts', () => {
  it('maps downloaded image paths to file prompt parts using original filenames', () => {
    expect(buildImageFileParts(images, ['/tmp/first.png', '/tmp/second.jpeg'])).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        url: 'file:///tmp/first.png',
        filename: '11111111-1111-4111-8111-111111111111.png',
      },
      {
        type: 'file',
        mime: 'image/jpeg',
        url: 'file:///tmp/second.jpeg',
        filename: '22222222-2222-4222-8222-222222222222.jpeg',
      },
    ]);
  });
});

describe('buildImagePromptParts', () => {
  it('prepends the text prompt before image file parts', () => {
    const fileParts = buildImageFileParts(images, ['/tmp/first.png']);

    expect(buildImagePromptParts('Describe this image', fileParts)).toEqual([
      { type: 'text', text: 'Describe this image' },
      {
        type: 'file',
        mime: 'image/png',
        url: 'file:///tmp/first.png',
        filename: '11111111-1111-4111-8111-111111111111.png',
      },
    ]);
  });
});

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
      if (!(error instanceof ExecutionError)) throw error;
      expect(error.code).toBe('WORKSPACE_SETUP_FAILED');
      expect(error.retryable).toBe(true);
      expect(error.message).toBe(
        'Image attachments were requested, but R2 attachment download is not configured'
      );
    }
  });

  it('does not throw when all R2 download config is present', () => {
    expect(() => assertR2AttachmentDownloadConfigured(createEnv())).not.toThrow();
  });
});
