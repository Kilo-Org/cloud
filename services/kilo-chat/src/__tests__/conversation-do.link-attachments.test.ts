import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
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

  it('links an attachment when the remote R2 object exists but the local binding cannot see it', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const { attachmentId } = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'text/plain',
        size: 42,
        filename: 'remote.txt',
      })
    );

    const fetchSpy = vi.fn(async (request: RequestInfo | URL) => {
      const req = new Request(request);
      expect(req.method).toBe('HEAD');
      return new Response(null, { status: 200, headers: { 'Content-Length': '42' } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await runInDurableObject(stub, async instance => {
        const bucket = instance.env.MEDIA_BUCKET as unknown as {
          head: typeof instance.env.MEDIA_BUCKET.head;
        };
        const originalHead = bucket.head;
        const originalAccessKeyGet = instance.env.R2_ACCESS_KEY_ID.get;
        const originalSecretKeyGet = instance.env.R2_SECRET_ACCESS_KEY.get;
        bucket.head = vi.fn(async () => null);
        instance.env.R2_ACCESS_KEY_ID.get = vi.fn(async () => 'AKIA-TEST');
        instance.env.R2_SECRET_ACCESS_KEY.get = vi.fn(async () => 'SECRET-TEST');
        try {
          return await instance.createMessage({
            senderId: 'user-A',
            content: [
              {
                type: 'attachment',
                attachmentId,
                mimeType: 'text/plain',
                size: 42,
                filename: 'remote.txt',
              },
            ],
          });
        } finally {
          bucket.head = originalHead;
          instance.env.R2_ACCESS_KEY_ID.get = originalAccessKeyGet;
          instance.env.R2_SECRET_ACCESS_KEY.get = originalSecretKeyGet;
        }
      });

      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
