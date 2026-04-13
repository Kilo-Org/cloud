import { describe, expect, it } from 'vitest';
import { kiloChatPlugin } from './channel';

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
