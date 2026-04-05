import { describe, expect, it } from 'vitest';
import { collectProductTelemetry, detectChannels } from './product-telemetry';

const fullConfig = {
  agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-opus-4.6' } } },
  channels: {
    telegram: { enabled: true, botToken: 'tg-tok' },
    discord: { enabled: true, token: 'dc-tok' },
    slack: { enabled: true, botToken: 'sl-bot', appToken: 'sl-app' },
  },
  tools: { profile: 'full', exec: { security: 'allowlist' } },
  browser: { enabled: true },
};

describe('detectChannels', () => {
  it('returns all three channels when fully configured', () => {
    expect(detectChannels(fullConfig)).toEqual(['telegram', 'discord', 'slack']);
  });

  it('returns empty array for non-object config', () => {
    expect(detectChannels(null)).toEqual([]);
    expect(detectChannels('string')).toEqual([]);
    expect(detectChannels(42)).toEqual([]);
  });

  it('returns empty array when no channels configured', () => {
    expect(detectChannels({})).toEqual([]);
    expect(detectChannels({ channels: {} })).toEqual([]);
  });

  it('excludes disabled channels', () => {
    const config = {
      channels: {
        telegram: { enabled: false, botToken: 'tg-tok' },
        discord: { enabled: true, token: 'dc-tok' },
      },
    };
    expect(detectChannels(config)).toEqual(['discord']);
  });

  it('excludes channels without tokens', () => {
    const config = {
      channels: {
        telegram: { enabled: true },
        discord: { enabled: true, token: 'dc-tok' },
      },
    };
    expect(detectChannels(config)).toEqual(['discord']);
  });

  it('detects slack with only appToken', () => {
    const config = {
      channels: {
        slack: { enabled: true, appToken: 'sl-app' },
      },
    };
    expect(detectChannels(config)).toEqual(['slack']);
  });
});

describe('collectProductTelemetry', () => {
  it('returns all fields from a complete config', () => {
    const deps = { readConfigFile: () => JSON.stringify(fullConfig) };
    const result = collectProductTelemetry('2026.3.13', deps);

    expect(result).toEqual({
      openclawVersion: '2026.3.13',
      defaultModel: 'kilocode/anthropic/claude-opus-4.6',
      channelCount: 3,
      enabledChannels: ['telegram', 'discord', 'slack'],
      toolsProfile: 'full',
      execSecurity: 'allowlist',
      browserEnabled: true,
    });
  });

  it('returns safe defaults when config file is missing', () => {
    const deps = {
      readConfigFile: () => {
        throw new Error('ENOENT');
      },
    };
    const result = collectProductTelemetry('2026.3.13', deps);

    expect(result).toEqual({
      openclawVersion: '2026.3.13',
      defaultModel: null,
      channelCount: 0,
      enabledChannels: [],
      toolsProfile: null,
      execSecurity: null,
      browserEnabled: false,
    });
  });

  it('returns safe defaults when config file is malformed JSON', () => {
    const deps = { readConfigFile: () => 'not json' };
    const result = collectProductTelemetry(null, deps);

    expect(result).toEqual({
      openclawVersion: null,
      defaultModel: null,
      channelCount: 0,
      enabledChannels: [],
      toolsProfile: null,
      execSecurity: null,
      browserEnabled: false,
    });
  });

  it('returns safe defaults when config file is a non-object JSON value', () => {
    const deps = { readConfigFile: () => '"just a string"' };
    const result = collectProductTelemetry('2026.3.13', deps);

    expect(result.defaultModel).toBeNull();
    expect(result.channelCount).toBe(0);
  });

  it('handles partial config (missing nested keys)', () => {
    const partial = { tools: { profile: 'coding' } };
    const deps = { readConfigFile: () => JSON.stringify(partial) };
    const result = collectProductTelemetry('2026.3.13', deps);

    expect(result.toolsProfile).toBe('coding');
    expect(result.defaultModel).toBeNull();
    expect(result.execSecurity).toBeNull();
    expect(result.browserEnabled).toBe(false);
    expect(result.channelCount).toBe(0);
  });

  it('still extracts valid sections when a sibling section is malformed', () => {
    const config = {
      agents: 'not an object',
      tools: { profile: 'coding', exec: { security: 'allowlist' } },
      browser: { enabled: true },
      channels: {
        telegram: { enabled: true, botToken: 'tg-tok' },
      },
    };
    const deps = { readConfigFile: () => JSON.stringify(config) };
    const result = collectProductTelemetry('2026.3.13', deps);

    expect(result.defaultModel).toBeNull();
    expect(result.toolsProfile).toBe('coding');
    expect(result.execSecurity).toBe('allowlist');
    expect(result.browserEnabled).toBe(true);
    expect(result.enabledChannels).toEqual(['telegram']);
  });

  it('passes through openclawVersion even when null', () => {
    const deps = { readConfigFile: () => '{}' };
    const result = collectProductTelemetry(null, deps);
    expect(result.openclawVersion).toBeNull();
  });
});
