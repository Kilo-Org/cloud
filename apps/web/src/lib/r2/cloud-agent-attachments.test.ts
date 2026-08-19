import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { inspect } from 'util';
import type {
  generateCloudAgentAttachmentDownloadUrl as GenerateCloudAgentAttachmentDownloadUrl,
  generateCloudAgentAttachmentUploadUrl as GenerateCloudAgentAttachmentUploadUrl,
  generateImageUploadUrl as GenerateImageUploadUrl,
  markCloudAgentAttachmentUploadsConsumed as MarkCloudAgentAttachmentUploadsConsumed,
  markCloudAgentAttachmentUploadsConsumedByKeys as MarkCloudAgentAttachmentUploadsConsumedByKeys,
} from './cloud-agent-attachments';

jest.mock('./client', () => ({
  r2Client: {},
  r2CloudAgentAttachmentsBucketName: 'attachment-bucket',
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'PutObjectCommand' })),
  GetObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'GetObjectCommand' })),
}));

const mockInsertValues = jest.fn();

const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));

jest.mock('@/lib/drizzle', () => ({
  db: {
    insert: () => ({
      values: (values: unknown) => {
        mockInsertValues(values);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
    update: mockUpdate,
  },
}));

const MESSAGE_UUID = '12345678-1234-4234-9234-123456789abc';
const ATTACHMENT_ID = '87654321-4321-4321-8321-cba987654321';

let mockGetSignedUrl: jest.Mock<
  (client: unknown, command: unknown, options: unknown) => Promise<string>
>;
let generateCloudAgentAttachmentDownloadUrl: typeof GenerateCloudAgentAttachmentDownloadUrl;
let generateCloudAgentAttachmentUploadUrl: typeof GenerateCloudAgentAttachmentUploadUrl;
let generateImageUploadUrl: typeof GenerateImageUploadUrl;
let markCloudAgentAttachmentUploadsConsumed: typeof MarkCloudAgentAttachmentUploadsConsumed;
let markCloudAgentAttachmentUploadsConsumedByKeys: typeof MarkCloudAgentAttachmentUploadsConsumedByKeys;

describe('cloud-agent attachment upload URL signing', () => {
  beforeAll(async () => {
    const signer = await import('@aws-sdk/s3-request-presigner');
    const attachments = await import('./cloud-agent-attachments');
    mockGetSignedUrl = signer.getSignedUrl as unknown as jest.Mock<
      (client: unknown, command: unknown, options: unknown) => Promise<string>
    >;
    generateCloudAgentAttachmentDownloadUrl = attachments.generateCloudAgentAttachmentDownloadUrl;
    generateCloudAgentAttachmentUploadUrl = attachments.generateCloudAgentAttachmentUploadUrl;
    generateImageUploadUrl = attachments.generateImageUploadUrl;
    markCloudAgentAttachmentUploadsConsumed = attachments.markCloudAgentAttachmentUploadsConsumed;
    markCloudAgentAttachmentUploadsConsumedByKeys =
      attachments.markCloudAgentAttachmentUploadsConsumedByKeys;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSignedUrl.mockResolvedValue('https://example.test/signed');
  });

  it.each([
    ['md', 'text/markdown'],
    ['csv', 'text/csv'],
  ] as const)(
    'issues a server-derived .%s suffix and attachment metadata for %s (legacy no-extension path)',
    async (extension, contentType) => {
      const result = await generateCloudAgentAttachmentUploadUrl({
        userId: 'user-1',
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType,
        contentLength: 42,
      });

      const command = mockGetSignedUrl.mock.calls[0]?.[1] as {
        input: Record<string, unknown>;
        name: string;
      };
      expect(command.input).toMatchObject({
        Bucket: 'attachment-bucket',
        Key: `user-1/cloud-agent/${MESSAGE_UUID}/${ATTACHMENT_ID}.${extension}`,
        ContentType: contentType,
        ContentLength: 42,
        Metadata: {
          userId: 'user-1',
          messageUuid: MESSAGE_UUID,
          attachmentId: ATTACHMENT_ID,
        },
      });
      expect(result.key).toBe(`user-1/cloud-agent/${MESSAGE_UUID}/${ATTACHMENT_ID}.${extension}`);
    }
  );

  it('writes a ledger row on presign so the reaper can track the upload', async () => {
    await generateCloudAgentAttachmentUploadUrl({
      userId: 'user-1',
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'text/markdown',
      contentLength: 42,
    });

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith({
      user_id: 'user-1',
      r2_key: `user-1/cloud-agent/${MESSAGE_UUID}/${ATTACHMENT_ID}.md`,
    });
  });

  it('derives the R2 key suffix from a validated extension when extension is provided', async () => {
    const result = await generateCloudAgentAttachmentUploadUrl({
      userId: 'user-1',
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'application/x-kilo-binary',
      contentLength: 42,
      extension: 'kilo',
    });

    const command = mockGetSignedUrl.mock.calls[0]?.[1] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: 'attachment-bucket',
      Key: `user-1/cloud-agent/${MESSAGE_UUID}/${ATTACHMENT_ID}.kilo`,
      ContentType: 'application/x-kilo-binary',
      ContentLength: 42,
      Metadata: {
        userId: 'user-1',
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
      },
    });
    expect(result.key).toBe(`user-1/cloud-agent/${MESSAGE_UUID}/${ATTACHMENT_ID}.kilo`);
  });

  it('rejects a deny-listed extension in the upload helper before signing', async () => {
    await expect(
      generateCloudAgentAttachmentUploadUrl({
        userId: 'user-1',
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType: 'application/octet-stream',
        contentLength: 42,
        extension: 'exe',
      })
    ).rejects.toThrow('exe');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('preserves image-only App Builder key generation and metadata', async () => {
    await generateImageUploadUrl({
      service: 'app-builder',
      userId: 'user-1',
      messageUuid: MESSAGE_UUID,
      imageId: ATTACHMENT_ID,
      contentType: 'image/png',
      contentLength: 42,
    });

    const command = mockGetSignedUrl.mock.calls[0]?.[1] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Key: `user-1/app-builder/${MESSAGE_UUID}/${ATTACHMENT_ID}.png`,
      Metadata: { imageId: ATTACHMENT_ID },
    });
  });
});

describe('cloud-agent attachment download URL signing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSignedUrl.mockResolvedValue('https://example.test/signed');
  });

  it('derives the R2 key from the caller (author) and signs a GET with the validated filename', async () => {
    const result = await generateCloudAgentAttachmentDownloadUrl({
      userId: 'user-1',
      messageUuid: MESSAGE_UUID,
      filename: `${ATTACHMENT_ID}.kilo`,
    });

    const command = mockGetSignedUrl.mock.calls[0]?.[1] as {
      input: Record<string, unknown>;
      name: string;
    };
    expect(command.input).toMatchObject({
      Bucket: 'attachment-bucket',
      Key: `user-1/cloud-agent/${MESSAGE_UUID}/${ATTACHMENT_ID}.kilo`,
    });
    expect(command.name).toBe('GetObjectCommand');
    expect(result.key).toBe(`user-1/cloud-agent/${MESSAGE_UUID}/${ATTACHMENT_ID}.kilo`);
  });

  it('rejects a deny-listed extension in the filename before signing', async () => {
    await expect(
      generateCloudAgentAttachmentDownloadUrl({
        userId: 'user-1',
        messageUuid: MESSAGE_UUID,
        filename: `${ATTACHMENT_ID}.exe`,
      })
    ).rejects.toThrow();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});

