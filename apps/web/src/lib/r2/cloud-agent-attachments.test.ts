import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  generateCloudAgentAttachmentDownloadUrl as GenerateCloudAgentAttachmentDownloadUrl,
  generateCloudAgentAttachmentUploadUrl as GenerateCloudAgentAttachmentUploadUrl,
  generateImageUploadUrl as GenerateImageUploadUrl,
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

const MESSAGE_UUID = '12345678-1234-4234-9234-123456789abc';
const ATTACHMENT_ID = '87654321-4321-4321-8321-cba987654321';

let mockGetSignedUrl: jest.Mock<
  (client: unknown, command: unknown, options: unknown) => Promise<string>
>;
let generateCloudAgentAttachmentDownloadUrl: typeof GenerateCloudAgentAttachmentDownloadUrl;
let generateCloudAgentAttachmentUploadUrl: typeof GenerateCloudAgentAttachmentUploadUrl;
let generateImageUploadUrl: typeof GenerateImageUploadUrl;

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
