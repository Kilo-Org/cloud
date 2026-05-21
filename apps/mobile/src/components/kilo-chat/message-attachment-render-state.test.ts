import { attachmentMetadataSchema } from '@kilocode/kilo-chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAttachmentCacheFilename,
  getAttachmentImageRenderState,
  getAttachmentOpenErrorMessage,
  getFreshAttachmentPreviewUrl,
  shareMaterializedAttachment,
} from './message-attachment-open';

const expoFileSystemMock = vi.hoisted(() => {
  const File = vi.fn();
  return {
    Directory: vi.fn(),
    File: Object.assign(File, { downloadFileAsync: vi.fn() }),
    Paths: { cache: 'file:///cache' },
  };
});

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-file-system', () => ({
  Directory: expoFileSystemMock.Directory,
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

vi.mock('react-native', () => ({
  Platform: reactNativeMock.Platform,
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

beforeEach(() => {
  reactNativeMock.Platform.OS = 'ios';
});

describe('message attachment render state', () => {
  it('maps image query state to render states', () => {
    expect(getAttachmentImageRenderState({ hasUrl: false, isError: false, isLoading: true })).toBe(
      'loading'
    );
    expect(getAttachmentImageRenderState({ hasUrl: false, isError: true, isLoading: false })).toBe(
      'error'
    );
    expect(getAttachmentImageRenderState({ hasUrl: true, isError: false, isLoading: false })).toBe(
      'ready'
    );
  });

  it('uses native open error copy', () => {
    expect(getAttachmentOpenErrorMessage()).toBe(
      "Couldn't open attachment. Check your connection and try again."
    );
  });

  it('only opens image preview when a fresh URL is available', () => {
    expect(getFreshAttachmentPreviewUrl({ url: 'https://example.com/image.png' })).toBe(
      'https://example.com/image.png'
    );
    expect(getFreshAttachmentPreviewUrl({ url: null })).toBeNull();
    expect(getFreshAttachmentPreviewUrl(undefined)).toBeNull();
  });

  it('bounds cache filenames for schema-valid long attachment filenames', () => {
    const attachmentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const filename = `${'a'.repeat(508)}.png`;

    expect(
      attachmentMetadataSchema.safeParse({
        attachmentId,
        filename,
        mimeType: 'image/png',
        size: 1,
      }).success
    ).toBe(true);

    const cacheFilename = getAttachmentCacheFilename({
      attachmentId,
      filename,
    });

    expect(new TextEncoder().encode(cacheFilename).byteLength).toBeLessThanOrEqual(255);
    expect(cacheFilename.startsWith(`${attachmentId}-`)).toBe(true);
    expect(cacheFilename.endsWith('.png')).toBe(true);
  });

  it('deletes materialized attachment files after sharing', async () => {
    const deleted: string[] = [];
    const shared: string[] = [];

    await shareMaterializedAttachment(
      {
        uri: 'file:///cache/kilo-chat-attachments/attachment.txt',
        delete: () => {
          deleted.push('file:///cache/kilo-chat-attachments/attachment.txt');
        },
      },
      async uri => {
        shared.push(uri);
        await Promise.resolve();
      }
    );

    expect(shared).toEqual(['file:///cache/kilo-chat-attachments/attachment.txt']);
    expect(deleted).toEqual(['file:///cache/kilo-chat-attachments/attachment.txt']);
  });

  it('keeps materialized attachment files after successful Android shares', async () => {
    reactNativeMock.Platform.OS = 'android';
    const deleted: string[] = [];

    await shareMaterializedAttachment(
      {
        uri: 'file:///cache/kilo-chat-attachments/attachment.txt',
        delete: () => {
          deleted.push('file:///cache/kilo-chat-attachments/attachment.txt');
        },
      },
      async () => {
        await Promise.resolve();
      }
    );

    expect(deleted).toEqual([]);
  });

  it('deletes materialized attachment files after share failures', async () => {
    const deleted: string[] = [];

    await expect(
      shareMaterializedAttachment(
        {
          uri: 'file:///cache/kilo-chat-attachments/attachment.txt',
          delete: () => {
            deleted.push('file:///cache/kilo-chat-attachments/attachment.txt');
          },
        },
        async () => {
          await Promise.resolve();
          throw new Error('share failed');
        }
      )
    ).rejects.toThrow('share failed');

    expect(deleted).toEqual(['file:///cache/kilo-chat-attachments/attachment.txt']);
  });
});
