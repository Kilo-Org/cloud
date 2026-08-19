/* eslint-disable drizzle/enforce-delete-with-where */
import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/r2/client', () => ({
  r2Client: { send: jest.fn() },
  r2CloudAgentAttachmentsBucketName: 'attachment-bucket',
}));
jest.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'DeleteObjectCommand' })),
}));
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(),
    delete: jest.fn(),
  },
}));

import { db } from '@/lib/drizzle';
import { r2Client } from '@/lib/r2/client';
import { GET } from './route';

const mockSend = jest.mocked(r2Client.send);
const mockSelect = jest.mocked(db.select);
const mockDelete = jest.mocked(db.delete);

const BATCH_SIZE = 500;

let selectedRows: { r2_key: string }[];
let deletedRows: { r2_key: string }[];
let capturedLimit: number | undefined;

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost/api/cron/cleanup-orphan-agent-attachments', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-orphan-agent-attachments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selectedRows = [];
    deletedRows = [];
    capturedLimit = undefined;
    mockSend.mockResolvedValue(undefined as never);
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: (n: number) => {
            capturedLimit = n;
            return Promise.resolve(selectedRows);
          },
        }),
      }),
    } as never);
    mockDelete.mockReturnValue({
      where: () => ({
        returning: () => Promise.resolve(deletedRows),
      }),
    } as never);
  });

  it('rejects requests without the cron secret', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('deletes the row before the object for each unconsumed key', async () => {
    selectedRows = [
      { r2_key: 'user-1/cloud-agent/msg-1/file.pdf' },
      { r2_key: 'user-2/cloud-agent/msg-2/file.png' },
    ];
    deletedRows = selectedRows;

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    // The rows are deleted first, and only the keys actually deleted get their
    // object removed (the delete is conditional on still-unconsumed).
    expect(mockDelete).toHaveBeenCalledTimes(1);
    const deleteOrder = mockDelete.mock.invocationCallOrder[0];
    const firstSendOrder = mockSend.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(firstSendOrder);
    // One object delete per deleted key, against the attachment bucket.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenNthCalledWith(1, {
      input: { Bucket: 'attachment-bucket', Key: 'user-1/cloud-agent/msg-1/file.pdf' },
      name: 'DeleteObjectCommand',
    });
    expect(mockSend).toHaveBeenNthCalledWith(2, {
      input: { Bucket: 'attachment-bucket', Key: 'user-2/cloud-agent/msg-2/file.png' },
      name: 'DeleteObjectCommand',
    });

    const body = await response.json();
    expect(body.deletedObjects).toBe(2);
    expect(body.deletedRows).toBe(2);
  });

  it('bounds the selection to BATCH_SIZE rows', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    expect(capturedLimit).toBe(BATCH_SIZE);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('keeps the object when the conditional delete returns no row for a consumed key', async () => {
    selectedRows = [{ r2_key: 'user-1/cloud-agent/msg-1/file.pdf' }];
    // The row was marked consumed between the select and the delete, so the
    // conditional delete returns no row and the object must survive.
    deletedRows = [];

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.deletedObjects).toBe(0);
    expect(body.deletedRows).toBe(0);
  });
});
