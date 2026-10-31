import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { Attachment, Message } from 'chat';
import type {
  discardUploadedAttachments as DiscardUploadedAttachments,
  extractAndUploadAttachments as ExtractAndUploadAttachments,
  linkUploadedAttachments as LinkUploadedAttachments,
} from './attachments';

const mockSend = jest.fn<(command: { input: { Key: string }; name: string }) => Promise<unknown>>();

jest.mock('@kilocode/web-shared/lib/r2/client', () => ({
  r2Client: { send: mockSend },
  r2CloudAgentAttachmentsBucketName: 'attachment-bucket',
}));

jest.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: jest.fn((input: unknown) => ({ input, name: 'PutObjectCommand' })),
  DeleteObjectCommand: jest.fn((input: unknown) => ({ input, name: 'DeleteObjectCommand' })),
}));

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cloud_agent_pending_uploads } from '@kilocode/db/schema';
import { CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT } from '@/lib/cloud-agent/constants';

let extractAndUploadAttachments: typeof ExtractAndUploadAttachments;
let discardUploadedAttachments: typeof DiscardUploadedAttachments;
let linkUploadedAttachments: typeof LinkUploadedAttachments;

function createAttachment(name: string, contents: string): Attachment {
  return {
    type: 'file',
    name,
    mimeType: 'text/plain',
    fetchData: jest.fn(async () => Buffer.from(contents)),
  };
}

function createMessage(attachments: Attachment[]): Message {
  return { attachments } as Message;
}

async function seedPendingRows(kiloUserId: string, rowCount: number): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.insert(cloud_agent_pending_uploads).values(
    Array.from({ length: rowCount }, () => {
      const messageUuid = crypto.randomUUID();
      const attachmentId = crypto.randomUUID();
      return {
        id: crypto.randomUUID(),
        kilo_user_id: kiloUserId,
        object_key: `${kiloUserId}/cloud-agent/${messageUuid}/${attachmentId}.txt`,
        message_uuid: messageUuid,
        attachment_id: attachmentId,
        byte_size: 10,
        status: 'pending',
        expires_at: expiresAt,
      };
    })
  );
}

async function rowsFor(kiloUserId: string) {
  return db
    .select({
      object_key: cloud_agent_pending_uploads.object_key,
      status: cloud_agent_pending_uploads.status,
      byte_size: cloud_agent_pending_uploads.byte_size,
    })
    .from(cloud_agent_pending_uploads)
    .where(eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId));
}

describe('bot attachment uploads against the pending-upload ledger', () => {
  beforeAll(async () => {
    const uploader = await import('./attachments');
    extractAndUploadAttachments = uploader.extractAndUploadAttachments;
    discardUploadedAttachments = uploader.discardUploadedAttachments;
    linkUploadedAttachments = uploader.linkUploadedAttachments;
  });

  afterEach(async () => {
    await db.delete(cloud_agent_pending_uploads).where(sql`true`);
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('refuses a bot upload once the account holds its live-upload ceiling', async () => {
    const kiloUserId = `bot-user-${crypto.randomUUID()}`;
    await seedPendingRows(kiloUserId, CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT);

    const result = await extractAndUploadAttachments(
      createMessage([createAttachment('notes.md', 'notes'), createAttachment('more.txt', 'more')]),
      kiloUserId
    );

    expect(result).toBeUndefined();
    // Nothing reaches the bucket and the pre-existing ceiling is untouched.
    expect(mockSend).not.toHaveBeenCalled();
    expect(await rowsFor(kiloUserId)).toHaveLength(CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT);
    expect((await rowsFor(kiloUserId)).every(row => row.status === 'pending')).toBe(true);
  });

  it('admits a bot message below the ceiling and deletes what no session took', async () => {
    const kiloUserId = `bot-user-${crypto.randomUUID()}`;

    const uploaded = await extractAndUploadAttachments(
      createMessage([
        createAttachment('notes.md', 'notes'),
        createAttachment('more.txt', 'more text'),
      ]),
      kiloUserId
    );

    expect(uploaded?.attachments.files).toHaveLength(2);
    const admitted = await rowsFor(kiloUserId);
    expect(admitted.map(row => row.status)).toEqual(['pending', 'pending']);
    expect(admitted.map(row => row.byte_size).sort()).toEqual([5, 9]);
    expect(admitted.map(row => row.object_key).sort()).toEqual([...uploaded!.objectKeys].sort());

    await discardUploadedAttachments(kiloUserId, uploaded);

    expect((await rowsFor(kiloUserId)).map(row => row.status)).toEqual(['reaped', 'reaped']);
    const deletedKeys = mockSend.mock.calls
      .filter(([command]) => command.name === 'DeleteObjectCommand')
      .map(([command]) => command.input.Key)
      .sort();
    expect(deletedKeys).toEqual([...uploaded!.objectKeys].sort());
  });

  it('keeps the rows a session linked out of the run-level cleanup', async () => {
    const kiloUserId = `bot-user-${crypto.randomUUID()}`;

    const uploaded = await extractAndUploadAttachments(
      createMessage([createAttachment('notes.md', 'notes')]),
      kiloUserId
    );
    expect(uploaded).toBeDefined();

    const linkedKeys = await linkUploadedAttachments(kiloUserId, uploaded?.attachments);
    expect(linkedKeys).toEqual(uploaded?.objectKeys);

    await discardUploadedAttachments(kiloUserId, uploaded);

    expect((await rowsFor(kiloUserId)).map(row => row.status)).toEqual(['linked']);
    expect(mockSend.mock.calls.some(([command]) => command.name === 'DeleteObjectCommand')).toBe(
      false
    );
  });

  it('does not let a linked message keep counting against the ceiling', async () => {
    const kiloUserId = `bot-user-${crypto.randomUUID()}`;

    const first = await extractAndUploadAttachments(
      createMessage([createAttachment('first.md', 'first')]),
      kiloUserId
    );
    await linkUploadedAttachments(kiloUserId, first?.attachments);
    await seedPendingRows(kiloUserId, CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT - 1);

    const second = await extractAndUploadAttachments(
      createMessage([createAttachment('second.md', 'second')]),
      kiloUserId
    );

    expect(second?.attachments.files).toHaveLength(1);
    expect(
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(cloud_agent_pending_uploads)
        .where(
          and(
            eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
            eq(cloud_agent_pending_uploads.status, 'pending')
          )
        )
    ).toEqual([{ count: CLOUD_AGENT_PENDING_UPLOADS_MAX_PER_ACCOUNT }]);
  });
});
