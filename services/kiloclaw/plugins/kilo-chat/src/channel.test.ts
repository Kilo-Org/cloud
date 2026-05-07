import { describe, expect, it, vi } from 'vitest';
import { __pluginInternals, kiloChatPlugin } from './channel';

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
  it('describeMessageTool returns all eight actions with openclaw-standard names', () => {
    const adapter = kiloChatPlugin.actions;
    expect(adapter).toBeDefined();
    const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
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
    expect(schema?.properties).not.toHaveProperty('additionalMembers');
    expect(schema?.properties).not.toHaveProperty('target');
    expect(schema?.properties).toHaveProperty('conversationId');
    expect(schema?.properties).toHaveProperty('groupId');
    expect(schema?.properties).toHaveProperty('messageId');
    expect(schema?.properties).toHaveProperty('message');
    expect(schema?.properties).toHaveProperty('emoji');
    expect(schema?.properties).toHaveProperty('remove');
    expect(schema?.properties).toHaveProperty('name');
    expect(schema?.properties).toHaveProperty('limit');
    expect(schema?.properties).toHaveProperty('before');
    expect(schema?.properties).toHaveProperty('memberId');
    expect(schema?.properties).toHaveProperty('userId');
    expect(schema?.properties?.memberId.description).toContain('member-info');
    expect(schema?.properties?.userId.description).toContain('memberId');
    expect(schema?.properties?.conversationId.description).toContain('compatibility alias');
    expect(schema?.visibility).toBe('current-channel');
  });

  it('registers Kilo Chat conversation aliases for destination-bearing actions', () => {
    const aliases = kiloChatPlugin.actions?.messageActionTargetAliases;
    const expected = ['conversationId', 'groupId'];
    expect(aliases?.send?.aliases).toEqual(expected);
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
});
