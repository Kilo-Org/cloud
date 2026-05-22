import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { __pluginInternals, kiloChatPlugin } from './channel';

const CONTROLLER_BASE = 'http://127.0.0.1:18789';

function createMessageResponse(messageId = 'm42') {
  return {
    messageId,
    message: {
      id: messageId,
      senderId: 'bot-1',
      content: [{ type: 'text' as const, text: 'hi' }],
      inReplyToMessageId: null,
      replyTo: null,
      updatedAt: null,
      clientUpdatedAt: null,
      deleted: false,
      deliveryFailed: false,
      reactions: [],
    },
  };
}

describe('kilo-chat plugin', () => {
  it('resolveAccount returns the provided accountId (null for single-account plugin)', () => {
    const cfg = { channels: { 'kilo-chat': { enabled: true } } } as never;
    expect(kiloChatPlugin.config.resolveAccount(cfg, undefined).accountId).toBeNull();
    expect(kiloChatPlugin.config.resolveAccount(cfg, 'abc').accountId).toBe('abc');
  });

  it('inspectAccount reports enabled when config has enabled=true', () => {
    const cfg = { channels: { 'kilo-chat': { enabled: true } } } as never;
    const result = kiloChatPlugin.config.inspectAccount!(cfg, undefined);
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(true);
  });

  it('inspectAccount reports not configured when disabled', () => {
    const cfg = { channels: { 'kilo-chat': { enabled: false } } } as never;
    const result = kiloChatPlugin.config.inspectAccount!(cfg, undefined);
    expect(result.configured).toBe(false);
  });
});

describe('kilo-chat outbound.sendText', () => {
  it('calls the controller send endpoint and returns messageId', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(createMessageResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;

    const originalEnv = { ...process.env };
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gwt';
    process.env.KILOCLAW_CONTROLLER_URL = 'http://127.0.0.1:18789';
    __pluginInternals.fetchImpl = fetchImpl;
    try {
      const result = await kiloChatPlugin.outbound!.sendText!({
        cfg: {} as never,
        to: 'conv-1',
        text: 'hi',
      } as never);
      expect(result.messageId).toBe('m42');
      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      __pluginInternals.fetchImpl = undefined;
      process.env = originalEnv;
    }
  });

  it('passes replyToId as inReplyToMessageId to createMessage', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(createMessageResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;

    const originalEnv = { ...process.env };
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gwt';
    process.env.KILOCLAW_CONTROLLER_URL = 'http://127.0.0.1:18789';
    __pluginInternals.fetchImpl = fetchImpl;
    try {
      await kiloChatPlugin.outbound!.sendText!({
        cfg: {} as never,
        to: 'conv-1',
        text: 'reply text',
        replyToId: 'parent-msg-1',
      } as never);

      const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.inReplyToMessageId).toBe('parent-msg-1');
    } finally {
      __pluginInternals.fetchImpl = undefined;
      process.env = originalEnv;
    }
  });
});

describe('kilo-chat messaging adapter', () => {
  const ULID = '01KP8R0VX4HK4ZSVQR5ZBVKHQH';
  const adapter = kiloChatPlugin.messaging!;

  it('normalizeTarget strips the kilo-chat: prefix', () => {
    expect(adapter.normalizeTarget!(`kilo-chat:${ULID}`)).toBe(ULID);
    expect(adapter.normalizeTarget!(ULID)).toBe(ULID);
    expect(adapter.normalizeTarget!(`  kilo-chat:${ULID}  `)).toBe(ULID);
  });

  it('parseExplicitTarget accepts ULID with or without prefix', () => {
    expect(adapter.parseExplicitTarget!({ raw: `kilo-chat:${ULID}` })).toEqual({
      to: ULID,
      chatType: 'direct',
    });
    expect(adapter.parseExplicitTarget!({ raw: ULID })).toEqual({
      to: ULID,
      chatType: 'direct',
    });
  });

  it('parseExplicitTarget rejects non-ULID input', () => {
    expect(adapter.parseExplicitTarget!({ raw: 'not-a-ulid' })).toBeNull();
    expect(adapter.parseExplicitTarget!({ raw: 'kilo-chat:garbage' })).toBeNull();
  });

  it('targetResolver.looksLikeId matches ULIDs with or without prefix', () => {
    expect(adapter.targetResolver!.looksLikeId!(ULID)).toBe(true);
    expect(adapter.targetResolver!.looksLikeId!(`kilo-chat:${ULID}`)).toBe(true);
    expect(adapter.targetResolver!.looksLikeId!('not-a-ulid')).toBe(false);
  });

  it('inferTargetChatType always returns direct', () => {
    expect(adapter.inferTargetChatType!({ to: ULID })).toBe('direct');
  });
});

