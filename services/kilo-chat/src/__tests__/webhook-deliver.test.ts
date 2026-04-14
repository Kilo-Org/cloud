import { describe, it, expect, vi } from 'vitest';
import { buildWebhookPayload, signPayload, deliverWebhook } from '../webhook/deliver';

describe('buildWebhookPayload', () => {
  it('extracts text from content blocks', () => {
    const result = buildWebhookPayload({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      from: 'user-1',
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
      content: [{ type: 'image', url: 'http://example.com/img.png' }],
      sentAt: '2026-04-14T00:00:00Z',
    });
    expect(result.text).toBe('');
  });
});

describe('signPayload', () => {
  it('produces sha256= prefixed HMAC hex', () => {
    const sig = signPayload('{"test":true}', 'secret');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const a = signPayload('hello', 'key');
    const b = signPayload('hello', 'key');
    expect(a).toBe(b);
  });
});

describe('deliverWebhook', () => {
  it('POSTs signed payload to webhook URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await deliverWebhook(
      {
        conversationId: 'conv-1',
        messageId: 'msg-1',
        from: 'user-1',
        content: [{ type: 'text', text: 'Hi' }],
        sentAt: '2026-04-14T00:00:00Z',
      },
      'https://webhook.test/endpoint',
      'test-secret',
      mockFetch
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('https://webhook.test/endpoint');
    expect(init.method).toBe('POST');
    expect(init.headers['x-kilo-chat-signature']).toMatch(/^sha256=/);
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('throws on non-2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    await expect(
      deliverWebhook(
        {
          conversationId: 'conv-1',
          messageId: 'msg-1',
          from: 'user-1',
          content: [{ type: 'text', text: 'Hi' }],
          sentAt: '2026-04-14T00:00:00Z',
        },
        'https://webhook.test/endpoint',
        'test-secret',
        mockFetch
      )
    ).rejects.toThrow('Webhook delivery failed: 500');
  });
});
