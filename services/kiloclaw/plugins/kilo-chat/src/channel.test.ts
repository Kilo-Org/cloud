import { describe, expect, it, vi } from 'vitest';
import { __pluginInternals, kiloChatPlugin } from './channel';

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
        new Response(JSON.stringify({ messageId: 'm42' }), {
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
        new Response(JSON.stringify({ messageId: 'm42' }), {
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

  it('describeMessageTool returns schema contribution for additionalMembers', () => {
    const adapter = kiloChatPlugin.actions;
    const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
    expect(discovery?.schema).toBeDefined();
    const schema = Array.isArray(discovery?.schema) ? discovery.schema[0] : discovery?.schema;
    expect(schema?.properties).toHaveProperty('additionalMembers');
    expect(schema?.properties).toHaveProperty('groupId');
    expect(schema?.properties).toHaveProperty('target');
    expect(schema?.visibility).toBe('current-channel');
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
