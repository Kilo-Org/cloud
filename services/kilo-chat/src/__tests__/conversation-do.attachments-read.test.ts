import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest } from './helpers';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.getAttachmentForRead', () => {
  it('returns null when row does not exist', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    expect(
      await stub.getAttachmentForRead({ requesterId: 'user-A', attachmentId: ulid() })
    ).toBeNull();
  });

  it('returns null when row is still pending', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const { attachmentId } = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 1,
      filename: 'a.png',
    });
    expect(await stub.getAttachmentForRead({ requesterId: 'user-A', attachmentId })).toBeNull();
  });

  it('rejects requester who is not a member', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    await runInDurableObject(stub, async (instance: ConversationDO) => {
      expect(() =>
        instance.getAttachmentForRead({ requesterId: 'stranger', attachmentId: ulid() })
      ).toThrow(/member/i);
    });
  });
});
