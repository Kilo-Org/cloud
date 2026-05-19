import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest, putUploadedAttachmentObject, unwrap } from './helpers';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.createMessage with attachment blocks', () => {
  it('rejects when the uploaded R2 object is missing', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const { attachmentId } = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 100,
        filename: 'a.png',
      })
    );

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

    expect(result).toMatchObject({
      ok: false,
      code: 'conflict',
      error: 'Attachment upload is missing',
    });
  });

  it('flips referenced attachment rows to linked', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const { attachmentId, r2Key } = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 100,
        filename: 'a.png',
      })
    );
    await putUploadedAttachmentObject({ r2Key, size: 100, mimeType: 'image/png' });
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
    const linked = await unwrap(stub.getAttachmentForRead({ requesterId: 'user-A', attachmentId }));
    expect(linked.row).not.toBeNull();
  });

  it('uses stored attachment metadata in message content', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const { attachmentId, r2Key } = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 100,
        filename: 'a.png',
      })
    );
    await putUploadedAttachmentObject({ r2Key, size: 100, mimeType: 'image/png' });

    const result = await stub.createMessage({
      senderId: 'user-A',
      content: [
        {
          type: 'attachment',
          attachmentId,
          mimeType: 'application/x-msdownload',
          size: 999_999_999,
          filename: 'evil.exe',
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.content).toEqual([
        {
          type: 'attachment',
          attachmentId,
          mimeType: 'image/png',
          size: 100,
          filename: 'a.png',
        },
      ]);
    }
  });

  it('rejects when attachment uploaderId != sender', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, {
      conversationId,
      creatorId: 'user-A',
      otherMembers: [{ id: 'user-B' }],
    });
    const { attachmentId } = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 100,
        filename: 'a.png',
      })
    );
    const result = await stub.createMessage({
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
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'forbidden',
      error: 'Attachment uploader does not match sender',
    });
  });

  it('rejects when status is already linked', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const { attachmentId, r2Key } = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 100,
        filename: 'a.png',
      })
    );
    await putUploadedAttachmentObject({ r2Key, size: 100, mimeType: 'image/png' });
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

    expect(result).toMatchObject({
      ok: false,
      code: 'conflict',
      error: 'Attachment is already linked',
    });
  });

  it('rejects more than 10 attachments per message', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const blocks: Array<{
      type: 'attachment';
      attachmentId: string;
      mimeType: string;
      size: number;
      filename: string;
    }> = [];
    for (let i = 0; i < 11; i++) {
      const { attachmentId, r2Key } = await unwrap(
        stub.initAttachment({
          uploaderId: 'user-A',
          mimeType: 'image/png',
          size: i + 1,
          filename: `a${i}.png`,
        })
      );
      await putUploadedAttachmentObject({ r2Key, size: i + 1, mimeType: 'image/png' });
      blocks.push({
        type: 'attachment',
        attachmentId,
        mimeType: 'image/png',
        size: i + 1,
        filename: `a${i}.png`,
      });
    }
    const result = await stub.createMessage({ senderId: 'user-A', content: blocks });

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid',
      error: 'At most 10 attachments per message',
    });
  });
});
