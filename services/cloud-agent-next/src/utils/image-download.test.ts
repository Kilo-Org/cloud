import { describe, expect, it, vi } from 'vitest';
import { deriveAttachmentService, downloadImagesToSandbox, shellQuote } from './image-download.js';
import type { ExecResult } from '@cloudflare/sandbox';
import type { R2Client } from '@kilocode/worker-utils';

type ExecMock = ReturnType<typeof vi.fn<(command: string) => Promise<ExecResult>>>;

type TestSession = { id: string; exec: ExecMock };

type TestR2Client = R2Client & {
  getSignedURL: ReturnType<typeof vi.fn<(bucket: string, key: string) => Promise<string>>>;
};

function execResult(exitCode: number, stderr = ''): ExecResult {
  return {
    exitCode,
    stdout: '',
    stderr,
    success: exitCode === 0,
    command: 'mock-command',
    duration: 1,
    timestamp: new Date().toISOString(),
  };
}

function createSession(): TestSession {
  const exec: ExecMock = vi.fn(async () => execResult(0));
  return {
    id: 'session id; rm -rf /',
    exec,
  } satisfies TestSession;
}

function createR2Client(): TestR2Client {
  const getSignedURL = vi.fn(
    async (_bucket: string, key: string) => `https://r2.example.com/${key}?token=abc' ; rm -rf / #`
  );
  return {
    getSignedURL,
  } satisfies TestR2Client;
}

describe('deriveAttachmentService', () => {
  it('uses app-builder only for app-builder sessions', () => {
    expect(deriveAttachmentService('app-builder')).toBe('app-builder');
    expect(deriveAttachmentService('cloud-agent-web')).toBe('cloud-agent');
    expect(deriveAttachmentService(undefined)).toBe('cloud-agent');
  });
});

describe('shellQuote', () => {
  it('single-quotes shell arguments and escapes embedded quotes', () => {
    expect(shellQuote("abc'def")).toBe("'abc'\"'\"'def'");
  });
});

describe('downloadImagesToSandbox', () => {
  it('builds R2 keys from server-derived service and validated image pieces', async () => {
    const session = createSession();
    const r2Client = createR2Client();
    const messageUuid = '123e4567-e89b-12d3-a456-426614174000';
    const filename = '123e4567-e89b-12d3-a456-426614174001.jpg';

    const result = await downloadImagesToSandbox(
      r2Client,
      'attachments',
      session,
      'user-123',
      'cloud-agent',
      { path: messageUuid, files: [filename] }
    );

    expect(r2Client.getSignedURL).toHaveBeenCalledWith(
      'attachments',
      `user-123/cloud-agent/${messageUuid}/${filename}`
    );
    expect(result).toEqual({
      localPaths: [`/tmp/attachments/session-id--rm--rf--/user-123/${messageUuid}/${filename}`],
      errors: [],
    });
    expect(session.exec).toHaveBeenNthCalledWith(
      1,
      `mkdir -p '/tmp/attachments/session-id--rm--rf--/user-123/${messageUuid}'`
    );
    expect(session.exec).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('--max-filesize 5242880')
    );
    expect(session.exec).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "'https://r2.example.com/user-123/cloud-agent/123e4567-e89b-12d3-a456-426614174000/123e4567-e89b-12d3-a456-426614174001.jpg?token=abc'\"'\"' ; rm -rf / #'"
      )
    );
  });

  it('rejects client-provided service prefixes in image path', async () => {
    await expect(
      downloadImagesToSandbox(
        createR2Client(),
        'attachments',
        createSession(),
        'user-123',
        'cloud-agent',
        {
          path: 'app-builder/123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.jpg'],
        }
      )
    ).rejects.toThrow('Invalid image attachment message UUID');
  });

  it('rejects hyphen-only filenames without UUID segments', async () => {
    await expect(
      downloadImagesToSandbox(
        createR2Client(),
        'attachments',
        createSession(),
        'user-123',
        'cloud-agent',
        {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['------------------------------------.jpg'],
        }
      )
    ).rejects.toThrow('Invalid image attachment filename');
  });

  it('returns sanitized download errors without R2 keys or curl stderr', async () => {
    const session = createSession();
    session.exec.mockResolvedValueOnce(execResult(0));
    session.exec.mockResolvedValueOnce(execResult(22, 'secret r2 key details'));

    const result = await downloadImagesToSandbox(
      createR2Client(),
      'attachments',
      session,
      'user-123',
      'app-builder',
      {
        path: '123e4567-e89b-12d3-a456-426614174000',
        files: ['123e4567-e89b-12d3-a456-426614174001.png'],
      }
    );

    expect(result.errors).toEqual([
      'Failed to download image 123e4567-e89b-12d3-a456-426614174001.png',
    ]);
  });
});
