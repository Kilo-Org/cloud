import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest } from './helpers';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.getAttachmentForRead', () => {
  it('returns null row when attachment does not exist', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const result = await stub.getAttachmentForRead({
      requesterId: 'user-A',
      attachmentId: ulid(),
    });
    expect(result).toEqual({ ok: true, row: null });
  });

  it('returns null row when attachment is still pending', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const init = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 1,
      filename: 'a.png',
    });
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    const result = await stub.getAttachmentForRead({
      requesterId: 'user-A',
      attachmentId: init.attachmentId,
    });
    expect(result).toEqual({ ok: true, row: null });
  });

  it('returns forbidden when requester is not a member', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const result = await stub.getAttachmentForRead({
      requesterId: 'stranger',
      attachmentId: ulid(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('forbidden');
  });
});
