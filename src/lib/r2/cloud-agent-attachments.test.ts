import { describe, test, expect, beforeEach } from '@jest/globals';

jest.mock('./client', () => ({
  r2Client: { send: jest.fn() },
  r2CloudAgentAttachmentsBucketName: 'test-attachments-bucket',
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'PutObjectCommand' })),
  ListObjectsV2Command: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'ListObjectsV2Command' })),
  DeleteObjectsCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'DeleteObjectsCommand' })),
}));

import { deleteUserAttachments } from './cloud-agent-attachments';
import { r2Client } from './client';

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockSend = r2Client.send as jest.Mock;

describe('cloud-agent-attachments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('deleteUserAttachments', () => {
    test('deletes all objects under user prefix', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [
            { Key: 'user-123/app-builder/msg1/img1.png' },
            { Key: 'user-123/app-builder/msg2/img2.jpg' },
          ],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({});

      const count = await deleteUserAttachments('user-123');

      expect(count).toBe(2);
      expect(mockSend).toHaveBeenCalledTimes(2);

      // Verify list call
      const listCall = mockSend.mock.calls[0] as unknown[];
      const listCommand = listCall?.[0] as { input: Record<string, unknown> };
      expect(listCommand.input).toMatchObject({
        Bucket: 'test-attachments-bucket',
        Prefix: 'user-123/',
      });

      // Verify delete call
      const deleteCall = mockSend.mock.calls[1] as unknown[];
      const deleteCommand = deleteCall?.[0] as { input: Record<string, unknown> };
      expect(deleteCommand.input).toMatchObject({
        Bucket: 'test-attachments-bucket',
        Delete: {
          Objects: [
            { Key: 'user-123/app-builder/msg1/img1.png' },
            { Key: 'user-123/app-builder/msg2/img2.jpg' },
          ],
          Quiet: true,
        },
      });
    });

    test('handles pagination when listing many objects', async () => {
      // First page
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: 'user-123/app-builder/msg1/img1.png' }],
          IsTruncated: true,
          NextContinuationToken: 'token-abc',
        })
        .mockResolvedValueOnce({}) // delete first batch
        // Second page
        .mockResolvedValueOnce({
          Contents: [{ Key: 'user-123/app-builder/msg2/img2.jpg' }],
          IsTruncated: false,
        })
        .mockResolvedValueOnce({}); // delete second batch

      const count = await deleteUserAttachments('user-123');

      expect(count).toBe(2);
      expect(mockSend).toHaveBeenCalledTimes(4);

      // Verify the second list call uses the continuation token
      const secondListCall = mockSend.mock.calls[2] as unknown[];
      const secondListCommand = secondListCall?.[0] as { input: Record<string, unknown> };
      expect(secondListCommand.input).toMatchObject({
        Bucket: 'test-attachments-bucket',
        Prefix: 'user-123/',
        ContinuationToken: 'token-abc',
      });
    });

    test('returns 0 when user has no attachments', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: undefined,
        IsTruncated: false,
      });

      const count = await deleteUserAttachments('user-123');

      expect(count).toBe(0);
      // Only the list call, no delete call
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    test('returns 0 when Contents is empty array', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [],
        IsTruncated: false,
      });

      const count = await deleteUserAttachments('user-123');

      expect(count).toBe(0);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });
});
