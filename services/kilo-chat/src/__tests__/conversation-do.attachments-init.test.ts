import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.initAttachment', () => {
  it('creates a pending row and returns attachmentId', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    const result = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 1024,
      filename: 'a.png',
    });
    expect(result.attachmentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.r2Key).toContain(`attachments/${conversationId}/user-A/`);
    expect(result.row.status).toBe('pending');
  });

  it('rejects size > 100 MB', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    await expect(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 101 * 1024 * 1024,
        filename: 'big.png',
      })
    ).rejects.toThrow(/size/i);
  });

  it('rejects non-member', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    await expect(
      stub.initAttachment({
        uploaderId: 'stranger',
        mimeType: 'image/png',
        size: 1,
        filename: 'a.png',
      })
    ).rejects.toThrow(/member/i);
  });

  it('returns same attachmentId for duplicate init within 30s', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await stub.bootstrapConversation({ creatorId: 'user-A', otherMembers: [] });
    const r1 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 7,
      filename: 'dup.png',
    });
    const r2 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 7,
      filename: 'dup.png',
    });
    expect(r2.attachmentId).toBe(r1.attachmentId);
  });
});
