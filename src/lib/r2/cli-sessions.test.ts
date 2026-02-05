import { describe, test, expect, beforeEach } from '@jest/globals';
import { Readable } from 'node:stream';

jest.mock('./client', () => ({
  r2Client: { send: jest.fn() },
  getR2CliSessionsBucketName: () => 'test-bucket',
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
  DeleteObjectsCommand: jest.fn().mockImplementation((input: unknown) => ({
    input,
    name: 'DeleteObjectsCommand',
  })),
  CopyObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'CopyObjectCommand' })),
  HeadObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'HeadObjectCommand' })),
}));

import {
  uploadBlob,
  generateSignedUrls,
  generateSignedUploadUrl,
  deleteBlobs,
  getBlobContent,
  copyBlobs,
} from './cli-sessions';
import { r2Client } from './client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockSend = r2Client.send as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;

describe('cli-sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('uploadBlob', () => {
    test('uploads blob with correct parameters and returns blob url mapping', async () => {
      mockSend.mockResolvedValueOnce({});

      const stream = Readable.from(['test content']);
      const result = await uploadBlob(
        'session-123',
        'user-456',
        'sessions',
        'api_conversation_history',
        stream,
        12
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sendCall = mockSend.mock.calls[0] as unknown[];
      const command = sendCall?.[0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'sessions/session-123/api_conversation_history.json',
        ContentType: 'application/json',
        ContentLength: 12,
        Metadata: {
          type: 'api_conversation_history',
          sessionId: 'session-123',
          userId: 'user-456',
        },
      });

      expect(result).toEqual({
        api_conversation_history_blob_url: 'sessions/session-123/api_conversation_history.json',
      });
    });

    test('uploads to shared-sessions folder correctly', async () => {
      mockSend.mockResolvedValueOnce({});

      const stream = Readable.from(['content']);
      const result = await uploadBlob(
        'share-789',
        'user-123',
        'shared-sessions',
        'task_metadata',
        stream,
        7
      );

      const sendCall = mockSend.mock.calls[0] as unknown[];
      const command = sendCall?.[0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Key: 'shared-sessions/share-789/task_metadata.json',
      });

      expect(result).toEqual({
        task_metadata_blob_url: 'shared-sessions/share-789/task_metadata.json',
      });
    });
  });

  describe('generateSignedUrls', () => {
    test('generates signed urls for single file', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed-url.example.com/file1');

      const result = await generateSignedUrls('session-123', 'sessions', ['ui_messages']);

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const signedUrlCall = mockGetSignedUrl.mock.calls[0] as unknown[];
      expect(signedUrlCall?.[2]).toEqual({ expiresIn: 900 });

      expect(result).toEqual({
        ui_messages_blob_url: 'https://signed-url.example.com/file1',
      });
    });

    test('generates signed urls for multiple files', async () => {
      mockGetSignedUrl
        .mockResolvedValueOnce('https://signed-url.example.com/file1')
        .mockResolvedValueOnce('https://signed-url.example.com/file2')
        .mockResolvedValueOnce('https://signed-url.example.com/file3');

      const result = await generateSignedUrls('session-123', 'sessions', [
        'api_conversation_history',
        'task_metadata',
        'git_state',
      ]);

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        api_conversation_history_blob_url: 'https://signed-url.example.com/file1',
        task_metadata_blob_url: 'https://signed-url.example.com/file2',
        git_state_blob_url: 'https://signed-url.example.com/file3',
      });
    });

    test('returns empty object for empty filenames array', async () => {
      const result = await generateSignedUrls('session-123', 'sessions', []);

      expect(mockGetSignedUrl).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });
  });

  describe('generateSignedUploadUrl', () => {
    test('returns a signedUrl property', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed-upload-url.example.com/put');

      const result = await generateSignedUploadUrl(
        'session-123',
        'user-456',
        'sessions',
        'api_conversation_history',
        1024
      );

      expect(result).toHaveProperty('signedUrl');
      expect(result.signedUrl).toBe('https://signed-upload-url.example.com/put');
    });

    test('generates correct key using sessionId, folderName, and filename', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed-upload-url.example.com/put');

      await generateSignedUploadUrl(
        'session-abc',
        'user-xyz',
        'shared-sessions',
        'task_metadata',
        2048
      );

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const signedUrlCall = mockGetSignedUrl.mock.calls[0] as unknown[];
      const command = signedUrlCall?.[1] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'shared-sessions/session-abc/task_metadata.json',
        ContentType: 'application/json',
        ContentLength: 2048,
        Metadata: {
          type: 'task_metadata',
          sessionId: 'session-abc',
          userId: 'user-xyz',
        },
      });
    });

    test('calls getSignedUrl with correct parameters including signableHeaders', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed-upload-url.example.com/put');

      await generateSignedUploadUrl('session-123', 'user-456', 'sessions', 'ui_messages', 512);

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const signedUrlCall = mockGetSignedUrl.mock.calls[0] as unknown[];
      expect(signedUrlCall?.[0]).toBe(r2Client);
      expect(signedUrlCall?.[2]).toEqual({
        expiresIn: 900,
        signableHeaders: new Set(['content-length']),
      });
    });

    test('sets ContentLength in the PutObjectCommand', async () => {
      mockGetSignedUrl.mockResolvedValueOnce('https://signed-upload-url.example.com/put');

      await generateSignedUploadUrl(
        'session-123',
        'user-456',
        'sessions',
        'api_conversation_history',
        4096
      );

      const signedUrlCall = mockGetSignedUrl.mock.calls[0] as unknown[];
      const command = signedUrlCall?.[1] as { input: Record<string, unknown> };
      expect(command.input.ContentLength).toBe(4096);
    });
  });

  describe('deleteBlobs', () => {
    test('deletes single blob', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteBlobs('session-123', [{ folderName: 'sessions', filename: 'ui_messages' }]);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sendCall = mockSend.mock.calls[0] as unknown[];
      const command = sendCall?.[0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Bucket: 'test-bucket',
        Delete: {
          Objects: [{ Key: 'sessions/session-123/ui_messages.json' }],
          Quiet: true,
        },
      });
    });

    test('deletes multiple blobs', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteBlobs('session-123', [
        { folderName: 'sessions', filename: 'api_conversation_history' },
        { folderName: 'sessions', filename: 'task_metadata' },
        { folderName: 'shared-sessions', filename: 'git_state' },
      ]);

      const sendCall = mockSend.mock.calls[0] as unknown[];
      const command = sendCall?.[0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Delete: {
          Objects: [
            { Key: 'sessions/session-123/api_conversation_history.json' },
            { Key: 'sessions/session-123/task_metadata.json' },
            { Key: 'shared-sessions/session-123/git_state.json' },
          ],
          Quiet: true,
        },
      });
    });

    test('handles empty blobs array', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteBlobs('session-123', []);

      const sendCall = mockSend.mock.calls[0] as unknown[];
      const command = sendCall?.[0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Delete: {
          Objects: [],
          Quiet: true,
        },
      });
    });
  });

  describe('getBlobContent', () => {
    test('retrieves and parses JSON blob content', async () => {
      const mockBody = {
        transformToString: jest.fn().mockResolvedValue('{"key": "value", "number": 42}'),
      };
      mockSend.mockResolvedValueOnce({ Body: mockBody });

      const result = await getBlobContent('sessions/session-123/api_conversation_history.json');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sendCall = mockSend.mock.calls[0] as unknown[];
      const command = sendCall?.[0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'sessions/session-123/api_conversation_history.json',
      });

      expect(result).toEqual({ key: 'value', number: 42 });
    });

    test('returns null when body is empty', async () => {
      mockSend.mockResolvedValueOnce({ Body: null });

      const result = await getBlobContent('sessions/session-123/api_conversation_history.json');

      expect(result).toBeNull();
    });

    test('handles array content', async () => {
      const mockBody = {
        transformToString: jest.fn().mockResolvedValue('[1, 2, 3, "test"]'),
      };
      mockSend.mockResolvedValueOnce({ Body: mockBody });

      const result = await getBlobContent('some-key');

      expect(result).toEqual([1, 2, 3, 'test']);
    });
  });

  describe('copyBlobs', () => {
    test('copies single blob successfully', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});

      const result = await copyBlobs(
        'source-session',
        'sessions',
        'dest-session',
        'shared-sessions',
        ['api_conversation_history']
      );

      expect(mockSend).toHaveBeenCalledTimes(2);

      const headCall = mockSend.mock.calls[0] as unknown[];
      const headCommand = headCall?.[0] as { input: Record<string, unknown> };
      expect(headCommand.input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'sessions/source-session/api_conversation_history.json',
      });

      const copyCall = mockSend.mock.calls[1] as unknown[];
      const copyCommand = copyCall?.[0] as { input: Record<string, unknown> };
      expect(copyCommand.input).toMatchObject({
        Bucket: 'test-bucket',
        CopySource: 'test-bucket/sessions/source-session/api_conversation_history.json',
        Key: 'shared-sessions/dest-session/api_conversation_history.json',
      });

      expect(result).toEqual({
        api_conversation_history_blob_url:
          'shared-sessions/dest-session/api_conversation_history.json',
      });
    });

    test('copies multiple blobs successfully', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await copyBlobs('source-session', 'sessions', 'dest-session', 'sessions', [
        'api_conversation_history',
        'task_metadata',
      ]);

      expect(mockSend).toHaveBeenCalledTimes(4);
      expect(result).toEqual({
        api_conversation_history_blob_url: 'sessions/dest-session/api_conversation_history.json',
        task_metadata_blob_url: 'sessions/dest-session/task_metadata.json',
      });
    });

    test('skips blobs that do not exist (HeadObject throws)', async () => {
      mockSend
        .mockRejectedValueOnce(new Error('Not Found'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const result = await copyBlobs('source-session', 'sessions', 'dest-session', 'sessions', [
        'api_conversation_history',
        'task_metadata',
      ]);

      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        task_metadata_blob_url: 'sessions/dest-session/task_metadata.json',
      });
    });

    test('filters out null values from blobsToCopy', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});

      const blobsToCopy = ['api_conversation_history', null, undefined] as unknown as (
        | 'api_conversation_history'
        | 'task_metadata'
        | 'ui_messages'
        | 'git_state'
      )[];

      const result = await copyBlobs('source', 'sessions', 'dest', 'sessions', blobsToCopy);

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        api_conversation_history_blob_url: 'sessions/dest/api_conversation_history.json',
      });
    });

    test('returns empty object when all blobs fail to copy', async () => {
      mockSend
        .mockRejectedValueOnce(new Error('Not Found'))
        .mockRejectedValueOnce(new Error('Not Found'));

      const result = await copyBlobs('source-session', 'sessions', 'dest-session', 'sessions', [
        'api_conversation_history',
        'task_metadata',
      ]);

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(result).toEqual({});
    });

    test('returns empty object for empty blobsToCopy array', async () => {
      const result = await copyBlobs('source', 'sessions', 'dest', 'sessions', []);

      expect(mockSend).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });
  });
});
