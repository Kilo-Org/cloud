import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest } from './helpers';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO.initAttachment', () => {
  it('creates a pending row and returns attachmentId', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const result = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 1024,
      filename: 'a.png',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachmentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.r2Key).toContain(`attachments/${conversationId}/user-A/`);
    expect(result.row.status).toBe('pending');
  });

  it('rejects size > 100 MB with invalid code', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const result = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 101 * 1024 * 1024,
      filename: 'big.png',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
    expect(result.error).toMatch(/size/i);
  });

  it('rejects non-member with forbidden code', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const result = await stub.initAttachment({
      uploaderId: 'stranger',
      mimeType: 'image/png',
      size: 1,
      filename: 'a.png',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('forbidden');
  });

  it('returns same attachmentId for duplicate init within 30s', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
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
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.attachmentId).toBe(r1.attachmentId);
  });

  it('returns distinct attachmentIds when mimeType differs', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const r1 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 7,
      filename: 'photo.bin',
    });
    const r2 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/jpeg',
      size: 7,
      filename: 'photo.bin',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.attachmentId).not.toBe(r1.attachmentId);
  });
});
