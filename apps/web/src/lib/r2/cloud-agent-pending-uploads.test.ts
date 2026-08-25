import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type {
  admitPendingUpload as AdmitPendingUpload,
  linkPendingUploads as LinkPendingUploads,
  reapAbandonedUploads as ReapAbandonedUploads,
  releasePendingUploads as ReleasePendingUploads,
} from './cloud-agent-pending-uploads';

const mockSend = jest.fn<(command: { input: { Key: string }; name: string }) => Promise<unknown>>();
const mockDeleteObjectCommand = jest.fn<(input: unknown) => { input: unknown; name: string }>(
  input => ({ input, name: 'DeleteObjectCommand' })
);

jest.mock('./client', () => ({
  r2Client: { send: mockSend },
  r2CloudAgentAttachmentsBucketName: 'attachment-bucket',
}));

jest.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: mockDeleteObjectCommand,
}));

import { and, eq, sql } from 'drizzle-orm';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
} from '@/lib/cloud-agent/constants';
import { db } from '@/lib/drizzle';
import { cloud_agent_pending_uploads } from '@kilocode/db/schema';

let admitPendingUpload: typeof AdmitPendingUpload;
let linkPendingUploads: typeof LinkPendingUploads;
let reapAbandonedUploads: typeof ReapAbandonedUploads;
let releasePendingUploads: typeof ReleasePendingUploads;

function buildObjectKey(kiloUserId: string, messageUuid: string, attachmentId: string): string {
  return `${kiloUserId}/cloud-agent/${messageUuid}/${attachmentId}.bin`;
}

