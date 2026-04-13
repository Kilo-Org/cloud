import { createHmac } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDeliverWiring,
  createKiloChatWebhookHandler,
  parseInboundPayload,
  verifyWebhookSignature,
} from './webhook.js';
import type { KiloChatClient } from './client.js';

const SECRET = 'whk';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature', () => {
    const body =
      '{"conversationId":"c1","from":"u","text":"hi","messageId":"m","sentAt":"2026-01-01T00:00:00Z"}';
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body =
      '{"conversationId":"c1","from":"u","text":"hi","messageId":"m","sentAt":"2026-01-01T00:00:00Z"}';
    const sig = sign(body);
    expect(verifyWebhookSignature(body + ' ', sig, SECRET)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature('{}', null, SECRET)).toBe(false);
  });

  it('rejects wrong-shape signature header', () => {
    expect(verifyWebhookSignature('{}', 'md5=abc', SECRET)).toBe(false);
  });
});

describe('parseInboundPayload', () => {
  it('parses a well-formed payload', () => {
    const parsed = parseInboundPayload({
      conversationId: 'c1',
      from: 'u1',
      text: 'hi',
      messageId: 'm1',
      sentAt: '2026-01-01T00:00:00Z',
    });
    expect(parsed).toEqual({
      conversationId: 'c1',
      from: 'u1',
      text: 'hi',
      messageId: 'm1',
      sentAt: '2026-01-01T00:00:00Z',
    });
  });

  it('returns null on missing required fields', () => {
    expect(parseInboundPayload({ conversationId: 'c1', text: 'hi' })).toBeNull();
  });

  it('returns null on non-object input', () => {
    expect(parseInboundPayload('not-an-object')).toBeNull();
  });
});

function makeReq(body: string, signature: string | null): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.url = '/plugins/kilo-chat/webhook';
  if (signature) req.headers['x-kilo-chat-signature'] = signature;
  req.headers['content-type'] = 'application/json';
  req.push(body);
  req.push(null);
  return req;
}

function makeRes(): { res: ServerResponse; getStatus(): number; getBody(): string } {
  let status = 0;
  let body = '';
  const res = {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    end(chunk?: string) {
      body = chunk ?? '';
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, 'statusCode', {
    get: () => status,
    set: (v: number) => {
      status = v;
    },
  });
  return { res, getStatus: () => status, getBody: () => body };
}

describe('createKiloChatWebhookHandler', () => {
  it('returns 503 when secret missing', async () => {
    const handler = createKiloChatWebhookHandler({
      api: {} as never,
      getWebhookSecret: () => undefined,
    });
    const { res, getStatus } = makeRes();
    await handler(makeReq('{}', 'sha256=x'), res);
    expect(getStatus()).toBe(503);
  });

  it('returns 401 on bad signature', async () => {
    const handler = createKiloChatWebhookHandler({
      api: {} as never,
      getWebhookSecret: () => SECRET,
    });
    const { res, getStatus } = makeRes();
    await handler(makeReq('{}', 'sha256=deadbeef'), res);
    expect(getStatus()).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const body = 'not-json';
    const handler = createKiloChatWebhookHandler({
      api: {} as never,
      getWebhookSecret: () => SECRET,
    });
    const { res, getStatus } = makeRes();
    await handler(makeReq(body, sign(body)), res);
    expect(getStatus()).toBe(400);
  });

  it('returns 400 on missing fields', async () => {
    const body = JSON.stringify({ conversationId: 'c1' });
    const handler = createKiloChatWebhookHandler({
      api: {} as never,
      getWebhookSecret: () => SECRET,
    });
    const { res, getStatus } = makeRes();
    await handler(makeReq(body, sign(body)), res);
    expect(getStatus()).toBe(400);
  });
});

function fakeClient(calls: { type: string; args: unknown }[]): KiloChatClient {
  return {
    createMessage: async args => {
      calls.push({ type: 'create', args });
      return { messageId: 'm1', version: 1 };
    },
    editMessage: async args => {
      calls.push({ type: 'edit', args });
      return {
        messageId: (args as { messageId: string }).messageId,
        version: (args as { version: number }).version,
      };
    },
    deleteMessage: async args => {
      calls.push({ type: 'delete', args });
    },
  };
}

describe('buildDeliverWiring', () => {
  it('partial replies stream, first deliver finalizes preview via PATCH', async () => {
    vi.useFakeTimers();
    try {
      const calls: { type: string; args: unknown }[] = [];
      const wiring = buildDeliverWiring({
        client: fakeClient(calls),
        conversationId: 'c1',
        warn: () => {},
      });
      expect(wiring.replyOptions.onPartialReply).toBeDefined();
      // First partial: fires an immediate POST. Drain microtasks so it resolves.
      await wiring.replyOptions.onPartialReply({ text: 'H' });
      await vi.advanceTimersByTimeAsync(0);
      // First deliver should now finalize the preview via PATCH (not POST).
      await wiring.deliver({ text: 'Hello!' });
      await wiring.finalize();

      const creates = calls.filter(c => c.type === 'create');
      const edits = calls.filter(c => c.type === 'edit');
      expect(creates).toHaveLength(1);
      expect(edits).toHaveLength(1);
      // The PATCH carries the final text.
      expect((edits[0]!.args as { text: string }).text).toBe('Hello!');
    } finally {
      vi.useRealTimers();
    }
  });

  it('error during dispatch aborts preview and deletes message', async () => {
    vi.useFakeTimers();
    try {
      const calls: { type: string; args: unknown }[] = [];
      const wiring = buildDeliverWiring({
        client: fakeClient(calls),
        conversationId: 'c1',
        warn: () => {},
      });
      await wiring.replyOptions.onPartialReply({ text: 'H' });
      await vi.advanceTimersByTimeAsync(0);
      await wiring.finalize(new Error('downstream error'));
      expect(calls.some(c => c.type === 'delete')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subsequent blocks after the first call createMessage directly', async () => {
    const calls: { type: string; args: unknown }[] = [];
    const wiring = buildDeliverWiring({
      client: fakeClient(calls),
      conversationId: 'c1',
      warn: () => {},
    });
    // First deliver finalizes the preview (or POSTs if never streamed).
    await wiring.deliver({ text: 'primary' });
    // Second deliver should create a separate message.
    await wiring.deliver({ text: 'second block' });
    await wiring.finalize();
    const createCalls = calls.filter(c => c.type === 'create');
    expect(createCalls.length).toBeGreaterThanOrEqual(2);
    const texts = createCalls.map(c => (c.args as { text: string }).text);
    expect(texts).toContain('second block');
  });
});
