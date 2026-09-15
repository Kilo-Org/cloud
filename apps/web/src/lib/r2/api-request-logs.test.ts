import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync, gzipSync } from 'node:zlib';
import { r2Client } from './client';
import {
  deleteApiRequestLogPayloads,
  getApiRequestLogPayload,
  putApiRequestLogPayload,
} from './api-request-logs';

jest.mock('./client', () => ({
  r2Client: { send: jest.fn() },
  r2ApiRequestLogBucketName: 'api-log-bucket',
}));

type MockR2Send = (command: { input: Record<string, unknown> }) => Promise<Record<string, unknown>>;

const mockSend = r2Client.send as unknown as jest.Mock<MockR2Send>;

function objectKey(index = 0): string {
  const uuid = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return `api-request-logs/v1/2026/09/15/${uuid}.json.gz`;
}

describe('API request log R2 storage', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('writes a compressed versioned payload under the API log prefix', async () => {
    mockSend.mockResolvedValue({});

    const key = await putApiRequestLogPayload({
      request: { messages: [{ role: 'user', content: 'hello' }] },
      response: '{"ok":true}',
    });
    if (!key) throw new Error('Expected an R2 object key');

    expect(key).toMatch(/^api-request-logs\/v1\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+\.json\.gz$/);
    const command = mockSend.mock.calls[0]?.[0];
    if (!command) throw new Error('Expected an R2 put command');
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'api-log-bucket',
      Key: key,
      ContentType: 'application/json; charset=utf-8',
      ContentEncoding: 'gzip',
    });
    const stored = JSON.parse(gunzipSync(command.input.Body as Uint8Array).toString('utf8'));
    expect(stored).toEqual({
      version: 1,
      request: { messages: [{ role: 'user', content: 'hello' }] },
      response: '{"ok":true}',
    });
  });

  it('reads and validates compressed payloads', async () => {
    mockSend.mockResolvedValue({
      Body: {
        transformToByteArray: async () =>
          gzipSync(JSON.stringify({ version: 1, request: { input: true }, response: null })),
      },
    });

    await expect(getApiRequestLogPayload(objectKey())).resolves.toEqual({
      version: 1,
      request: { input: true },
      response: null,
    });
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it('rejects payloads with an unknown version', async () => {
    mockSend.mockResolvedValue({
      Body: {
        transformToByteArray: async () =>
          gzipSync(JSON.stringify({ version: 2, request: {}, response: null })),
      },
    });

    await expect(getApiRequestLogPayload(objectKey())).rejects.toThrow();
  });

  it('deletes objects in R2 batches of at most 1,000', async () => {
    mockSend.mockResolvedValue({});
    const keys = Array.from({ length: 1_001 }, (_, index) => objectKey(index));

    const result = await deleteApiRequestLogPayloads(keys);

    expect(mockSend).toHaveBeenCalledTimes(2);
    const first = mockSend.mock.calls[0]?.[0];
    const second = mockSend.mock.calls[1]?.[0];
    if (!first || !second) throw new Error('Expected two R2 delete commands');
    expect(first).toBeInstanceOf(DeleteObjectsCommand);
    const firstDelete = first.input.Delete as { Objects: unknown[] };
    const secondDelete = second.input.Delete as { Objects: unknown[] };
    expect(firstDelete.Objects).toHaveLength(1_000);
    expect(secondDelete.Objects).toHaveLength(1);
    expect(result).toEqual({ deletedKeys: keys, failedKeys: [] });
  });

  it('returns keys with per-object deletion errors for retry', async () => {
    mockSend.mockResolvedValue({ Errors: [{ Key: objectKey() }] });

    await expect(deleteApiRequestLogPayloads([objectKey()])).resolves.toEqual({
      deletedKeys: [],
      failedKeys: [objectKey()],
    });
  });

  it('rejects keys outside the API request log namespace', async () => {
    await expect(deleteApiRequestLogPayloads(['experiment-prompt-key'])).rejects.toThrow(
      'Invalid API request log object key'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