async function insertPendingRow(values: {
  kiloUserId: string;
  messageUuid: string;
  attachmentId: string;
  expiresAt: string;
  status?: 'pending' | 'linked' | 'reaped';
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(cloud_agent_pending_uploads).values({
    id,
    kilo_user_id: values.kiloUserId,
    object_key: buildObjectKey(values.kiloUserId, values.messageUuid, values.attachmentId),
    message_uuid: values.messageUuid,
    attachment_id: values.attachmentId,
    byte_size: 42,
    status: values.status ?? 'pending',
    expires_at: values.expiresAt,
  });
  return id;
}

describe('cloud-agent pending-upload ledger', () => {
  beforeAll(async () => {
    const pendingUploadsModule = await import('./cloud-agent-pending-uploads');
    admitPendingUpload = pendingUploadsModule.admitPendingUpload;
    linkPendingUploads = pendingUploadsModule.linkPendingUploads;
    reapAbandonedUploads = pendingUploadsModule.reapAbandonedUploads;
    releasePendingUploads = pendingUploadsModule.releasePendingUploads;
  });

  afterEach(async () => {
    await db.delete(cloud_agent_pending_uploads).where(sql`true`);
    jest.clearAllMocks();
  });

  it('admits exactly the landed file-count bound and rejects the next admit', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();

    for (let i = 0; i < CLOUD_AGENT_ATTACHMENT_MAX_COUNT; i++) {
      await admitPendingUpload({
        kiloUserId,
        messageUuid,
        attachmentId: crypto.randomUUID(),
        objectKey: buildObjectKey(kiloUserId, messageUuid, crypto.randomUUID()),
        byteSize: 42,
      });
    }

    await expect(
      admitPendingUpload({
        kiloUserId,
        messageUuid,
        attachmentId: crypto.randomUUID(),
        objectKey: buildObjectKey(kiloUserId, messageUuid, crypto.randomUUID()),
        byteSize: 42,
      })
    ).rejects.toThrow(
      `Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} attachments allowed per message`
    );

    const rows = await db
      .select()
      .from(cloud_agent_pending_uploads)
      .where(
        and(
          eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId),
          eq(cloud_agent_pending_uploads.message_uuid, messageUuid)
        )
      );
    expect(rows).toHaveLength(CLOUD_AGENT_ATTACHMENT_MAX_COUNT);
  });

  it('rejects an upload above the landed size bound and presigns none', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();

    await expect(
      admitPendingUpload({
        kiloUserId,
        messageUuid,
        attachmentId: crypto.randomUUID(),
        objectKey: buildObjectKey(kiloUserId, messageUuid, crypto.randomUUID()),
        byteSize: CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES + 1,
      })
    ).rejects.toThrow('Attachment exceeds the maximum size');

    await expect(db.select().from(cloud_agent_pending_uploads)).resolves.toHaveLength(0);
  });

  it('links only the supplied object keys and leaves unmatched rows pending', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentA = crypto.randomUUID();
    const attachmentB = crypto.randomUUID();
    const attachmentC = crypto.randomUUID();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const rowA = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachmentA,
      expiresAt: future,
    });
    const rowB = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachmentB,
      expiresAt: future,
    });
    const rowC = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachmentC,
      expiresAt: future,
    });

    await linkPendingUploads(kiloUserId, messageUuid, [
      buildObjectKey(kiloUserId, messageUuid, attachmentA),
      buildObjectKey(kiloUserId, messageUuid, attachmentB),
    ]);

    const linked = await db
      .select({ id: cloud_agent_pending_uploads.id, status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId));

    const byId = new Map(linked.map(row => [row.id, row.status]));
    expect(byId.get(rowA)).toBe('linked');
    expect(byId.get(rowB)).toBe('linked');
    expect(byId.get(rowC)).toBe('pending');
  });

  it('reaps only expired pending objects atomically and never touches linked rows', async () => {
    mockSend.mockResolvedValue({});
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const expiredAttachment = crypto.randomUUID();
    const liveAttachment = crypto.randomUUID();
    const linkedAttachment = crypto.randomUUID();
    const expiredKey = buildObjectKey(kiloUserId, messageUuid, expiredAttachment);
    const linkedKey = buildObjectKey(kiloUserId, messageUuid, linkedAttachment);
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const expiredRow = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: expiredAttachment,
      expiresAt: past,
    });
    const liveRow = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: liveAttachment,
      expiresAt: future,
    });
    // A row that linked after presign (or between the old select/update) is
    // expired by timestamp but must never be reaped: the atomic claim only
    // matches 'pending'.
    const linkedRow = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: linkedAttachment,
      expiresAt: past,
      status: 'linked',
    });

    const summary = await reapAbandonedUploads();

    expect(summary.reaped).toBe(1);
    const sentCommands = mockSend.mock.calls.map(
      call => call[0] as { input: { Key: string }; name: string }
    );
    expect(sentCommands.map(command => command.name)).toEqual(['DeleteObjectCommand']);
    expect(sentCommands[0].input.Key).toBe(expiredKey);
    expect(sentCommands.some(command => command.input.Key === linkedKey)).toBe(false);

    const after = await db
      .select({ id: cloud_agent_pending_uploads.id, status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.kilo_user_id, kiloUserId));
    const byId = new Map(after.map(row => [row.id, row.status]));
    expect(byId.get(expiredRow)).toBe('reaped');
    expect(byId.get(liveRow)).toBe('pending');
    expect(byId.get(linkedRow)).toBe('linked');
  });

  it('releasePendingUploads deletes only the caller pending row and leaves linked and other-user rows', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const otherUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const releasedAttachment = crypto.randomUUID();
    const keptPendingAttachment = crypto.randomUUID();
    const linkedAttachment = crypto.randomUUID();
    const otherUserAttachment = crypto.randomUUID();

    const releasedRow = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: releasedAttachment,
      expiresAt: future,
    });
    const keptPendingRow = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: keptPendingAttachment,
      expiresAt: future,
    });
    const linkedRow = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: linkedAttachment,
      expiresAt: future,
      status: 'linked',
    });
    const otherUserRow = await insertPendingRow({
      kiloUserId: otherUserId,
      messageUuid,
      attachmentId: otherUserAttachment,
      expiresAt: future,
    });

    await releasePendingUploads(kiloUserId, [
      buildObjectKey(kiloUserId, messageUuid, releasedAttachment),
      // Linked row belongs to the caller but must survive (status predicate).
      buildObjectKey(kiloUserId, messageUuid, linkedAttachment),
      // Other user's pending row must survive (owner predicate).
      buildObjectKey(otherUserId, messageUuid, otherUserAttachment),
    ]);

    const remaining = await db
      .select({ id: cloud_agent_pending_uploads.id })
      .from(cloud_agent_pending_uploads);
    const ids = new Set(remaining.map(row => row.id));

    expect(ids.has(releasedRow)).toBe(false);
    expect(ids.has(keptPendingRow)).toBe(true);
    expect(ids.has(linkedRow)).toBe(true);
    expect(ids.has(otherUserRow)).toBe(true);
  });
});
