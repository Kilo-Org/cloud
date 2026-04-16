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
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 50));
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
    await new Promise((r) => setTimeout(r, 50));
    sse.disconnect();
    expect(onTyping).toHaveBeenCalledWith({ memberId: 'bot:kiloclaw:sb1' });
  });

  it('sends Authorization header', async () => {
    const stream = createMockStream([]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', {});
    await new Promise((r) => setTimeout(r, 50));
    sse.disconnect();
    expect(fetch).toHaveBeenCalledWith(
      'https://chat.example.com/v1/conversations/conv-1/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('calls getToken on each connect', async () => {
    const getToken = vi.fn().mockResolvedValue('token');
    const stream = createMockStream([]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const sse = new KiloChatSSE({ baseUrl: 'https://chat.example.com', getToken, fetch });
    sse.connect('conv-1', {});
    await new Promise((r) => setTimeout(r, 50));
    sse.disconnect();
    expect(getToken).toHaveBeenCalled();
  });

  it('isConnected returns false after disconnect', async () => {
    const stream = createMockStream([]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, body: stream });
    const sse = new KiloChatSSE(createMockConfig(fetch));
    sse.connect('conv-1', {});
    await new Promise((r) => setTimeout(r, 50));
    expect(sse.isConnected()).toBe(true);
    sse.disconnect();
    expect(sse.isConnected()).toBe(false);
  });
});
