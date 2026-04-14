import { describe, it, expect } from 'vitest';
import { buildWebhookPayload } from '../webhook/deliver';

describe('buildWebhookPayload', () => {
  it('extracts text from content blocks', () => {
    const result = buildWebhookPayload({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      from: 'user-1',
      targetBotId: 'bot:kiloclaw:sandbox-1',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ],
      sentAt: '2026-04-14T00:00:00Z',
    });
    expect(result).toEqual({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      from: 'user-1',
      text: 'Hello world',
      sentAt: '2026-04-14T00:00:00Z',
    });
  });

  it('handles non-text blocks gracefully', () => {
    const result = buildWebhookPayload({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      from: 'user-1',
      targetBotId: 'bot:kiloclaw:sandbox-1',
      content: [{ type: 'image', url: 'http://example.com/img.png' }],
      sentAt: '2026-04-14T00:00:00Z',
    });
    expect(result.text).toBe('');
  });
});