describe('cloud-agent attachment consumed marking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('no-ops on an empty key list without touching the db', async () => {
    await markCloudAgentAttachmentUploadsConsumedByKeys({ userId: 'user-1', keys: [] });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('marks rows by full key scoped to the caller', async () => {
    const foreignKey = 'user-other/cloud-agent/msg-1/file.pdf';

    await markCloudAgentAttachmentUploadsConsumedByKeys({
      userId: 'user-owner',
      keys: [foreignKey],
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const whereArg = mockUpdateWhere.mock.calls[0][0];
    const serialized = inspect(whereArg, { depth: 10 });
    // The predicate must carry both the caller-scoped `user_id` equality and the
    // `r2_key` membership. The caller id appears only in the equality (the key
    // belongs to `user-other`), so a dropped `user_id` filter fails this test.
    expect(serialized).toContain('user_id');
    expect(serialized).toContain('user-owner');
    expect(serialized).toContain('r2_key');
    expect(serialized).toContain(foreignKey);
  });

  it('rebuilds full keys from the wire shape and marks them', async () => {
    await markCloudAgentAttachmentUploadsConsumed({
      userId: 'user-1',
      attachments: { path: 'msg-1', files: ['a.pdf', 'b.pdf'] },
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const whereArg = mockUpdateWhere.mock.calls[0][0];
    const serialized = inspect(whereArg, { depth: 10 });
    expect(serialized).toContain('user-1/cloud-agent/msg-1/a.pdf');
    expect(serialized).toContain('user-1/cloud-agent/msg-1/b.pdf');
  });

  it('no-ops when the wire shape is absent or has no files', async () => {
    await markCloudAgentAttachmentUploadsConsumed({ userId: 'user-1' });
    await markCloudAgentAttachmentUploadsConsumed({
      userId: 'user-1',
      attachments: { path: 'msg-1', files: [] },
    });

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
