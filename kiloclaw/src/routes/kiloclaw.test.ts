import { describe, expect, it } from 'vitest';
import { buildConfiguredSecrets } from './kiloclaw';

describe('buildConfiguredSecrets', () => {
  const envelope = {
    encryptedData: 'x',
    encryptedDEK: 'y',
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  };

  it('returns all entries as false when no secrets are configured', () => {
    const result = buildConfiguredSecrets({});
    expect(result).toEqual({
      telegram: false,
      discord: false,
      slack: false,
      github: false,
      linear: false,
      agentcard: false,
      onepassword: false,
      'brave-search': false,
    });
  });

  it('marks entry as configured when encryptedSecrets has the env var key', () => {
    const result = buildConfiguredSecrets({
      encryptedSecrets: { TELEGRAM_BOT_TOKEN: envelope },
    });
    expect(result.telegram).toBe(true);
    expect(result.discord).toBe(false);
    expect(result.slack).toBe(false);
  });

  it('marks multi-field entry as configured only when ALL fields are present', () => {
    const partial = buildConfiguredSecrets({
      encryptedSecrets: { SLACK_BOT_TOKEN: envelope },
    });
    expect(partial.slack).toBe(false);

    const full = buildConfiguredSecrets({
      encryptedSecrets: {
        SLACK_BOT_TOKEN: envelope,
        SLACK_APP_TOKEN: envelope,
      },
    });
    expect(full.slack).toBe(true);
  });

  it('falls back to legacy channels storage when encryptedSecrets is absent', () => {
    const result = buildConfiguredSecrets({
      channels: { telegramBotToken: envelope, discordBotToken: envelope },
    });
    expect(result.telegram).toBe(true);
    expect(result.discord).toBe(true);
    expect(result.slack).toBe(false);
  });

  it('prefers encryptedSecrets over legacy channels', () => {
    const result = buildConfiguredSecrets({
      encryptedSecrets: { TELEGRAM_BOT_TOKEN: envelope },
      channels: { telegramBotToken: envelope, discordBotToken: envelope },
    });
    expect(result.telegram).toBe(true);
    expect(result.discord).toBe(true);
  });

  it('handles legacy channels with all slack fields', () => {
    const result = buildConfiguredSecrets({
      channels: { slackBotToken: envelope, slackAppToken: envelope },
    });
    expect(result.slack).toBe(true);
  });

  it('marks github as configured only when all three fields are present', () => {
    const partial = buildConfiguredSecrets({
      encryptedSecrets: { GITHUB_TOKEN: envelope },
    });
    expect(partial.github).toBe(false);

    const twoOfThree = buildConfiguredSecrets({
      encryptedSecrets: { GITHUB_TOKEN: envelope, GITHUB_USERNAME: envelope },
    });
    expect(twoOfThree.github).toBe(false);

    const full = buildConfiguredSecrets({
      encryptedSecrets: {
        GITHUB_TOKEN: envelope,
        GITHUB_USERNAME: envelope,
        GITHUB_EMAIL: envelope,
      },
    });
    expect(full.github).toBe(true);
  });

  it('does not use legacy channels fallback for non-channel category entries', () => {
    // If a non-channel entry were added, legacy channels storage should not count
    // This tests that CHANNEL_FIELD_KEYS gate is effective — a key not in the
    // channel category won't match even if present in config.channels
    const result = buildConfiguredSecrets({
      channels: { someNonChannelKey: envelope },
    });
    // Channel entries should be false, tool entries unaffected by legacy channels
    expect(result.telegram).toBe(false);
    expect(result.discord).toBe(false);
    expect(result.slack).toBe(false);
    expect(result.github).toBe(false);
  });

  it('uses entry.id as the result key', () => {
    const result = buildConfiguredSecrets({});
    const keys = Object.keys(result);
    expect(keys).toContain('telegram');
    expect(keys).toContain('discord');
    expect(keys).toContain('slack');
    expect(keys).toContain('linear');
    expect(keys).toContain('onepassword');
    expect(keys).toContain('brave-search');
    expect(keys).toHaveLength(8);
  });

  it('treats null values as not configured', () => {
    const result = buildConfiguredSecrets({
      encryptedSecrets: {
        TELEGRAM_BOT_TOKEN: null as unknown as Record<string, unknown>,
      },
    });
    expect(result.telegram).toBe(false);
  });
});