describe('kilo-chat actions adapter', () => {
  it('describeMessageTool returns Kilo Chat actions with openclaw-standard names', () => {
    const adapter = kiloChatPlugin.actions;
    expect(adapter).toBeDefined();
    const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
    expect(discovery?.actions).toContain('send');
    expect(discovery?.actions).toContain('upload-file');
    expect(discovery?.actions).toContain('react');
    expect(discovery?.actions).toContain('read');
    expect(discovery?.actions).toContain('member-info');
    expect(discovery?.actions).toContain('edit');
    expect(discovery?.actions).toContain('delete');
    expect(discovery?.actions).toContain('renameGroup');
    expect(discovery?.actions).toContain('channel-list');
    expect(discovery?.actions).toContain('channel-create');
  });

  it('describeMessageTool advertises Kilo Chat action parameters', () => {
    const adapter = kiloChatPlugin.actions;
    const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
    expect(discovery?.schema).toBeDefined();
    const schema = Array.isArray(discovery?.schema) ? discovery.schema[0] : discovery?.schema;
    expect(schema?.properties).toEqual({
      conversationId: expect.objectContaining({
        type: 'string',
        description: expect.stringContaining('compatibility alias'),
      }),
    });
    expect(schema?.properties).not.toHaveProperty('target');
    expect(schema?.properties).not.toHaveProperty('message');
    expect(schema?.properties).not.toHaveProperty('messageId');
    expect(schema?.properties).not.toHaveProperty('emoji');
    expect(schema?.properties).not.toHaveProperty('remove');
    expect(schema?.properties).not.toHaveProperty('groupId');
    expect(schema?.properties).not.toHaveProperty('name');
    expect(schema?.properties).not.toHaveProperty('limit');
    expect(schema?.properties).not.toHaveProperty('before');
    expect(schema?.properties).not.toHaveProperty('memberId');
    expect(schema?.properties).not.toHaveProperty('userId');
    expect(schema?.properties).not.toHaveProperty('buffer');
    expect(schema?.properties).not.toHaveProperty('filename');
    expect(schema?.properties).not.toHaveProperty('contentType');
    expect(schema?.visibility).toBe('current-channel');
  });

  it('does not shadow OpenClaw core message-tool properties', () => {
    const adapter = kiloChatPlugin.actions;
    const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
    const schema = Array.isArray(discovery?.schema) ? discovery.schema[0] : discovery?.schema;

    // Core already owns these params. Re-declaring them from the plugin bundles
    // another TypeBox implementation and can make optional core params required
    // when OpenClaw builds the final message tool schema.
    expect(Object.keys(schema?.properties ?? {})).toEqual(['conversationId']);
  });

  it('keeps attachment send params documented in Kilo Chat hints without schema shadowing', () => {
    const adapter = kiloChatPlugin.actions;
    const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
    const schema = Array.isArray(discovery?.schema) ? discovery.schema[0] : discovery?.schema;
    const hints = kiloChatPlugin.agentPrompt?.messageToolHints?.({
      cfg: {} as never,
      accountId: null,
    });

    expect(schema?.properties).toHaveProperty('conversationId');
    expect(hints?.join('\n')).toContain('buffer');
    expect(hints?.join('\n')).toContain('filename');
    expect(hints?.join('\n')).toContain('contentType');
    expect(hints?.join('\n')).toContain('arbitrary local file types');
    expect(hints?.join('\n')).toContain('Do not use `upload-file` with a local `filePath`');
  });

  it('registers Kilo Chat conversation aliases for destination-bearing actions', () => {
    const aliases = kiloChatPlugin.actions?.messageActionTargetAliases;
    const expected = ['conversationId', 'groupId'];
    expect(aliases?.send?.aliases).toEqual(expected);
    expect(aliases?.['upload-file']?.aliases).toEqual(expected);
    expect(aliases?.read?.aliases).toEqual(expected);
    expect(aliases?.react?.aliases).toEqual(expected);
    expect(aliases?.edit?.aliases).toEqual(expected);
    expect(aliases?.delete?.aliases).toEqual(expected);
    expect(aliases?.renameGroup?.aliases).toEqual(expected);
  });

  it('adds concise Kilo Chat message tool hints', () => {
    const hints = kiloChatPlugin.agentPrompt?.messageToolHints?.({
      cfg: {} as never,
      accountId: null,
    });
    expect(hints).toContain(
      '- `member-info`: use `memberId` or `userId` to inspect one member; omit both to list members. Do not use `target` for the member id.'
    );
    expect(hints).toContain('- `renameGroup`: pass `conversationId` or `groupId` plus `name`.');
    expect(hints?.join('\n')).toContain('conversationId');
  });

  it('supportsAction returns true for standard actions and false for unsupported ones', () => {
    const adapter = kiloChatPlugin.actions;
    expect(adapter?.supportsAction?.({ action: 'send' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'upload-file' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'react' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'read' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'member-info' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'edit' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'delete' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'renameGroup' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'channel-list' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'channel-create' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'pin' as never })).toBe(false);
    // Old names should NOT be supported
    expect(adapter?.supportsAction?.({ action: 'rename' as never })).toBe(false);
    expect(adapter?.supportsAction?.({ action: 'conversations' as never })).toBe(false);
    expect(adapter?.supportsAction?.({ action: 'create-conversation' as never })).toBe(false);
  });

  it('resolveExecutionMode returns "local"', () => {
    const adapter = kiloChatPlugin.actions;
    expect(adapter?.resolveExecutionMode?.({ action: 'react' as never })).toBe('local');
  });

  it('routes send actions before constructing the shared action client', async () => {
    const source = await readFile(new URL('./channel.ts', import.meta.url), 'utf8');
    const handleActionIndex = source.indexOf(
      'handleAction: async (ctx: ChannelMessageActionContext)'
    );
    const sendBranchIndex = source.indexOf(
      "if (ctx.action === 'send' || ctx.action === 'upload-file')",
      handleActionIndex
    );
    const sharedClientIndex = source.indexOf('const client = makeClient();', handleActionIndex);

    expect(handleActionIndex).toBeGreaterThanOrEqual(0);
    expect(sendBranchIndex).toBeGreaterThan(handleActionIndex);
    expect(sharedClientIndex).toBeGreaterThan(sendBranchIndex);
  });

  it('handles send with a base64 buffer as an arbitrary attachment', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/_kilo/kilo-chat/attachments/init')) {
        return new Response(
          JSON.stringify({
            attachmentId: '01JX0000000000000000000099',
            putUrl: 'https://r2.example.com/upload?sig=xyz',
            putHeaders: { 'content-type': 'text/plain' },
            putUrlExpiresAt: 1_700_000_900,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://r2.example.com/upload?sig=xyz') {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/_kilo/kilo-chat/send')) {
        return new Response(JSON.stringify(createMessageResponse('m-buffer')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(`unexpected url ${url}`, { status: 599 });
    }) as unknown as typeof fetch;

    const originalEnv = { ...process.env };
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gwt';
    process.env.KILOCLAW_CONTROLLER_URL = CONTROLLER_BASE;
    __pluginInternals.fetchImpl = fetchImpl;
    try {
      const result = await kiloChatPlugin.actions!.handleAction!({
        channel: 'kilo-chat',
        action: 'send' as never,
        cfg: {} as never,
        params: {
          conversationId: 'conv-1',
          message: 'Here is a text file',
          buffer: Buffer.from('plain text attachment').toString('base64'),
          filename: 'random_text.txt',
          contentType: 'text/plain',
        },
      });

      expect(result.content[0].text).toContain('Sent message m-buffer');
      expect(calls[0].url).toBe(`${CONTROLLER_BASE}/_kilo/kilo-chat/attachments/init`);
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        conversationId: 'conv-1',
        mimeType: 'text/plain',
        size: 21,
        filename: 'random_text.txt',
      });
      expect(calls[1].url).toBe('https://r2.example.com/upload?sig=xyz');
      expect(calls[1].init.body).toBeInstanceOf(Buffer);
      expect((calls[1].init.body as Buffer).toString('utf8')).toBe('plain text attachment');
      expect(JSON.parse(String(calls[2].init.body)).content).toEqual([
        {
          type: 'attachment',
          attachmentId: '01JX0000000000000000000099',
          mimeType: 'text/plain',
          size: 21,
          filename: 'random_text.txt',
        },
        { type: 'text', text: 'Here is a text file' },
      ]);
    } finally {
      __pluginInternals.fetchImpl = undefined;
      process.env = originalEnv;
    }
  });

  it('handles upload-file with a base64 buffer as an arbitrary attachment', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/_kilo/kilo-chat/attachments/init')) {
        return new Response(
          JSON.stringify({
            attachmentId: '01JX0000000000000000000088',
            putUrl: 'https://r2.example.com/upload?sig=abc',
            putHeaders: { 'content-type': 'text/plain' },
            putUrlExpiresAt: 1_700_000_900,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://r2.example.com/upload?sig=abc') {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/_kilo/kilo-chat/send')) {
        return new Response(JSON.stringify(createMessageResponse('m-upload-file')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(`unexpected url ${url}`, { status: 599 });
    }) as unknown as typeof fetch;

    const originalEnv = { ...process.env };
    process.env.OPENCLAW_GATEWAY_TOKEN = 'gwt';
    process.env.KILOCLAW_CONTROLLER_URL = CONTROLLER_BASE;
    __pluginInternals.fetchImpl = fetchImpl;
    try {
      const result = await kiloChatPlugin.actions!.handleAction!({
        channel: 'kilo-chat',
        action: 'upload-file' as never,
        cfg: {} as never,
        params: {
          conversationId: 'conv-1',
          message: 'Here is a text file',
          buffer: Buffer.from('plain text upload').toString('base64'),
          filename: 'random.txt',
          contentType: 'text/plain',
        },
      });

      expect(result.content[0].text).toContain('Sent message m-upload-file');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        conversationId: 'conv-1',
        mimeType: 'text/plain',
        size: 17,
        filename: 'random.txt',
      });
      expect((calls[1].init.body as Buffer).toString('utf8')).toBe('plain text upload');
      expect(JSON.parse(String(calls[2].init.body)).content).toEqual([
        {
          type: 'attachment',
          attachmentId: '01JX0000000000000000000088',
          mimeType: 'text/plain',
          size: 17,
          filename: 'random.txt',
        },
        { type: 'text', text: 'Here is a text file' },
      ]);
    } finally {
      __pluginInternals.fetchImpl = undefined;
      process.env = originalEnv;
    }
  });
});
