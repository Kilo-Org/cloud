import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDeliverWiring,
  buildTypingParams,
  createKiloChatWebhookHandler,
  parseActionExecutedPayload,
  parseInboundPayload,
} from './webhook.js';
import type { KiloChatClient } from './client.js';

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

  it('parses reply context fields when present', () => {
    const parsed = parseInboundPayload({
      conversationId: 'c1',
      from: 'u1',
      text: 'my reply',
      messageId: 'm2',
      sentAt: '2026-01-01T00:00:00Z',
      inReplyToMessageId: 'm1',
      inReplyToBody: 'original text',
      inReplyToSender: 'u2',
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.inReplyToMessageId).toBe('m1');
    expect(parsed!.inReplyToBody).toBe('original text');
    expect(parsed!.inReplyToSender).toBe('u2');
  });

  it('parses successfully when reply context fields are absent', () => {
    const parsed = parseInboundPayload({
      conversationId: 'c1',
      from: 'u1',
      text: 'hi',
      messageId: 'm1',
      sentAt: '2026-01-01T00:00:00Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.inReplyToMessageId).toBeUndefined();
    expect(parsed!.inReplyToBody).toBeUndefined();
    expect(parsed!.inReplyToSender).toBeUndefined();
  });
});

describe('parseActionExecutedPayload', () => {
  it('parses a well-formed action.executed payload', () => {
    const parsed = parseActionExecutedPayload({
      type: 'action.executed',
      groupId: 'approval-123',
      value: 'allow-once',
      executedBy: 'user-1',
    });
    expect(parsed).toEqual({
      groupId: 'approval-123',
      value: 'allow-once',
      executedBy: 'user-1',
    });
  });

  it('rejects unknown approval decisions', () => {
    expect(
      parseActionExecutedPayload({
        type: 'action.executed',
        groupId: 'approval-123',
        value: 'maybe',
        executedBy: 'user-1',
      })
    ).toBeNull();
  });

  it('returns null when groupId is missing', () => {
    expect(parseActionExecutedPayload({ value: 'deny', executedBy: 'u1' })).toBeNull();
  });

  it('returns null when value is missing', () => {
    expect(parseActionExecutedPayload({ groupId: 'g1', executedBy: 'u1' })).toBeNull();
  });

  it('returns null when executedBy is missing', () => {
    expect(parseActionExecutedPayload({ groupId: 'g1', value: 'deny' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseActionExecutedPayload('not-an-object')).toBeNull();
    expect(parseActionExecutedPayload(null)).toBeNull();
  });
});

function makeReq(body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.url = '/plugins/kilo-chat/webhook';
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
  it('returns 400 on invalid JSON', async () => {
    const body = 'not-json';
    const handler = createKiloChatWebhookHandler({ api: {} as never });
    const { res, getStatus } = makeRes();
    await handler(makeReq(body), res);
    expect(getStatus()).toBe(400);
  });

  it('returns 400 on missing fields', async () => {
    const body = JSON.stringify({ conversationId: 'c1' });
    const handler = createKiloChatWebhookHandler({ api: {} as never });
    const { res, getStatus } = makeRes();
    await handler(makeReq(body), res);
    expect(getStatus()).toBe(400);
  });

  it('returns 413 when the inbound body exceeds the size cap', async () => {
    // 1 MB + 1 byte: well over the 1 MB cap. readBody must reject before parsing.
    const body = 'x'.repeat(1 * 1024 * 1024 + 1);
    const handler = createKiloChatWebhookHandler({ api: {} as never });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq(body), res);
    expect(getStatus()).toBe(413);
    expect(getBody()).toContain('Payload too large');
  });

  it('returns 400 on unknown webhook type', async () => {
    const body = JSON.stringify({ type: 'unknown.event', data: {} });
    const handler = createKiloChatWebhookHandler({ api: {} as never });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq(body), res);
    expect(getStatus()).toBe(400);
    expect(getBody()).toContain('Unknown webhook type');
  });

  it('returns 400 when action.executed payload is malformed', async () => {
    const body = JSON.stringify({ type: 'action.executed', groupId: 'g1' });
    const handler = createKiloChatWebhookHandler({ api: {} as never });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq(body), res);
    expect(getStatus()).toBe(400);
    expect(getBody()).toContain('Invalid action payload');
  });

  it('accepts message.created type explicitly', async () => {
    // message.created with missing required message fields should 400 with
    // "Invalid payload" (not "Unknown webhook type").
    const body = JSON.stringify({ type: 'message.created', conversationId: 'c1' });
    const handler = createKiloChatWebhookHandler({ api: {} as never });
    const { res, getStatus, getBody } = makeRes();
    await handler(makeReq(body), res);
    expect(getStatus()).toBe(400);
    expect(getBody()).toContain('Invalid payload');
  });
});

