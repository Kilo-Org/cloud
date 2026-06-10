import { describe, expect, it, vi } from 'vitest';
import { __pluginInternals, kiloChatPlugin } from './channel';

const ATTACHMENT_ULID = '01JX0000000000000000000099';
const PUT_URL = 'https://r2.example.com/upload?sig=xyz';
const CONTROLLER_BASE = 'http://127.0.0.1:18789';

type LoadedMedia = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

function withEnv(fn: () => Promise<void>): Promise<void> {
  const original = { ...process.env };
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gwt';
  process.env.KILOCLAW_CONTROLLER_URL = CONTROLLER_BASE;
  return (async () => {
    try {
      await fn();
    } finally {
      process.env = original;
    }
  })();
}

describe('kilo-chat outbound.sendMedia', () => {
  it('sends an inline MEDIA URL as text without uploading an attachment', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/_kilo/kilo-chat/send')) {
        return new Response(
          JSON.stringify({
            messageId: 'm-url-1',
            message: {
              id: 'm-url-1',
              senderId: 'bot-1',
              content: [{ type: 'text' as const, text: 'https://example.com/report.pdf' }],
              inReplyToMessageId: null,
              replyTo: null,
              updatedAt: null,
              clientUpdatedAt: null,
              deleted: false,
              deliveryFailed: false,
              reactions: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(`unexpected url ${url}`, { status: 599 });
    }) as unknown as typeof fetch;
    const loadMediaImpl = vi.fn(
      async (): Promise<LoadedMedia> => ({
        buffer: Buffer.from([1]),
        contentType: 'application/octet-stream',
        fileName: 'report.pdf',
      })
    );

    await withEnv(async () => {
      __pluginInternals.fetchImpl = fetchImpl;
      __pluginInternals.loadMediaImpl = loadMediaImpl;
      try {
        const result = await kiloChatPlugin.outbound!.sendMedia!({
          cfg: {} as never,
          to: 'conv-xyz',
          text: '',
          mediaUrl: 'https://example.com/report.pdf',
        } as never);

        expect(result.messageId).toBe('m-url-1');
        expect(loadMediaImpl).not.toHaveBeenCalled();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${CONTROLLER_BASE}/_kilo/kilo-chat/send`);
        const sendBody = JSON.parse(String(calls[0].init.body));
        expect(sendBody.content).toEqual([
          { type: 'text', text: 'https://example.com/report.pdf' },
        ]);
      } finally {
        __pluginInternals.fetchImpl = undefined;
        __pluginInternals.loadMediaImpl = undefined;
      }
    });
  });

  it('sends text plus an inline MEDIA URL as two text blocks without uploading an attachment', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/_kilo/kilo-chat/send')) {
        return new Response(
          JSON.stringify({
            messageId: 'm-url-2',
            message: {
              id: 'm-url-2',
              senderId: 'bot-1',
              content: [
                { type: 'text' as const, text: 'Here is the link' },
                { type: 'text' as const, text: 'https://example.com/report.pdf' },
              ],
              inReplyToMessageId: null,
              replyTo: null,
              updatedAt: null,
              clientUpdatedAt: null,
              deleted: false,
              deliveryFailed: false,
              reactions: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(`unexpected url ${url}`, { status: 599 });
    }) as unknown as typeof fetch;

    await withEnv(async () => {
      __pluginInternals.fetchImpl = fetchImpl;
      try {
        await kiloChatPlugin.outbound!.sendMedia!({
          cfg: {} as never,
          to: 'conv-xyz',
          text: 'Here is the link',
          mediaUrl: 'https://example.com/report.pdf',
          replyToId: 'parent-1',
        } as never);

        const sendBody = JSON.parse(String(calls[0].init.body));
        expect(sendBody.inReplyToMessageId).toBe('parent-1');
        expect(sendBody.content).toEqual([
          { type: 'text', text: 'Here is the link' },
          { type: 'text', text: 'https://example.com/report.pdf' },
        ]);
      } finally {
        __pluginInternals.fetchImpl = undefined;
      }
    });
  });

  it('loads media, initAttachment, PUTs to R2, then createMessage with attachment block', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/_kilo/kilo-chat/attachments/init')) {
        return new Response(
          JSON.stringify({
            attachmentId: ATTACHMENT_ULID,
            putUrl: PUT_URL,
            putHeaders: { 'content-type': 'image/png', 'content-length': '3' },
            putUrlExpiresAt: 1_700_000_900,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === PUT_URL) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/_kilo/kilo-chat/send')) {
        return new Response(
          JSON.stringify({
            messageId: 'm-att-1',
            message: {
              id: 'm-att-1',
              senderId: 'bot-1',
              content: [{ type: 'text' as const, text: 'caption text' }],
              inReplyToMessageId: null,
              replyTo: null,
              updatedAt: null,
              clientUpdatedAt: null,
              deleted: false,
              deliveryFailed: false,
              reactions: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(`unexpected url ${url}`, { status: 599 });
    }) as unknown as typeof fetch;

    // Inject a fake media loader so the test does not need network or fs.
    const loadMediaImpl = vi.fn(
      async (): Promise<LoadedMedia> => ({
        buffer: Buffer.from([0x89, 0x50, 0x4e]),
        contentType: 'image/png',
        fileName: 'photo.png',
      })
    );

    await withEnv(async () => {
      __pluginInternals.fetchImpl = fetchImpl;
      __pluginInternals.loadMediaImpl = loadMediaImpl;
      try {
        const result = await kiloChatPlugin.outbound!.sendMedia!({
          cfg: {} as never,
          to: 'conv-xyz',
          text: 'caption text',
          mediaUrl: './x.png',
        } as never);

        expect(result.messageId).toBe('m-att-1');

        // 1) initAttachment first
        expect(calls[0].url).toBe(`${CONTROLLER_BASE}/_kilo/kilo-chat/attachments/init`);
        expect(calls[0].init.method).toBe('POST');
        const initBody = JSON.parse(String(calls[0].init.body));
        expect(initBody).toEqual({
          conversationId: 'conv-xyz',
          mimeType: 'image/png',
          size: 3,
          filename: 'photo.png',
        });

        // 2) PUT to R2 with putHeaders
        expect(calls[1].url).toBe(PUT_URL);
        expect(calls[1].init.method).toBe('PUT');
        const putHeaders = calls[1].init.headers as Record<string, string>;
        expect(putHeaders['content-type']).toBe('image/png');
        expect(putHeaders['content-length']).toBe('3');
        // Body should be the buffer bytes
        expect(calls[1].init.body).toBeInstanceOf(Buffer);
        expect((calls[1].init.body as Buffer).length).toBe(3);

        // 3) createMessage with attachment block then text caption
        expect(calls[2].url).toBe(`${CONTROLLER_BASE}/_kilo/kilo-chat/send`);
        expect(calls[2].init.method).toBe('POST');
        const sendBody = JSON.parse(String(calls[2].init.body));
        expect(sendBody.conversationId).toBe('conv-xyz');
        expect(sendBody.content).toEqual([
          {
            type: 'attachment',
            attachmentId: ATTACHMENT_ULID,
            mimeType: 'image/png',
            size: 3,
            filename: 'photo.png',
          },
          { type: 'text', text: 'caption text' },
        ]);
      } finally {
        __pluginInternals.fetchImpl = undefined;
        __pluginInternals.loadMediaImpl = undefined;
      }
    });
  });

  it('omits the text content block when caption is empty', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/_kilo/kilo-chat/attachments/init')) {
        return new Response(
          JSON.stringify({
            attachmentId: ATTACHMENT_ULID,
            putUrl: PUT_URL,
            putHeaders: {},
            putUrlExpiresAt: 1_700_000_900,
          }),
          { status: 200 }
        );
      }
      if (url === PUT_URL) return new Response(null, { status: 200 });
      return new Response(
        JSON.stringify({
          messageId: 'm-att-2',
          message: {
            id: 'm-att-2',
            senderId: 'bot-1',
            content: [],
            inReplyToMessageId: null,
            replyTo: null,
            updatedAt: null,
            clientUpdatedAt: null,
            deleted: false,
            deliveryFailed: false,
            reactions: [],
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const loadMediaImpl = vi.fn(
      async (): Promise<LoadedMedia> => ({
        buffer: Buffer.from([1, 2]),
        contentType: 'image/jpeg',
        fileName: 'img.jpg',
      })
    );

    await withEnv(async () => {
      __pluginInternals.fetchImpl = fetchImpl;
      __pluginInternals.loadMediaImpl = loadMediaImpl;
      try {
        await kiloChatPlugin.outbound!.sendMedia!({
          cfg: {} as never,
          to: 'conv-xyz',
          text: '',
          mediaUrl: './x.jpg',
        } as never);

        const sendCall = calls.find(c => c.url.endsWith('/_kilo/kilo-chat/send'))!;
        const body = JSON.parse(String(sendCall.init.body));
        expect(body.content).toEqual([
          {
            type: 'attachment',
            attachmentId: ATTACHMENT_ULID,
            mimeType: 'image/jpeg',
            size: 2,
            filename: 'img.jpg',
          },
        ]);
      } finally {
        __pluginInternals.fetchImpl = undefined;
        __pluginInternals.loadMediaImpl = undefined;
      }
    });
  });

  it('throws when the R2 PUT returns non-2xx', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/_kilo/kilo-chat/attachments/init')) {
        return new Response(
          JSON.stringify({
            attachmentId: ATTACHMENT_ULID,
            putUrl: PUT_URL,
            putHeaders: {},
            putUrlExpiresAt: 1_700_000_900,
          }),
          { status: 200 }
        );
      }
      if (url === PUT_URL) return new Response('forbidden', { status: 403 });
      return new Response('unexpected', { status: 599 });
    }) as unknown as typeof fetch;

    const loadMediaImpl = vi.fn(
      async (): Promise<LoadedMedia> => ({
        buffer: Buffer.from([1]),
        contentType: 'image/png',
        fileName: 'a.png',
      })
    );

    await withEnv(async () => {
      __pluginInternals.fetchImpl = fetchImpl;
      __pluginInternals.loadMediaImpl = loadMediaImpl;
      try {
        await expect(
          kiloChatPlugin.outbound!.sendMedia!({
            cfg: {} as never,
            to: 'conv-xyz',
            text: '',
            mediaUrl: './x.png',
          } as never)
        ).rejects.toThrow(/403/);
      } finally {
        __pluginInternals.fetchImpl = undefined;
        __pluginInternals.loadMediaImpl = undefined;
      }
    });
  });

  it('passes replyToId through to createMessage as inReplyToMessageId', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/_kilo/kilo-chat/attachments/init')) {
        return new Response(
          JSON.stringify({
            attachmentId: ATTACHMENT_ULID,
            putUrl: PUT_URL,
            putHeaders: {},
            putUrlExpiresAt: 1_700_000_900,
          }),
          { status: 200 }
        );
      }
      if (url === PUT_URL) return new Response(null, { status: 200 });
      return new Response(
        JSON.stringify({
          messageId: 'm-reply',
          message: {
            id: 'm-reply',
            senderId: 'bot-1',
            content: [],
            inReplyToMessageId: 'parent-1',
            replyTo: null,
            updatedAt: null,
            clientUpdatedAt: null,
            deleted: false,
            deliveryFailed: false,
            reactions: [],
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const loadMediaImpl = vi.fn(
      async (): Promise<LoadedMedia> => ({
        buffer: Buffer.from([1]),
        contentType: 'image/png',
        fileName: 'a.png',
      })
    );

    await withEnv(async () => {
      __pluginInternals.fetchImpl = fetchImpl;
      __pluginInternals.loadMediaImpl = loadMediaImpl;
      try {
        await kiloChatPlugin.outbound!.sendMedia!({
          cfg: {} as never,
          to: 'conv-xyz',
          text: '',
          mediaUrl: './x.png',
          replyToId: 'parent-1',
        } as never);
        const sendCall = calls.find(c => c.url.endsWith('/_kilo/kilo-chat/send'))!;
        const body = JSON.parse(String(sendCall.init.body));
        expect(body.inReplyToMessageId).toBe('parent-1');
      } finally {
        __pluginInternals.fetchImpl = undefined;
        __pluginInternals.loadMediaImpl = undefined;
      }
    });
  });
});
