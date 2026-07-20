import { describe, expect, it, vi } from 'vitest';
import {
  PROMPT_MIME_BY_EXTENSION,
  PROMPT_MIME_FALLBACK,
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

/**
 * Exact canonical extension → MIME table mirroring the worker
 * `PROMPT_MIME_BY_EXTENSION`. Every entry must be covered by the test
 * `buildSignedPromptAttachments` mapping below.
 */
const CANONICAL_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain'],
  ['md', 'text/plain'],
  ['csv', 'text/plain'],
  ['log', 'text/plain'],
  ['json', 'text/plain'],
  ['xml', 'text/plain'],
  ['yaml', 'text/plain'],
  ['yml', 'text/plain'],
  ['toml', 'text/plain'],
  ['ini', 'text/plain'],
  ['html', 'text/plain'],
  ['css', 'text/plain'],
  ['js', 'text/plain'],
  ['jsx', 'text/plain'],
  ['ts', 'text/plain'],
  ['tsx', 'text/plain'],
  ['py', 'text/plain'],
  ['rb', 'text/plain'],
  ['go', 'text/plain'],
  ['rs', 'text/plain'],
  ['java', 'text/plain'],
  ['c', 'text/plain'],
  ['h', 'text/plain'],
  ['cpp', 'text/plain'],
  ['hpp', 'text/plain'],
  ['sh', 'text/plain'],
  ['sql', 'text/plain'],
];

describe('PROMPT_MIME_BY_EXTENSION canonical table', () => {
  it('maps every documented extension to its declared MIME exactly once', () => {
    for (const [extension, mime] of CANONICAL_TABLE) {
      expect(PROMPT_MIME_BY_EXTENSION[extension]).toBe(mime);
    }
  });

  it('resolves unknown / extensionless filenames to the octet-stream fallback', () => {
    expect(PROMPT_MIME_BY_EXTENSION['zip']).toBeUndefined();
    expect(PROMPT_MIME_BY_EXTENSION['bin']).toBeUndefined();
    expect(PROMPT_MIME_BY_EXTENSION['']).toBeUndefined();
    expect(PROMPT_MIME_FALLBACK).toBe('application/octet-stream');
  });
});

describe('buildSignedPromptAttachments', () => {
  it.each(CANONICAL_TABLE)('maps .%s wrapper attachments to %s for Kilo', async (suffix, mime) => {
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

  it('resolves an extension not in the canonical table to application/octet-stream', async () => {
    const attachments = {
      path: '00000000-0000-4000-8000-000000000000',
      files: ['22222222-2222-4222-8222-222222222222.zip'],
    } satisfies Attachments;

    const result = await buildSignedPromptAttachments({
      env: createEnv(),
      userId: 'user_test',
      sessionId: 'agent_test',
      attachments,
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        filename: attachments.files[0],
        mime: 'application/octet-stream',
      })
    );
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
