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
});

describe('kilo-chat actions adapter', () => {
  it('declares react in describeMessageTool', () => {
    const adapter = kiloChatPlugin.actions;
    expect(adapter).toBeDefined();
    const discovery = adapter!.describeMessageTool?.({ cfg: {} as never, accountId: null });
    expect(discovery?.actions).toContain('react');
  });

  it('supportsAction returns true for react and false for other actions', () => {
    const adapter = kiloChatPlugin.actions;
    expect(adapter?.supportsAction?.({ action: 'react' as never })).toBe(true);
    expect(adapter?.supportsAction?.({ action: 'send' as never })).toBe(false);
  });

  it('resolveExecutionMode returns "local"', () => {
    const adapter = kiloChatPlugin.actions;
    expect(adapter?.resolveExecutionMode?.({ action: 'react' as never })).toBe('local');
  });
});