function fakeClient(calls: { type: string; args: unknown }[]): KiloChatClient {
  return {
    createMessage: async args => {
      calls.push({ type: 'create', args });
      return { messageId: 'm1' };
    },
    editMessage: async args => {
      calls.push({ type: 'edit', args });
      return {
        messageId: (args as { messageId: string }).messageId,
      };
    },
    deleteMessage: async args => {
      calls.push({ type: 'delete', args });
    },
    sendTyping: async args => {
      calls.push({ type: 'typing', args });
    },
    sendTypingStop: async args => {
      calls.push({ type: 'typingStop', args });
    },
    addReaction: async args => {
      calls.push({ type: 'addReaction', args });
      return { id: 'r1' };
    },
    removeReaction: async args => {
      calls.push({ type: 'removeReaction', args });
    },
    listMessages: async args => {
      calls.push({ type: 'listMessages', args });
      return { messages: [] };
    },
    getMembers: async args => {
      calls.push({ type: 'getMembers', args });
      return { members: [] };
    },
    renameConversation: async args => {
      calls.push({ type: 'renameConversation', args });
    },
    listConversations: async args => {
      calls.push({ type: 'listConversations', args });
      return { conversations: [], total: 0, limit: 50, offset: 0 };
    },
    createConversation: async args => {
      calls.push({ type: 'createConversation', args });
      return { conversationId: 'c1' };
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
      const editContent = (edits[0]!.args as { content: Array<{ type: string; text: string }> })
        .content;
      expect(editContent).toEqual([{ type: 'text', text: 'Hello!' }]);
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
    const allContent = createCalls.map(
      c => (c.args as { content: Array<{ type: string; text: string }> }).content
    );
    expect(allContent.some(blocks => blocks.some(b => b.text === 'second block'))).toBe(true);
  });

  it('passes inReplyToMessageId to preview stream on first create', async () => {
    vi.useFakeTimers();
    try {
      const calls: { type: string; args: unknown }[] = [];
      const wiring = buildDeliverWiring({
        client: fakeClient(calls),
        conversationId: 'c1',
        inReplyToMessageId: 'parent-msg-1',
        warn: () => {},
      });
      await wiring.replyOptions.onPartialReply({ text: 'H' });
      await vi.advanceTimersByTimeAsync(0);

      const creates = calls.filter(c => c.type === 'create');
      expect(creates).toHaveLength(1);
      expect((creates[0]!.args as { inReplyToMessageId?: string }).inReplyToMessageId).toBe(
        'parent-msg-1'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildTypingParams', () => {
  it('start() invokes client.sendTyping with conversationId', async () => {
    const calls: { type: string; args: unknown }[] = [];
    const typing = buildTypingParams({
      client: fakeClient(calls),
      conversationId: 'c1',
    });
    await typing.start();
    const typingCalls = calls.filter(c => c.type === 'typing');
    expect(typingCalls).toHaveLength(1);
    expect(typingCalls[0]!.args).toEqual({ conversationId: 'c1' });
  });

  it('onStartError is provided (SDK guard catches typing failures silently)', () => {
    const typing = buildTypingParams({
      client: fakeClient([]),
      conversationId: 'c1',
    });
    expect(typeof typing.onStartError).toBe('function');
    // Must not throw when called with an error.
    expect(() => typing.onStartError(new Error('boom'))).not.toThrow();
  });
});
