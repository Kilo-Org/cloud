import { createHmac } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createKiloChatWebhookHandler, parseInboundPayload, verifyWebhookSignature } from './webhook.js';

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
