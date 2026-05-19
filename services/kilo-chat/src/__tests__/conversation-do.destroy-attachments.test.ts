import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest, putUploadedAttachmentObject, unwrap } from './helpers';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.destroyAndReturnMembers with attachments', () => {
  it('purges all attachments and their R2 objects on destroy', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });

    // Linked attachment (referenced by a message)
    const linked = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 1,
        filename: 'linked',
      })
    );
    await putUploadedAttachmentObject({ r2Key: linked.r2Key, size: 1, mimeType: 'image/png' });
    const create = await stub.createMessage({
      senderId: 'user-A',
      content: [
        {
          type: 'attachment',
          attachmentId: linked.attachmentId,
          mimeType: 'image/png',
          size: 1,
          filename: 'linked',
        },
      ],
    });
    expect(create.ok).toBe(true);

    // Pending (never linked) attachment
    const pending = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 2,
        filename: 'pending',
      })
    );

    // Pre-populate R2 so list() returns pending uploads too.
    await env.MEDIA_BUCKET.put(pending.r2Key, new Uint8Array([0x02]));

    const deletedKeys: string[] = [];
    await runInDurableObject(stub, async instance => {
      const orig = instance.env.MEDIA_BUCKET.delete.bind(instance.env.MEDIA_BUCKET);
      const spy = vi.fn(async (key: string | string[]) => {
        if (Array.isArray(key)) deletedKeys.push(...key);
        else deletedKeys.push(key);
        return orig(key as string);
      });
      (instance.env.MEDIA_BUCKET as unknown as { delete: typeof spy }).delete = spy;
    });

    const result = await stub.destroyAndReturnMembers();
    expect(result).not.toBeNull();

    expect(deletedKeys).toContain(linked.r2Key);
    expect(deletedKeys).toContain(pending.r2Key);
  });
});
