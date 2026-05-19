import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest, putUploadedAttachmentObject, unwrap } from './helpers';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.deleteMessage with attachments', () => {
  it('purges attachment rows and schedules R2 deletes', async () => {
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

    const deleted: string[] = [];
    await runInDurableObject(stub, async instance => {
      const orig = instance.env.MEDIA_BUCKET.delete.bind(instance.env.MEDIA_BUCKET);
      const spy = vi.fn(async (key: string) => {
        deleted.push(key);
        return orig(key);
      });
      (instance.env.MEDIA_BUCKET as unknown as { delete: typeof spy }).delete = spy;
    });

    const del = await stub.deleteMessage({ messageId, senderId: 'user-A' });
    expect(del.ok).toBe(true);

    await new Promise(r => setTimeout(r, 50));

    const stillLinked = await unwrap(
      stub.getAttachmentForRead({
        requesterId: 'user-A',
        attachmentId: a1.attachmentId,
      })
    );
    expect(stillLinked.row).toBeNull();
    expect(deleted.some(k => k.endsWith(`/${a1.attachmentId}`))).toBe(true);
  });
});
