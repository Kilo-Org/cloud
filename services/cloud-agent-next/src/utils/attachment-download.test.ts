import { describe, expect, it, vi } from 'vitest';
import { buildPresignedAttachments, deriveAttachmentService } from './attachment-download.js';
import type { R2Client } from '@kilocode/worker-utils';

type TestR2Client = R2Client & {
  getSignedURL: ReturnType<typeof vi.fn<(bucket: string, key: string) => Promise<string>>>;
};

function createR2Client(): TestR2Client {
  const getSignedURL = vi.fn(
    async (_bucket: string, key: string) => `https://r2.example.com/${key}?token=signed`
  );
  return { getSignedURL } satisfies TestR2Client;
}

describe('deriveAttachmentService', () => {
  it('uses app-builder only for app-builder sessions', () => {
    expect(deriveAttachmentService('app-builder')).toBe('app-builder');
    expect(deriveAttachmentService('cloud-agent-web')).toBe('cloud-agent');
    expect(deriveAttachmentService(undefined)).toBe('cloud-agent');
  });
});

describe('buildPresignedAttachments', () => {
  it('signs image and document attachments using the derived R2 key structure', async () => {
    const r2Client = createR2Client();
    const messageUuid = '123e4567-e89b-12d3-a456-426614174000';
    const files = [
      '123e4567-e89b-12d3-a456-426614174001.jpg',
      '123e4567-e89b-12d3-a456-426614174002.pdf',
      '123e4567-e89b-12d3-a456-426614174003.txt',
      '123e4567-e89b-12d3-a456-426614174004.md',
      '123e4567-e89b-12d3-a456-426614174005.csv',
    ];

    const result = await buildPresignedAttachments(
      r2Client,
      'attachments',
      'session/id',
      'user-123',
      'cloud-agent',
      { path: messageUuid, files }
    );

    expect(r2Client.getSignedURL).toHaveBeenCalledTimes(5);
    expect(r2Client.getSignedURL).toHaveBeenCalledWith(
      'attachments',
      `user-123/cloud-agent/${messageUuid}/${files[1]}`
    );
    expect(result[4]).toEqual({
      filename: files[4],
      signedUrl: `https://r2.example.com/user-123/cloud-agent/${messageUuid}/${files[4]}?token=signed`,
      localPath: `/tmp/attachments/session-id/user-123/${messageUuid}/${files[4]}`,
    });
  });

  it('rejects client-provided path prefixes', async () => {
    await expect(
      buildPresignedAttachments(
        createR2Client(),
        'attachments',
        'session',
        'user-123',
        'cloud-agent',
        {
          path: 'app-builder/123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
        }
      )
    ).rejects.toThrow('Invalid attachment message UUID');
  });

  it('rejects filenames with non-alphanumeric extensions outside the relaxed shape', async () => {
    await expect(
      buildPresignedAttachments(
        createR2Client(),
        'attachments',
        'session',
        'user-123',
        'cloud-agent',
        {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.docx.tar'],
        }
      )
    ).rejects.toThrow('Invalid attachment filename');
  });

  it('accepts any non-denied 1-16 char alphanumeric extension and signs the matching R2 key', async () => {
    const r2Client = createR2Client();
    const messageUuid = '123e4567-e89b-12d3-a456-426614174000';
    const files = [
      '123e4567-e89b-12d3-a456-426614174001.docx',
      '123e4567-e89b-12d3-a456-426614174002.kilo',
      '123e4567-e89b-12d3-a456-426614174003.py',
    ];

    const result = await buildPresignedAttachments(
      r2Client,
      'attachments',
      'session',
      'user-123',
      'cloud-agent',
      { path: messageUuid, files }
    );

    expect(r2Client.getSignedURL).toHaveBeenCalledWith(
      'attachments',
      `user-123/cloud-agent/${messageUuid}/${files[0]}`
    );
    expect(result.map(entry => entry.filename)).toEqual(files);
  });

  it('rejects filenames whose extension is in the deny-list at download time', async () => {
    for (const extension of ['exe', 'dll', 'msi', 'com', 'scr', 'apk', 'ipa', 'dmg', 'pkg']) {
      // The Attachments type is already constrained by AttachmentsSchema at
      // the boundary, so we cast through `unknown` to reach the runtime
      // validator inside `buildPresignedAttachments`.
      const malformed = {
        path: '123e4567-e89b-12d3-a456-426614174000',
        files: [`123e4567-e89b-12d3-a456-426614174001.${extension}`],
      } as unknown as Parameters<typeof buildPresignedAttachments>[5];
      await expect(
        buildPresignedAttachments(
          createR2Client(),
          'attachments',
          'session',
          'user-123',
          'cloud-agent',
          malformed
        )
      ).rejects.toThrow(`Attachment extension "${extension}" is not allowed`);
    }
  });
});
