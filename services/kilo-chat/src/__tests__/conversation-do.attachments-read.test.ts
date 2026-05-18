import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.getAttachmentForRead', () => {
  it('returns null when row does not exist', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    expect(
      await stub.getAttachmentForRead({ requesterId: 'user-A', attachmentId: ulid() })
    ).toBeNull();
  });

  it('returns null when row is still pending', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    const { attachmentId } = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 1,
      filename: 'a.png',
    });
    expect(
      await stub.getAttachmentForRead({ requesterId: 'user-A', attachmentId })
    ).toBeNull();
  });

  it('rejects requester who is not a member', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    await expect(
      stub.getAttachmentForRead({ requesterId: 'stranger', attachmentId: ulid() })
    ).rejects.toThrow(/member/i);
  });
});
