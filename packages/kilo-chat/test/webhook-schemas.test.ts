import { describe, it, expect } from 'vitest';
import { messageCreatedWebhookSchema } from '../src/webhook-schemas';
import { ulid } from 'ulid';

const baseValid = {
  type: 'message.created' as const,
  conversationId: ulid(),
  messageId: ulid(),
  from: 'user-1',
  text: 'hello',
  sentAt: '2026-01-01T00:00:00.000Z',
};

describe('messageCreatedWebhookSchema (attachments)', () => {
  it('parses without attachments (back-compat)', () => {
    expect(messageCreatedWebhookSchema.parse(baseValid).attachments).toBeUndefined();
  });
  it('parses with attachments array', () => {
    const att = { attachmentId: ulid(), mimeType: 'image/png', size: 1, filename: 'a.png' };
    const parsed = messageCreatedWebhookSchema.parse({ ...baseValid, attachments: [att] });
    expect(parsed.attachments).toHaveLength(1);
  });
  it('accepts empty text when attachments are present', () => {
    const att = { attachmentId: ulid(), mimeType: 'image/png', size: 1, filename: 'a.png' };
    const r = messageCreatedWebhookSchema.safeParse({
      ...baseValid,
      text: '',
      attachments: [att],
    });
    expect(r.success).toBe(true);
  });
  it('rejects empty text with no attachments', () => {
    const r = messageCreatedWebhookSchema.safeParse({
      ...baseValid,
      text: '',
      attachments: undefined,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('text');
    }
  });
  it('rejects more than 10 attachments', () => {
    const att = { attachmentId: ulid(), mimeType: 'image/png', size: 1, filename: 'a.png' };
    const r = messageCreatedWebhookSchema.safeParse({
      ...baseValid,
      attachments: Array.from({ length: 11 }, () => att),
    });
    expect(r.success).toBe(false);
  });
  it('rejects attachment with empty filename', () => {
    const att = { attachmentId: ulid(), mimeType: 'image/png', size: 1, filename: '' };
    const r = messageCreatedWebhookSchema.safeParse({ ...baseValid, attachments: [att] });
    expect(r.success).toBe(false);
  });
  it('accepts attachment with zero size (empty file)', () => {
    const att = { attachmentId: ulid(), mimeType: 'image/png', size: 0, filename: 'a.png' };
    const r = messageCreatedWebhookSchema.safeParse({ ...baseValid, attachments: [att] });
    expect(r.success).toBe(true);
  });
});
