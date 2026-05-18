import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.createMessage with attachment blocks', () => {
  it('flips referenced attachment rows to linked', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    const { attachmentId } = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 100,
      filename: 'a.png',
    });
    const result = await stub.createMessage({
      senderId: 'user-A',
      content: [
        {
          type: 'attachment',
          attachmentId,
          mimeType: 'image/png',
          size: 100,
          filename: 'a.png',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toBeTruthy();
    }
    const linked = await stub.getAttachmentForRead({
      requesterId: 'user-A',
      attachmentId,
    });
    expect(linked).not.toBeNull();
  });

  it('rejects when attachment uploaderId != sender', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({
      creatorId: 'user-A',
      otherMembers: [{ id: 'user-B' }],
    });
    const { attachmentId } = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 100,
      filename: 'a.png',
    });
    await runInDurableObject(stub, async (instance: ConversationDO) => {
      expect(() =>
        instance.createMessage({
          senderId: 'user-B',
          content: [
            {
              type: 'attachment',
              attachmentId,
              mimeType: 'image/png',
              size: 100,
              filename: 'a.png',
            },
          ],
        })
      ).toThrow(/uploader/i);
    });
  });

  it('rejects when status is already linked', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    const { attachmentId } = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 100,
      filename: 'a.png',
    });
    await stub.createMessage({
      senderId: 'user-A',
      content: [
        {
          type: 'attachment',
          attachmentId,
          mimeType: 'image/png',
          size: 100,
          filename: 'a.png',
        },
      ],
    });
    await runInDurableObject(stub, async (instance: ConversationDO) => {
      expect(() =>
        instance.createMessage({
          senderId: 'user-A',
          content: [
            {
              type: 'attachment',
              attachmentId,
              mimeType: 'image/png',
              size: 100,
              filename: 'a.png',
            },
          ],
        })
      ).toThrow(/pending/i);
    });
  });

  it('rejects more than 10 attachments per message', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    const blocks: Array<{
      type: 'attachment';
      attachmentId: string;
      mimeType: string;
      size: number;
      filename: string;
    }> = [];
    for (let i = 0; i < 11; i++) {
      const { attachmentId } = await stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: i + 1,
        filename: `a${i}.png`,
      });
      blocks.push({
        type: 'attachment',
        attachmentId,
        mimeType: 'image/png',
        size: i + 1,
        filename: `a${i}.png`,
      });
    }
    await runInDurableObject(stub, async (instance: ConversationDO) => {
      expect(() => instance.createMessage({ senderId: 'user-A', content: blocks })).toThrow(/10/);
    });
  });
});
