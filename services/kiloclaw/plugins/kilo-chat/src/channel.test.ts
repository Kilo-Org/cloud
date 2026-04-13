import { describe, expect, it, vi } from 'vitest';
import { __pluginInternals, kiloChatPlugin } from './channel';

describe('kilo-chat plugin', () => {
  it('resolves account from env-backed config', () => {
    const cfg = {
      channels: {
        'kilo-chat': {
          enabled: true,
          baseUrl: 'https://example.test',
        },
      },
    } as never;
    const account = kiloChatPlugin.config.resolveAccount(cfg, undefined);
    expect(account.accountId).toBeNull();
    expect(account.baseUrl).toBe('https://example.test');
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
