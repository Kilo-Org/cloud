import { describe, it, expect, vi, afterEach } from 'vitest';
import { KiloChatSSE } from '../src/sse';
import type { KiloChatConfig } from '../src/types';

function createMockStream(chunks: string[]) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(chunks[index++]);
          return { done: false, value };
        },
      };
    },
  };
}

function createMockConfig(fetchFn: typeof globalThis.fetch): KiloChatConfig {
  return {
    baseUrl: 'https://chat.example.com',
    getToken: vi.fn().mockResolvedValue('test-token'),
    fetch: fetchFn,
  };
}

describe('KiloChatSSE', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses message.created events and calls handler', async () => {
    const onMessageCreated = vi.fn();
    const sseData = JSON.stringify({
      messageId: 'm1',
      senderId: 'u1',
      content: [{ type: 'text', text: 'hello' }],
      version: 1,
      inReplyToMessageId: null,
    });
    const stream = createMockStream([`event: message.created\nid: m1\ndata: ${sseData}\n\n`]);
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', { onMessageCreated });
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();
    expect(onMessageCreated).toHaveBeenCalledWith({
      messageId: 'm1',
      senderId: 'u1',
      content: [{ type: 'text', text: 'hello' }],
      version: 1,
      inReplyToMessageId: null,
    });
  });

  it('parses message.updated events', async () => {
    const onMessageUpdated = vi.fn();
    const sseData = JSON.stringify({
      messageId: 'm1',
      content: [{ type: 'text', text: 'edited' }],
      version: 2,
    });
    const stream = createMockStream([`event: message.updated\nid: m1\ndata: ${sseData}\n\n`]);
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', { onMessageUpdated });
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();
    expect(onMessageUpdated).toHaveBeenCalledWith({
      messageId: 'm1',
      content: [{ type: 'text', text: 'edited' }],
      version: 2,
    });
  });

  it('parses message.deleted events', async () => {
    const onMessageDeleted = vi.fn();
    const sseData = JSON.stringify({ messageId: 'm1' });
    const stream = createMockStream([`event: message.deleted\nid: m1\ndata: ${sseData}\n\n`]);
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', { onMessageDeleted });
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();
    expect(onMessageDeleted).toHaveBeenCalledWith({ messageId: 'm1' });
  });

  it('parses typing events', async () => {
    const onTyping = vi.fn();
    const sseData = JSON.stringify({ memberId: 'bot:kiloclaw:sb1' });
    const stream = createMockStream([`event: typing\ndata: ${sseData}\n\n`]);
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', { onTyping });
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();
    expect(onTyping).toHaveBeenCalledWith({ memberId: 'bot:kiloclaw:sb1' });
  });

  it('sends Authorization header', async () => {
    const stream = createMockStream([]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', {});
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();
    expect(fetch).toHaveBeenCalledWith(
      'https://chat.example.com/v1/conversations/conv-1/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
  });

  it('calls getToken on each connect', async () => {
    const getToken = vi.fn().mockResolvedValue('token');
    const stream = createMockStream([]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const sse = new KiloChatSSE({ baseUrl: 'https://chat.example.com', getToken, fetch });
    sse.connect('conv-1', {});
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();
    expect(getToken).toHaveBeenCalled();
  });

  it('isConnected returns false after disconnect', async () => {
    const stream = createMockStream([]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', {});
    await new Promise(r => setTimeout(r, 50));
    expect(sse.isConnected()).toBe(true);
    sse.disconnect();
    expect(sse.isConnected()).toBe(false);
  });

  it('does not spawn a concurrent loop when connect is called during reconnect delay', async () => {
    // Simulate: stream ends naturally → loop enters delay(1000) →
    // connect() is called for a different conversation during the delay.
    // The old loop should exit, not continue fetching the old conversation.
    const stream1 = createMockStream([]); // ends immediately → triggers delay(1000)
    const stream2 = createMockStream([]); // for the new conversation
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: stream1 }) // old conv
      .mockResolvedValueOnce({ ok: true, body: stream2 }); // new conv

    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-old', {});

    // Wait long enough for the stream to be consumed and enter the delay
    await new Promise(r => setTimeout(r, 100));

    // Now switch conversation — this should abort the old loop's delay
    sse.connect('conv-new', {});

    // Wait for the new loop to make its fetch
    await new Promise(r => setTimeout(r, 100));
    sse.disconnect();

    // The second call should be for conv-new, never conv-old again
    const urls = fetch.mock.calls.map(([url]: [string]) => url);
    expect(urls[0]).toContain('conv-old');
    expect(urls[1]).toContain('conv-new');
    // No third call (the old loop should NOT have continued after delay)
    const oldConvCalls = urls.filter((u: string) => u.includes('conv-old'));
    expect(oldConvCalls).toHaveLength(1);
  });

  it('does not regress lastEventId when an edit event reuses an older message id', async () => {
    // Simulate: message.created id=M5, then message.updated id=M3 (edit of older msg).
    // On reconnect, Last-Event-ID should be M5, not M3.
    const created = JSON.stringify({
      messageId: 'M5',
      senderId: 'u1',
      content: [{ type: 'text', text: 'hello' }],
      version: 1,
      inReplyToMessageId: null,
    });
    const updated = JSON.stringify({
      messageId: 'M3',
      content: [{ type: 'text', text: 'edited' }],
      version: 2,
    });
    // First stream: delivers both events, then ends (reader returns done)
    const stream1 = createMockStream([
      `event: message.created\nid: M5\ndata: ${created}\n\n` +
        `event: message.updated\nid: M3\ndata: ${updated}\n\n`,
    ]);
    // Second stream: reconnect — we just need to capture the headers
    const stream2 = createMockStream([]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: stream1 })
      .mockResolvedValueOnce({ ok: true, body: stream2 });

    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', {
      onMessageCreated: vi.fn(),
      onMessageUpdated: vi.fn(),
    });

    // Wait for both streams to be consumed + reconnect attempt
    await new Promise(r => setTimeout(r, 2500));
    sse.disconnect();

    // The reconnect (second fetch call) should have Last-Event-ID = M5, not M3
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const reconnectHeaders = fetch.mock.calls[1][1].headers as Record<string, string>;
    expect(reconnectHeaders['Last-Event-ID']).toBe('M5');
  });

  it('clears lastEventId on disconnect', async () => {
    const sseData = JSON.stringify({ messageId: 'm1' });
    const stream1 = createMockStream([`event: message.deleted\nid: evt-99\ndata: ${sseData}\n\n`]);
    const stream2 = createMockStream([]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: stream1 })
      .mockResolvedValueOnce({ ok: true, body: stream2 });

    const sse = new KiloChatSSE(createMockConfig(fetch));

    // Connect to first conversation, receive event with id
    sse.connect('conv-1', { onMessageDeleted: vi.fn() });
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();

    // Connect to different conversation
    sse.connect('conv-2', {});
    await new Promise(r => setTimeout(r, 50));
    sse.disconnect();

    // Second connect should NOT send Last-Event-ID from first conversation
    const secondCall = fetch.mock.calls[1];
    expect(secondCall[1].headers).not.toHaveProperty('Last-Event-ID');
  });
});
