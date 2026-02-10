import { describe, it, expect } from 'vitest';
import { buildEnvVars } from './env';
import { createMockEnv } from '../test-utils';
import { deriveGatewayToken } from '../auth/gateway-token';

describe('buildEnvVars', () => {
  // ─── Shared sandbox mode (no sandboxId) ─────────────────────────────

  it('returns empty object when no env vars set', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env);
    expect(result).toEqual({});
  });

  it('includes ANTHROPIC_API_KEY when set directly', async () => {
    const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-test-key' });
    const result = await buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('sk-test-key');
  });

  it('includes OPENAI_API_KEY when set directly', async () => {
    const env = createMockEnv({ OPENAI_API_KEY: 'sk-openai-key' });
    const result = await buildEnvVars(env);
    expect(result.OPENAI_API_KEY).toBe('sk-openai-key');
  });

  // Cloudflare AI Gateway (new native provider)
  it('passes Cloudflare AI Gateway env vars', async () => {
    const env = createMockEnv({
      CLOUDFLARE_AI_GATEWAY_API_KEY: 'cf-gw-key',
      CF_AI_GATEWAY_ACCOUNT_ID: 'my-account-id',
      CF_AI_GATEWAY_GATEWAY_ID: 'my-gateway-id',
    });
    const result = await buildEnvVars(env);
    expect(result.CLOUDFLARE_AI_GATEWAY_API_KEY).toBe('cf-gw-key');
    expect(result.CF_AI_GATEWAY_ACCOUNT_ID).toBe('my-account-id');
    expect(result.CF_AI_GATEWAY_GATEWAY_ID).toBe('my-gateway-id');
  });

  it('passes Cloudflare AI Gateway alongside direct Anthropic key', async () => {
    const env = createMockEnv({
      CLOUDFLARE_AI_GATEWAY_API_KEY: 'cf-gw-key',
      CF_AI_GATEWAY_ACCOUNT_ID: 'my-account-id',
      CF_AI_GATEWAY_GATEWAY_ID: 'my-gateway-id',
      ANTHROPIC_API_KEY: 'sk-anthro',
    });
    const result = await buildEnvVars(env);
    expect(result.CLOUDFLARE_AI_GATEWAY_API_KEY).toBe('cf-gw-key');
    expect(result.ANTHROPIC_API_KEY).toBe('sk-anthro');
  });

  // Legacy AI Gateway support
  it('maps legacy AI_GATEWAY_API_KEY to ANTHROPIC_API_KEY with base URL', async () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic',
    });
    const result = await buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('sk-gateway-key');
    expect(result.ANTHROPIC_BASE_URL).toBe(
      'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic'
    );
    expect(result.AI_GATEWAY_BASE_URL).toBe(
      'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic'
    );
  });

  it('legacy AI_GATEWAY_* overrides direct ANTHROPIC_API_KEY', async () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.example.com/anthropic',
      ANTHROPIC_API_KEY: 'direct-key',
    });
    const result = await buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('gateway-key');
    expect(result.AI_GATEWAY_BASE_URL).toBe('https://gateway.example.com/anthropic');
  });

  it('strips trailing slashes from legacy AI_GATEWAY_BASE_URL', async () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic///',
    });
    const result = await buildEnvVars(env);
    expect(result.AI_GATEWAY_BASE_URL).toBe(
      'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic'
    );
  });

  it('falls back to ANTHROPIC_BASE_URL when no AI_GATEWAY_BASE_URL', async () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'direct-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    const result = await buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('direct-key');
    expect(result.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  // Channel tokens (shared sandbox mode)
  it('includes all channel tokens in shared sandbox mode', async () => {
    const env = createMockEnv({
      TELEGRAM_BOT_TOKEN: 'tg-token',
      TELEGRAM_DM_POLICY: 'pairing',
      DISCORD_BOT_TOKEN: 'discord-token',
      DISCORD_DM_POLICY: 'open',
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
    });
    const result = await buildEnvVars(env);

    expect(result.TELEGRAM_BOT_TOKEN).toBe('tg-token');
    expect(result.TELEGRAM_DM_POLICY).toBe('pairing');
    expect(result.DISCORD_BOT_TOKEN).toBe('discord-token');
    expect(result.DISCORD_DM_POLICY).toBe('open');
    expect(result.SLACK_BOT_TOKEN).toBe('slack-bot');
    expect(result.SLACK_APP_TOKEN).toBe('slack-app');
  });

  it('maps DEV_MODE to OPENCLAW_DEV_MODE for container', async () => {
    const env = createMockEnv({
      DEV_MODE: 'true',
    });
    const result = await buildEnvVars(env);
    expect(result.OPENCLAW_DEV_MODE).toBe('true');
  });

  // AI Gateway model override
  it('passes CF_AI_GATEWAY_MODEL to container', async () => {
    const env = createMockEnv({
      CF_AI_GATEWAY_MODEL: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    });
    const result = await buildEnvVars(env);
    expect(result.CF_AI_GATEWAY_MODEL).toBe('workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('passes CF_ACCOUNT_ID to container', async () => {
    const env = createMockEnv({ CF_ACCOUNT_ID: 'acct-123' });
    const result = await buildEnvVars(env);
    expect(result.CF_ACCOUNT_ID).toBe('acct-123');
  });

  it('combines all env vars correctly in shared mode', async () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'sk-key',
      TELEGRAM_BOT_TOKEN: 'tg',
    });
    const result = await buildEnvVars(env);

    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'sk-key',
      TELEGRAM_BOT_TOKEN: 'tg',
    });
  });

  // ─── Multi-tenant mode (with sandboxId) ─────────────────────────────

  it('derives OPENCLAW_GATEWAY_TOKEN when sandboxId + secret provided', async () => {
    const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-key' });
    const sandboxId = 'dGVzdC11c2Vy';
    const secret = 'test-gateway-secret';

    const result = await buildEnvVars(env, sandboxId, secret);

    // Deterministic: same inputs always produce the same HMAC
    const expectedToken = await deriveGatewayToken(sandboxId, secret);
    expect(result.OPENCLAW_GATEWAY_TOKEN).toBe(expectedToken);
    expect(result.OPENCLAW_GATEWAY_TOKEN).toHaveLength(64); // SHA-256 hex
  });

  it('sets AUTO_APPROVE_DEVICES in multi-tenant mode', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, 'some-sandbox-id', 'some-secret');
    expect(result.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('skips worker-level channel tokens in multi-tenant mode', async () => {
    const env = createMockEnv({
      TELEGRAM_BOT_TOKEN: 'tg-token',
      DISCORD_BOT_TOKEN: 'discord-token',
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
    });
    const result = await buildEnvVars(env, 'sandbox-id', 'secret');

    expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_APP_TOKEN).toBeUndefined();
  });

  it('still passes shared AI keys in multi-tenant mode', async () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'sk-shared',
      CF_AI_GATEWAY_MODEL: 'anthropic/claude-sonnet-4-5',
    });
    const result = await buildEnvVars(env, 'sandbox-id', 'secret');

    expect(result.ANTHROPIC_API_KEY).toBe('sk-shared');
    expect(result.CF_AI_GATEWAY_MODEL).toBe('anthropic/claude-sonnet-4-5');
  });

  it('falls back to shared-sandbox mode without gatewayTokenSecret', async () => {
    const env = createMockEnv({ TELEGRAM_BOT_TOKEN: 'tg-token' });
    const result = await buildEnvVars(env, 'sandbox-id');

    // No gateway token or auto-approve without the secret
    expect(result.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(result.AUTO_APPROVE_DEVICES).toBeUndefined();
    // Channel tokens still passed through (shared-sandbox behavior)
    expect(result.TELEGRAM_BOT_TOKEN).toBe('tg-token');
  });
});
