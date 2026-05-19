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
    const stored = await stub.getAttachmentForRead({
      requesterId: 'user-A',
      attachmentId: result.attachmentId,
    });
    expect(stored.ok).toBe(true);
    // The row remains pending until createMessage links it, so the read
    // helper (which only returns linked rows) reports null.
    if (stored.ok) expect(stored.row).toBeNull();
  });

  it('accepts size 0 (empty file)', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const result = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'application/octet-stream',
      size: 0,
      filename: 'empty.bin',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachmentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('rejects non-integer size with invalid code', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const result = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 1.5,
      filename: 'a.png',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
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

  it('returns same attachmentId for duplicate init with matching idempotencyKey', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const r1 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 7,
      filename: 'dup.png',
      idempotencyKey: 'retry-key-1',
    });
    const r2 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 7,
      filename: 'dup.png',
      idempotencyKey: 'retry-key-1',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.attachmentId).toBe(r1.attachmentId);
  });

  it('returns distinct attachmentIds when same metadata is uploaded without idempotencyKey', async () => {
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
    expect(r2.attachmentId).not.toBe(r1.attachmentId);
  });

  it('returns distinct attachmentIds for the same uploader with different idempotencyKeys', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });
    const r1 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 7,
      filename: 'photo.bin',
      idempotencyKey: 'key-a',
    });
    const r2 = await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 7,
      filename: 'photo.bin',
      idempotencyKey: 'key-b',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.attachmentId).not.toBe(r1.attachmentId);
  });
});
