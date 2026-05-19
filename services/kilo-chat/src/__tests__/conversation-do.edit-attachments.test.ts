import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest, putUploadedAttachmentObject, unwrap } from './helpers';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.editMessage with attachments', () => {
  it('allows removing attachments and deletes their rows + R2 objects', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });

    const a1 = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 1,
        filename: 'a1',
      })
    );
    const a2 = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 2,
        filename: 'a2',
      })
    );
    await putUploadedAttachmentObject({ r2Key: a1.r2Key, size: 1, mimeType: 'image/png' });
    await putUploadedAttachmentObject({ r2Key: a2.r2Key, size: 2, mimeType: 'image/png' });

    const create = await stub.createMessage({
      senderId: 'user-A',
      content: [
        {
          type: 'attachment',
          attachmentId: a1.attachmentId,
          mimeType: 'image/png',
          size: 1,
          filename: 'a1',
        },
        {
          type: 'attachment',
          attachmentId: a2.attachmentId,
          mimeType: 'image/png',
          size: 2,
          filename: 'a2',
        },
      ],
    });
    expect(create.ok).toBe(true);
    const messageId = create.ok ? create.messageId : '';

    const deleted: string[] = [];
    await runInDurableObject(stub, async instance => {
      const orig = instance.env.MEDIA_BUCKET.delete.bind(instance.env.MEDIA_BUCKET);
      const spy = vi.fn(async (key: string) => {
        deleted.push(key);
        return orig(key);
      });
      // Replace delete for the duration of this test.
      (instance.env.MEDIA_BUCKET as unknown as { delete: typeof spy }).delete = spy;
    });

    const edit = await stub.editMessage({
      messageId,
      senderId: 'user-A',
      clientTimestamp: Date.now(),
      content: [
        {
          type: 'attachment',
          attachmentId: a1.attachmentId,
          mimeType: 'image/png',
          size: 1,
          filename: 'a1',
        },
      ],
    });
    expect(edit.ok).toBe(true);

    // Give waitUntil a tick.
    await new Promise(r => setTimeout(r, 50));

    const stillLinked = await unwrap(
      stub.getAttachmentForRead({
        requesterId: 'user-A',
        attachmentId: a2.attachmentId,
      })
    );
    expect(stillLinked.row).toBeNull();
    expect(deleted.some(k => k.endsWith(`/${a2.attachmentId}`))).toBe(true);
  });

  it('rejects adding a new attachment in edit', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });

    const a1 = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 1,
        filename: 'a1',
      })
    );
    await putUploadedAttachmentObject({ r2Key: a1.r2Key, size: 1, mimeType: 'image/png' });
    const create = await stub.createMessage({
      senderId: 'user-A',
      content: [
        {
          type: 'attachment',
          attachmentId: a1.attachmentId,
          mimeType: 'image/png',
          size: 1,
          filename: 'a1',
        },
      ],
    });
    expect(create.ok).toBe(true);
    const messageId = create.ok ? create.messageId : '';

    const a2 = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 2,
        filename: 'a2',
      })
    );
    const edit = await stub.editMessage({
      messageId,
      senderId: 'user-A',
      clientTimestamp: Date.now() + 1,
      content: [
        {
          type: 'attachment',
          attachmentId: a1.attachmentId,
          mimeType: 'image/png',
          size: 1,
          filename: 'a1',
        },
        {
          type: 'attachment',
          attachmentId: a2.attachmentId,
          mimeType: 'image/png',
          size: 2,
          filename: 'a2',
        },
      ],
    });

    expect(edit).toMatchObject({
      ok: false,
      code: 'conflict',
      error: 'Cannot add attachments',
    });
  });

  it('uses stored attachment metadata when editing message content', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });

    const a1 = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 1,
        filename: 'a1',
      })
    );
    await putUploadedAttachmentObject({ r2Key: a1.r2Key, size: 1, mimeType: 'image/png' });
    const create = await stub.createMessage({
      senderId: 'user-A',
      content: [
        {
          type: 'attachment',
          attachmentId: a1.attachmentId,
          mimeType: 'image/png',
          size: 1,
          filename: 'a1',
        },
      ],
    });
    expect(create.ok).toBe(true);
    const messageId = create.ok ? create.messageId : '';

    const edit = await stub.editMessage({
      messageId,
      senderId: 'user-A',
      clientTimestamp: Date.now(),
      content: [
        {
          type: 'attachment',
          attachmentId: a1.attachmentId,
          mimeType: 'application/x-msdownload',
          size: 999_999_999,
          filename: 'evil.exe',
        },
      ],
    });
    expect(edit.ok).toBe(true);

    const message = await stub.getMessage(messageId);
    expect(message?.content).toEqual([
      {
        type: 'attachment',
        attachmentId: a1.attachmentId,
        mimeType: 'image/png',
        size: 1,
        filename: 'a1',
      },
    ]);
  });
});
