import { describe, it, expect } from 'vitest';
import { ulid } from 'ulid';
import { __testables } from '../webhook/deliver';

const { buildPayload } = __testables;

describe('webhook buildPayload', () => {
  const baseMsg = {
    targetBotId: 'bot:kiloclaw:sb-1',
    conversationId: ulid(),
    messageId: ulid(),
    from: 'user-A',
    sentAt: new Date().toISOString(),
  };

  it('emits attachments array when message content has attachment blocks', () => {
    const aid = ulid();
    const payload = buildPayload({
      ...baseMsg,
      content: [
        { type: 'text', text: 'hi' },
        {
          type: 'attachment',
          attachmentId: aid,
          mimeType: 'image/png',
          size: 1,
          filename: 'a.png',
        },
      ],
    });
    expect(payload.text).toBe('hi');
    expect(payload.attachments).toEqual([
      { attachmentId: aid, mimeType: 'image/png', size: 1, filename: 'a.png' },
    ]);
  });

  it('omits attachments key when none in content', () => {
    const payload = buildPayload({
      ...baseMsg,
      content: [{ type: 'text', text: 'plain' }],
    });
    expect(payload.attachments).toBeUndefined();
  });

  it('keeps empty string text for attachment-only messages', () => {
    const aid = ulid();
    const payload = buildPayload({
      ...baseMsg,
      content: [
        {
          type: 'attachment',
          attachmentId: aid,
          mimeType: 'image/png',
          size: 1,
          filename: 'a.png',
        },
      ],
    });
    expect(payload.text).toBe('');
    expect(payload.attachments).toHaveLength(1);
  });
});
