import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Attachment, Message } from 'chat';
import type { randomUUID as RandomUUID } from 'crypto';
import type { captureException as CaptureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import type { extractAndUploadAttachments as ExtractAndUploadAttachments } from './attachments';

jest.mock('@kilocode/web-shared/lib/r2/client', () => ({
  r2Client: { send: jest.fn() },
  r2CloudAgentAttachmentsBucketName: 'attachment-bucket',
}));

jest.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input, name: 'PutObjectCommand' })),
}));

jest.mock('@/lib/r2/cloud-agent-pending-uploads', () => ({
  admitPendingUpload: jest.fn(),
  linkAttachmentsForDispatch: jest.fn(),
  releasePendingUploads: jest.fn(),
  releaseUnadmittedUploads: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('crypto', () => ({
  randomUUID: jest.fn(),
}));

const MESSAGE_UUID = '11111111-1111-4111-8111-111111111111';
const IMAGE_ID = '22222222-2222-4222-8222-222222222222';
const MARKDOWN_ID = '33333333-3333-4333-8333-333333333333';
const CSV_ID = '44444444-4444-4444-8444-444444444444';
const TEXT_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_IDS = [
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
] as const;
// The ledger's stand-in key for a retry, drawn once per admitted upload.
const FRESH_IDS = [
  'aaaa1111-1111-4111-8111-111111111111',
  'bbbb2222-2222-4222-8222-222222222222',
  'cccc3333-3333-4333-8333-333333333333',
  'dddd4444-4444-4444-8444-444444444444',
  'eeee5555-5555-4555-8555-555555555555',
] as const;
const MAX_SIZE_BYTES = 20 * 1024 * 1024;

let extractAndUploadAttachments: typeof ExtractAndUploadAttachments;
let mockSend: jest.Mock<(command: unknown) => Promise<unknown>>;
let mockRandomUUID: jest.MockedFunction<typeof RandomUUID>;
let mockCaptureException: jest.MockedFunction<typeof CaptureException>;
let mockAdmitPendingUpload: jest.Mock<
  (params: { objectKey: string; byteSize: number }) => Promise<string>
>;
let mockReleasePendingUploads: jest.Mock<
  (kiloUserId: string, objectKeys: string[]) => Promise<void>
>;

function createAttachment(
  attachment: Omit<Attachment, 'fetchData'>,
  contents = 'contents'
): Attachment {
  return {
    ...attachment,
    fetchData: jest.fn(async () => Buffer.from(contents)),
  };
}

function createMessage(attachments: Attachment[]): Message {
  return { attachments } as Message;
}

function commandInput(index: number): Record<string, unknown> {
  const command = mockSend.mock.calls[index]?.[0] as { input: Record<string, unknown> };
  return command.input;
}

describe('extractAndUploadAttachments', () => {
  beforeAll(async () => {
    const crypto = await import('crypto');
    const sentry = await import('@sentry/nextjs');
    const r2 = await import('@kilocode/web-shared/lib/r2/client');
    const pendingUploads = await import('@/lib/r2/cloud-agent-pending-uploads');
    const uploader = await import('./attachments');

    mockRandomUUID = crypto.randomUUID as unknown as jest.MockedFunction<typeof RandomUUID>;
    mockCaptureException = jest.mocked(sentry.captureException);
    mockSend = r2.r2Client.send as unknown as jest.Mock<(command: unknown) => Promise<unknown>>;
    mockAdmitPendingUpload = jest.mocked(pendingUploads.admitPendingUpload) as unknown as jest.Mock<
      (params: { objectKey: string; byteSize: number }) => Promise<string>
    >;
    mockReleasePendingUploads = jest.mocked(
      pendingUploads.releasePendingUploads
    ) as unknown as jest.Mock<(kiloUserId: string, objectKeys: string[]) => Promise<void>>;
    extractAndUploadAttachments = uploader.extractAndUploadAttachments;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSend.mockResolvedValue({});
    // The ledger admits at the nominal key unless a test makes it refuse.
    mockAdmitPendingUpload.mockImplementation(async params => params.objectKey);
    mockReleasePendingUploads.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uploads mixed image and document attachments under one canonical path', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0])
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(FRESH_IDS[1])
      .mockReturnValueOnce(CSV_ID)
      .mockReturnValueOnce(FRESH_IDS[2])
      .mockReturnValueOnce(TEXT_ID)
      .mockReturnValueOnce(FRESH_IDS[3]);

    const result = await extractAndUploadAttachments(
      createMessage([
        createAttachment({ type: 'image', name: 'diagram.png', mimeType: 'image/png' }, 'image'),
        createAttachment({ type: 'file', name: 'requirements.md', mimeType: 'text/plain' }, 'md'),
        createAttachment({ type: 'file', name: 'data.csv', mimeType: 'text/plain' }, 'csv'),
        createAttachment({ type: 'file', name: 'notes.txt' }, 'txt'),
      ]),
      'user-1'
    );

    expect(result).toEqual({
      attachments: {
        path: MESSAGE_UUID,
        files: [`${IMAGE_ID}.png`, `${MARKDOWN_ID}.md`, `${CSV_ID}.csv`, `${TEXT_ID}.txt`],
      },
      objectKeys: [
        `user-1/cloud-agent/${MESSAGE_UUID}/${IMAGE_ID}.png`,
        `user-1/cloud-agent/${MESSAGE_UUID}/${MARKDOWN_ID}.md`,
        `user-1/cloud-agent/${MESSAGE_UUID}/${CSV_ID}.csv`,
        `user-1/cloud-agent/${MESSAGE_UUID}/${TEXT_ID}.txt`,
      ],
      declinedFilenames: [],
    });
    expect(mockAdmitPendingUpload).toHaveBeenCalledTimes(4);
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(commandInput(0)).toMatchObject({
      Key: `user-1/cloud-agent/${MESSAGE_UUID}/${IMAGE_ID}.png`,
      ContentType: 'image/png',
      Metadata: { userId: 'user-1', messageUuid: MESSAGE_UUID, attachmentId: IMAGE_ID },
    });
    expect(commandInput(1)).toMatchObject({
      Key: `user-1/cloud-agent/${MESSAGE_UUID}/${MARKDOWN_ID}.md`,
      ContentType: 'text/markdown',
      Metadata: { userId: 'user-1', messageUuid: MESSAGE_UUID, attachmentId: MARKDOWN_ID },
    });
    expect(commandInput(2)).toMatchObject({
      Key: `user-1/cloud-agent/${MESSAGE_UUID}/${CSV_ID}.csv`,
      ContentType: 'text/csv',
    });
    expect(commandInput(3)).toMatchObject({
      Key: `user-1/cloud-agent/${MESSAGE_UUID}/${TEXT_ID}.txt`,
      ContentType: 'text/plain',
    });
  });

  it('enforces one five-file limit across mixed attachments', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0])
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(FRESH_IDS[1])
      .mockReturnValueOnce(CSV_ID)
      .mockReturnValueOnce(FRESH_IDS[2])
      .mockReturnValueOnce(TEXT_ID)
      .mockReturnValueOnce(FRESH_IDS[3])
      .mockReturnValueOnce(OTHER_IDS[0])
      .mockReturnValueOnce(FRESH_IDS[4]);
    const sixthFetch = jest.fn(async () => Buffer.from('ignored'));

    const result = await extractAndUploadAttachments(
      createMessage([
        createAttachment({ type: 'image', mimeType: 'image/png' }),
        createAttachment({ type: 'file', name: 'one.md', mimeType: 'text/plain' }),
        createAttachment({ type: 'image', mimeType: 'image/jpeg' }),
        createAttachment({ type: 'file', name: 'two.pdf', mimeType: 'application/pdf' }),
        createAttachment({ type: 'file', name: 'three.txt', mimeType: 'text/plain' }),
        { type: 'file', name: 'six.csv', mimeType: 'text/csv', fetchData: sixthFetch },
      ]),
      'user-1'
    );

    expect(result?.attachments?.files).toHaveLength(5);
    expect(mockSend).toHaveBeenCalledTimes(5);
    expect(sixthFetch).not.toHaveBeenCalled();
  });

  it('skips attachments that exceed size limits before or after download', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(CSV_ID)
      .mockReturnValueOnce(FRESH_IDS[0]);
    const preflightFetch = jest.fn(async () => Buffer.from('not-fetched'));
    const oversizedDownloadFetch = jest.fn(async () => Buffer.alloc(MAX_SIZE_BYTES + 1));

    const result = await extractAndUploadAttachments(
      createMessage([
        {
          type: 'file',
          name: 'too-large.pdf',
          mimeType: 'application/pdf',
          size: MAX_SIZE_BYTES + 1,
          fetchData: preflightFetch,
        },
        {
          type: 'file',
          name: 'also-too-large.txt',
          mimeType: 'text/plain',
          fetchData: oversizedDownloadFetch,
        },
        createAttachment({ type: 'file', name: 'valid.md', mimeType: 'text/plain' }),
      ]),
      'user-1'
    );

    expect(result).toEqual({
      attachments: { path: MESSAGE_UUID, files: [`${CSV_ID}.md`] },
      objectKeys: [`user-1/cloud-agent/${MESSAGE_UUID}/${CSV_ID}.md`],
      declinedFilenames: ['too-large.pdf', 'also-too-large.txt'],
    });
    expect(preflightFetch).not.toHaveBeenCalled();
    expect(oversizedDownloadFetch).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(2);
  });

  it('continues uploading when an individual attachment upload fails', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0])
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(FRESH_IDS[1]);
    mockSend.mockRejectedValueOnce(new Error('upload failed')).mockResolvedValueOnce({});

    const result = await extractAndUploadAttachments(
      createMessage([
        createAttachment({ type: 'image', name: 'failed.png', mimeType: 'image/png' }),
        createAttachment({ type: 'file', name: 'saved.md', mimeType: 'text/plain' }),
      ]),
      'user-1'
    );

    expect(result).toEqual({
      attachments: { path: MESSAGE_UUID, files: [`${MARKDOWN_ID}.md`] },
      objectKeys: [`user-1/cloud-agent/${MESSAGE_UUID}/${MARKDOWN_ID}.md`],
      declinedFilenames: ['failed.png'],
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    // The row of the failed write must not hold ceiling budget for its lease.
    expect(mockReleasePendingUploads).toHaveBeenCalledWith('user-1', [
      `user-1/cloud-agent/${MESSAGE_UUID}/${IMAGE_ID}.png`,
    ]);
  });

  it('labels a dropped file the user did not name instead of its generated key', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0])
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(FRESH_IDS[1]);
    mockAdmitPendingUpload.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Maximum 25 uploads allowed per account',
      })
    );

    const result = await extractAndUploadAttachments(
      createMessage([
        createAttachment({ type: 'image', mimeType: 'image/png' }),
        createAttachment({ type: 'file', name: '\u0007\u0007', mimeType: 'text/plain' }),
      ]),
      'user-1'
    );

    expect(result).toEqual({
      objectKeys: [],
      declinedFilenames: ['an unnamed attachment', 'an unnamed attachment'],
    });
    expect(result?.declinedFilenames.join()).not.toContain(IMAGE_ID);
  });

  it('admits each upload with its exact size before writing it', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0])
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(FRESH_IDS[1]);

    await extractAndUploadAttachments(
      createMessage([
        createAttachment({ type: 'image', mimeType: 'image/png' }, '12345'),
        createAttachment({ type: 'file', name: 'notes.md', mimeType: 'text/plain' }, '1234567'),
      ]),
      'user-1'
    );

    expect(mockAdmitPendingUpload).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kiloUserId: 'user-1',
        messageUuid: MESSAGE_UUID,
        attachmentId: IMAGE_ID,
        objectKey: `user-1/cloud-agent/${MESSAGE_UUID}/${IMAGE_ID}.png`,
        byteSize: 5,
      })
    );
    expect(mockAdmitPendingUpload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attachmentId: MARKDOWN_ID,
        objectKey: `user-1/cloud-agent/${MESSAGE_UUID}/${MARKDOWN_ID}.md`,
        byteSize: 7,
      })
    );
    const admitOrder = mockAdmitPendingUpload.mock.invocationCallOrder;
    const writeOrder = mockSend.mock.invocationCallOrder;
    expect(admitOrder[0]).toBeLessThan(writeOrder[0] ?? Number.POSITIVE_INFINITY);
    expect(admitOrder[1]).toBeLessThan(writeOrder[1] ?? Number.POSITIVE_INFINITY);
  });

  it('skips a file the account ceiling refuses and keeps the others', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0])
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(FRESH_IDS[1]);
    mockAdmitPendingUpload.mockRejectedValueOnce(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Maximum 25 uploads allowed per account',
      })
    );

    const result = await extractAndUploadAttachments(
      createMessage([
        createAttachment({ type: 'image', name: 'refused.png', mimeType: 'image/png' }),
        createAttachment({ type: 'file', name: 'saved.md', mimeType: 'text/plain' }),
      ]),
      'user-1'
    );

    expect(result).toEqual({
      attachments: { path: MESSAGE_UUID, files: [`${MARKDOWN_ID}.md`] },
      objectKeys: [`user-1/cloud-agent/${MESSAGE_UUID}/${MARKDOWN_ID}.md`],
      declinedFilenames: ['refused.png'],
    });
    // A refused admit must never reach the bucket.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]?.[0]).toMatchObject({
      input: { Key: `user-1/cloud-agent/${MESSAGE_UUID}/${MARKDOWN_ID}.md` },
    });
    // A bound is an expected answer to the message, not an incident.
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockReleasePendingUploads).not.toHaveBeenCalled();
  });

  it('reports a declined file by name and forwards the rest', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0])
      .mockReturnValueOnce(MARKDOWN_ID)
      .mockReturnValueOnce(FRESH_IDS[1]);
    mockAdmitPendingUpload.mockRejectedValueOnce(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Maximum 25 uploads allowed per account',
      })
    );

    const result = await extractAndUploadAttachments(
      createMessage([
        createAttachment({ type: 'image', name: 'refused.png', mimeType: 'image/png' }),
        createAttachment({ type: 'file', name: 'saved.md', mimeType: 'text/plain' }),
      ]),
      'user-1'
    );

    expect(result?.declinedFilenames).toEqual(['refused.png']);
    expect(result?.attachments?.files).toEqual([`${MARKDOWN_ID}.md`]);
  });

  it('still reports the declined files of a message that forwarded nothing', async () => {
    mockRandomUUID.mockReturnValueOnce(MESSAGE_UUID).mockReturnValueOnce(IMAGE_ID);
    mockAdmitPendingUpload.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Maximum 25 uploads allowed per account',
      })
    );

    const result = await extractAndUploadAttachments(
      createMessage([createAttachment({ type: 'image', name: 'shot.png', mimeType: 'image/png' })]),
      'user-1'
    );

    expect(result).toEqual({
      objectKeys: [],
      declinedFilenames: ['shot.png'],
    });
    expect(result).not.toHaveProperty('attachments');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('writes to the key the ledger admitted', async () => {
    mockRandomUUID
      .mockReturnValueOnce(MESSAGE_UUID)
      .mockReturnValueOnce(IMAGE_ID)
      .mockReturnValueOnce(FRESH_IDS[0]);
    mockAdmitPendingUpload.mockResolvedValueOnce(
      `user-1/cloud-agent/${MESSAGE_UUID}/${OTHER_IDS[0]}.png`
    );

    const result = await extractAndUploadAttachments(
      createMessage([createAttachment({ type: 'image', mimeType: 'image/png' })]),
      'user-1'
    );

    expect(commandInput(0)).toMatchObject({
      Key: `user-1/cloud-agent/${MESSAGE_UUID}/${OTHER_IDS[0]}.png`,
    });
    expect(result?.objectKeys).toEqual([`user-1/cloud-agent/${MESSAGE_UUID}/${OTHER_IDS[0]}.png`]);
    expect(result?.attachments?.files).toEqual([`${OTHER_IDS[0]}.png`]);
  });
});
