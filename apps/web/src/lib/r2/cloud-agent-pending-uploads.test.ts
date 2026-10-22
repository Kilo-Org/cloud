import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type {
  admitPendingUpload as AdmitPendingUpload,
  linkAttachmentsForDispatch as LinkAttachmentsForDispatch,
  linkPendingUploads as LinkPendingUploads,
  reapAbandonedUploads as ReapAbandonedUploads,
  releasePendingUploads as ReleasePendingUploads,
} from './cloud-agent-pending-uploads';

const mockSend = jest.fn<(command: { input: { Key: string }; name: string }) => Promise<unknown>>();
const mockDeleteObjectCommand = jest.fn<(input: unknown) => { input: unknown; name: string }>(
  input => ({ input, name: 'DeleteObjectCommand' })
);

jest.mock('@kilocode/web-shared/lib/r2/client', () => ({
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
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cloud_agent_pending_uploads } from '@kilocode/db/schema';

let admitPendingUpload: typeof AdmitPendingUpload;
let linkAttachmentsForDispatch: typeof LinkAttachmentsForDispatch;
let linkPendingUploads: typeof LinkPendingUploads;
let reapAbandonedUploads: typeof ReapAbandonedUploads;
let releasePendingUploads: typeof ReleasePendingUploads;

function buildObjectKey(kiloUserId: string, messageUuid: string, attachmentId: string): string {
  return `${kiloUserId}/cloud-agent/${messageUuid}/${attachmentId}.bin`;
}

/** Admit with a random fresh key, as the presign helper does. */
function admit(
  params: Omit<Parameters<typeof AdmitPendingUpload>[0], 'freshObjectKey'>
): Promise<string> {
  return admitPendingUpload({
    ...params,
    freshObjectKey: buildObjectKey(params.kiloUserId, params.messageUuid, crypto.randomUUID()),
  });
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
    linkAttachmentsForDispatch = pendingUploadsModule.linkAttachmentsForDispatch;
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
      await admit({
        kiloUserId,
        messageUuid,
        attachmentId: crypto.randomUUID(),
        objectKey: buildObjectKey(kiloUserId, messageUuid, crypto.randomUUID()),
        byteSize: 42,
      });
    }

    await expect(
      admit({
        kiloUserId,
        messageUuid,
        attachmentId: crypto.randomUUID(),
        objectKey: buildObjectKey(kiloUserId, messageUuid, crypto.randomUUID()),
        byteSize: 42,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: `Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} attachments allowed per message`,
    });

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
      admit({
        kiloUserId,
        messageUuid,
        attachmentId: crypto.randomUUID(),
        objectKey: buildObjectKey(kiloUserId, messageUuid, crypto.randomUUID()),
        byteSize: CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES + 1,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Attachment exceeds the maximum size',
    });

    await expect(db.select().from(cloud_agent_pending_uploads)).resolves.toHaveLength(0);
  });

  it('refreshes a pending row when the same key is admitted again', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachmentId);
    const soon = new Date(Date.now() + 60_000).toISOString();
    await insertPendingRow({ kiloUserId, messageUuid, attachmentId, expiresAt: soon });

    await expect(
      admit({ kiloUserId, messageUuid, attachmentId, objectKey, byteSize: 99 })
    ).resolves.toBe(objectKey);

    const rows = await db
      .select()
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.object_key, objectKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', byte_size: 99 });
    expect(new Date(rows[0]?.expires_at ?? 0).getTime()).toBeGreaterThan(
      Date.now() + 23 * 60 * 60 * 1000
    );
  });

  it('admits a same-key retry at the file-count bound', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentIds = Array.from({ length: CLOUD_AGENT_ATTACHMENT_MAX_COUNT }, () =>
      crypto.randomUUID()
    );
    for (const attachmentId of attachmentIds) {
      await admit({
        kiloUserId,
        messageUuid,
        attachmentId,
        objectKey: buildObjectKey(kiloUserId, messageUuid, attachmentId),
        byteSize: 42,
      });
    }

    const retriedId = attachmentIds[0] ?? '';
    await admit({
      kiloUserId,
      messageUuid,
      attachmentId: retriedId,
      objectKey: buildObjectKey(kiloUserId, messageUuid, retriedId),
      byteSize: 42,
    });

    const rows = await db
      .select()
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.message_uuid, messageUuid));
    expect(rows).toHaveLength(CLOUD_AGENT_ATTACHMENT_MAX_COUNT);
  });

  it('admits a fresh key after the client released the key before a retry', async () => {
    mockSend.mockResolvedValue({});
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachmentId);
    await admit({ kiloUserId, messageUuid, attachmentId, objectKey, byteSize: 42 });
    await releasePendingUploads(kiloUserId, [objectKey]);

    const admittedKey = await admit({
      kiloUserId,
      messageUuid,
      attachmentId,
      objectKey,
      byteSize: 99,
    });

    expect(admittedKey).not.toBe(objectKey);
    const rows = await db
      .select({
        object_key: cloud_agent_pending_uploads.object_key,
        status: cloud_agent_pending_uploads.status,
        byte_size: cloud_agent_pending_uploads.byte_size,
      })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.message_uuid, messageUuid));
    expect(rows).toEqual(
      expect.arrayContaining([
        { object_key: objectKey, status: 'reaped', byte_size: 42 },
        { object_key: admittedKey, status: 'pending', byte_size: 99 },
      ])
    );
    expect(rows).toHaveLength(2);
  });

  it('refreshes the fresh-key row when a retry presigns again without a release', async () => {
    mockSend.mockResolvedValue({});
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachmentId);
    for (let i = 1; i < CLOUD_AGENT_ATTACHMENT_MAX_COUNT; i++) {
      const otherId = crypto.randomUUID();
      await admit({
        kiloUserId,
        messageUuid,
        attachmentId: otherId,
        objectKey: buildObjectKey(kiloUserId, messageUuid, otherId),
        byteSize: 1,
      });
    }
    await admit({ kiloUserId, messageUuid, attachmentId, objectKey, byteSize: 42 });
    await releasePendingUploads(kiloUserId, [objectKey]);
    const freshKey = await admit({
      kiloUserId,
      messageUuid,
      attachmentId,
      objectKey,
      byteSize: 42,
    });

    // The release of freshKey failed, so the client retries with the same ids.
    await expect(
      admit({ kiloUserId, messageUuid, attachmentId, objectKey, byteSize: 99 })
    ).resolves.toBe(freshKey);

    const rows = await db
      .select({
        object_key: cloud_agent_pending_uploads.object_key,
        byte_size: cloud_agent_pending_uploads.byte_size,
      })
      .from(cloud_agent_pending_uploads)
      .where(
        and(
          eq(cloud_agent_pending_uploads.attachment_id, attachmentId),
          eq(cloud_agent_pending_uploads.status, 'pending')
        )
      );
    expect(rows).toEqual([{ object_key: freshKey, byte_size: 99 }]);
  });

  it('admits a fresh key when a retry lands while the release still deletes the old object', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachmentId);
    await admit({ kiloUserId, messageUuid, attachmentId, objectKey, byteSize: 42 });

    let retryKey: string | undefined;
    mockSend.mockImplementation(async () => {
      retryKey = await admit({ kiloUserId, messageUuid, attachmentId, objectKey, byteSize: 99 });
      return {};
    });
    await releasePendingUploads(kiloUserId, [objectKey]);

    expect(retryKey).toBeDefined();
    expect(retryKey).not.toBe(objectKey);
    expect(mockSend.mock.calls.map(([command]) => command.input.Key)).toEqual([objectKey]);
    const [retryRow] = await db
      .select({ status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.object_key, retryKey ?? ''));
    expect(retryRow?.status).toBe('pending');
  });

  it('never re-admits a key already linked to a sent message', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachmentId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId,
      expiresAt: future,
      status: 'linked',
    });

    const admittedKey = await admit({
      kiloUserId,
      messageUuid,
      attachmentId,
      objectKey,
      byteSize: 99,
    });

    expect(admittedKey).not.toBe(objectKey);
    const [linkedRow] = await db
      .select()
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.object_key, objectKey));
    expect(linkedRow).toMatchObject({ status: 'linked', byte_size: 42 });
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

  it('reaps only expired pending objects and never touches linked rows', async () => {
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
    // A row that linked after presign is expired by timestamp but must never
    // be reaped: the scan only matches 'pending'.
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

  it('keeps an expired row pending when its object delete fails, so the next run retries it', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const past = new Date(Date.now() - 60_000).toISOString();

    const expiredRow = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId,
      expiresAt: past,
    });

    mockSend.mockRejectedValueOnce(new Error('R2 unavailable'));
    const failed = await reapAbandonedUploads();
    expect(failed.reaped).toBe(0);
    expect(
      (
        await db
          .select({ status: cloud_agent_pending_uploads.status })
          .from(cloud_agent_pending_uploads)
          .where(eq(cloud_agent_pending_uploads.id, expiredRow))
      )[0]?.status
    ).toBe('pending');

    mockSend.mockResolvedValue({});
    const retried = await reapAbandonedUploads();
    expect(retried.reaped).toBe(1);
    expect(
      (
        await db
          .select({ status: cloud_agent_pending_uploads.status })
          .from(cloud_agent_pending_uploads)
          .where(eq(cloud_agent_pending_uploads.id, expiredRow))
      )[0]?.status
    ).toBe('reaped');
  });

  it('admits at most the file-count bound when presigns for one message race', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: CLOUD_AGENT_ATTACHMENT_MAX_COUNT + 3 }, () =>
        admit({
          kiloUserId,
          messageUuid,
          attachmentId: crypto.randomUUID(),
          objectKey: buildObjectKey(kiloUserId, messageUuid, crypto.randomUUID()),
          byteSize: 1,
        })
      )
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
      CLOUD_AGENT_ATTACHMENT_MAX_COUNT
    );
    await expect(db.select().from(cloud_agent_pending_uploads)).resolves.toHaveLength(
      CLOUD_AGENT_ATTACHMENT_MAX_COUNT
    );
  });

  it('releasePendingUploads deletes only the caller pending object and leaves linked and other-user rows', async () => {
    mockSend.mockResolvedValue({});
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

    // The released object is gone from the bucket, and only its row leaves the
    // quota: a delete of the linked or the other user's key would strand a live
    // attachment.
    const deletedKeys = mockSend.mock.calls.map(call => call[0].input.Key);
    expect(deletedKeys).toEqual([buildObjectKey(kiloUserId, messageUuid, releasedAttachment)]);

    const remaining = await db
      .select({ id: cloud_agent_pending_uploads.id, status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads);
    const byId = new Map(remaining.map(row => [row.id, row.status]));

    expect(byId.get(releasedRow)).toBe('reaped');
    expect(byId.get(keptPendingRow)).toBe('pending');
    expect(byId.get(linkedRow)).toBe('linked');
    expect(byId.get(otherUserRow)).toBe('pending');
  });

  it('moves a released row out of pending before deleting its R2 object', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachment);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: future,
    });

    // The row must already be claimed when the object delete runs. An
    // unclaimed select would still show 'pending' here, leaving a window for
    // linkPendingUploads to flip the row after the object is gone.
    const statusesAtDelete: (string | undefined)[] = [];
    mockSend.mockImplementation(async () => {
      const rows = await db
        .select({ status: cloud_agent_pending_uploads.status })
        .from(cloud_agent_pending_uploads)
        .where(eq(cloud_agent_pending_uploads.object_key, objectKey));
      statusesAtDelete.push(rows[0]?.status);
      return {};
    });

    await releasePendingUploads(kiloUserId, [objectKey]);

    expect(statusesAtDelete).toEqual(['reaped']);
  });

  it('puts a released row back to pending when its object delete fails', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachment);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const row = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: future,
    });

    mockSend.mockRejectedValueOnce(new Error('R2 unavailable'));
    await releasePendingUploads(kiloUserId, [objectKey]);

    // The object survived the failed delete, so the row must stay reapable
    // instead of leaving the object with no handle.
    expect(
      (
        await db
          .select({ status: cloud_agent_pending_uploads.status })
          .from(cloud_agent_pending_uploads)
          .where(eq(cloud_agent_pending_uploads.id, row))
      )[0]?.status
    ).toBe('pending');
  });

  it('moves an expired row out of pending before deleting its object', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachment);
    const past = new Date(Date.now() - 60_000).toISOString();

    await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: past,
    });

    // A row picked by the reaper must be out of 'pending' before DeleteObject
    // runs, so a caller that links afterwards reads 'reaped' and refuses the
    // dispatch instead of promising an object that is gone.
    const statusesAtDelete: (string | undefined)[] = [];
    mockSend.mockImplementation(async () => {
      const rows = await db
        .select({ status: cloud_agent_pending_uploads.status })
        .from(cloud_agent_pending_uploads)
        .where(eq(cloud_agent_pending_uploads.object_key, objectKey));
      statusesAtDelete.push(rows[0]?.status);
      return {};
    });

    await reapAbandonedUploads();

    expect(statusesAtDelete).toEqual(['reaped']);
  });

  it('keeps a linked attachment object when the reaper runs afterwards', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachment);
    const past = new Date(Date.now() - 60_000).toISOString();
    mockSend.mockResolvedValue({});

    const row = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: past,
    });

    const linked = await linkPendingUploads(kiloUserId, messageUuid, [objectKey]);
    expect(linked).toEqual({ reapedObjectKeys: [] });

    const summary = await reapAbandonedUploads();

    expect(summary.reaped).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    const [after] = await db
      .select({ status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.id, row));
    expect(after?.status).toBe('linked');
  });

  it('reports the attachment row a reaper claim took first and does not link it', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachment);
    const past = new Date(Date.now() - 60_000).toISOString();
    mockSend.mockResolvedValue({});

    const row = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: past,
    });

    await reapAbandonedUploads();

    const linked = await linkPendingUploads(kiloUserId, messageUuid, [objectKey]);
    expect(linked).toEqual({ reapedObjectKeys: [objectKey] });
    const [after] = await db
      .select({ status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.id, row));
    expect(after?.status).toBe('reaped');
  });

  it('does not reap a lease a retry refreshes before the claim runs', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockSend.mockResolvedValue({});

    const row = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: past,
    });

    const hold = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<void>();

    // The retry presign extends the lease while the reaper is already running.
    // Whichever statement reaches the row first, the lease re-check in the
    // claim keeps the object; only an expired row may be deleted.
    const refreshing = db.transaction(async tx => {
      await tx
        .update(cloud_agent_pending_uploads)
        .set({ expires_at: future })
        .where(eq(cloud_agent_pending_uploads.id, row));
      refreshed.resolve();
      await hold.promise;
    });

    await refreshed.promise;
    const reaping = reapAbandonedUploads();
    hold.resolve();
    await refreshing;

    expect(await reaping).toEqual({ reaped: 0 });
    expect(mockSend).not.toHaveBeenCalled();
    const [after] = await db
      .select({ status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.id, row));
    expect(after?.status).toBe('pending');
  });

  it('links a message attachment row before dispatch and tolerates a key with no row', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const legacyFile = `${crypto.randomUUID()}.pdf`;
    const objectKey = buildObjectKey(kiloUserId, messageUuid, attachment);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const row = await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: future,
    });

    await linkAttachmentsForDispatch(kiloUserId, {
      path: messageUuid,
      files: [`${attachment}.bin`, legacyFile],
    });

    const [after] = await db
      .select({ status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.id, row));
    expect(after?.status).toBe('linked');
  });

  it('refuses a dispatch whose attachment row was already reaped', async () => {
    const kiloUserId = `ca-user-${crypto.randomUUID()}`;
    const messageUuid = crypto.randomUUID();
    const attachment = crypto.randomUUID();
    const past = new Date(Date.now() - 60_000).toISOString();

    await insertPendingRow({
      kiloUserId,
      messageUuid,
      attachmentId: attachment,
      expiresAt: past,
      status: 'reaped',
    });

    await expect(
      linkAttachmentsForDispatch(kiloUserId, {
        path: messageUuid,
        files: [`${attachment}.bin`],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
