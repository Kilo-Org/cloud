import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, publicEncrypt, randomBytes, createCipheriv, constants } from 'crypto';
import { buildEnvVars } from './env';
import { createMockEnv } from '../test-utils';
import { deriveGatewayToken } from '../auth/gateway-token';
import type { EncryptedEnvelope, EncryptedChannelTokens } from '../schemas/instance-config';

/**
 * Encrypt a string using the same RSA+AES envelope scheme as the shared lib.
 * Used to create test fixtures for decryption tests.
 */
function encryptForTest(value: string, publicKeyPem: string): EncryptedEnvelope {
  const dek = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  let encrypted = cipher.update(value, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedDataBuffer = Buffer.concat([iv, encrypted, authTag]);
  const encryptedDEKBuffer = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    dek
  );
  return {
    encryptedData: encryptedDataBuffer.toString('base64'),
    encryptedDEK: encryptedDEKBuffer.toString('base64'),
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  };
}

let testPublicKey: string;
let testPrivateKey: string;

// All tests use multi-tenant mode (sandboxId + secret required)
const SANDBOX_ID = 'test-sandbox-id';
const SECRET = 'test-gateway-secret';

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  testPublicKey = pair.publicKey;
  testPrivateKey = pair.privateKey;
});

describe('buildEnvVars', () => {
  // ─── Platform defaults (Layer 1) ─────────────────────────────────────

  it('always sets OPENCLAW_GATEWAY_TOKEN and AUTO_APPROVE_DEVICES', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    const expectedToken = await deriveGatewayToken(SANDBOX_ID, SECRET);
    expect(result.OPENCLAW_GATEWAY_TOKEN).toBe(expectedToken);
    expect(result.OPENCLAW_GATEWAY_TOKEN).toHaveLength(64);
    expect(result.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('includes ANTHROPIC_API_KEY when set directly', async () => {
    const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-test-key' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.ANTHROPIC_API_KEY).toBe('sk-test-key');
  });

  it('includes OPENAI_API_KEY when set directly', async () => {
    const env = createMockEnv({ OPENAI_API_KEY: 'sk-openai-key' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.OPENAI_API_KEY).toBe('sk-openai-key');
  });

  it('passes Cloudflare AI Gateway env vars', async () => {
    const env = createMockEnv({
      CLOUDFLARE_AI_GATEWAY_API_KEY: 'cf-gw-key',
      CF_AI_GATEWAY_ACCOUNT_ID: 'my-account-id',
      CF_AI_GATEWAY_GATEWAY_ID: 'my-gateway-id',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.CLOUDFLARE_AI_GATEWAY_API_KEY).toBe('cf-gw-key');
    expect(result.CF_AI_GATEWAY_ACCOUNT_ID).toBe('my-account-id');
    expect(result.CF_AI_GATEWAY_GATEWAY_ID).toBe('my-gateway-id');
  });

  it('maps legacy AI_GATEWAY_API_KEY to ANTHROPIC_API_KEY with base URL', async () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.ANTHROPIC_API_KEY).toBe('sk-gateway-key');
    expect(result.ANTHROPIC_BASE_URL).toBe(
      'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic'
    );
  });

  it('strips trailing slashes from legacy AI_GATEWAY_BASE_URL', async () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic///',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.AI_GATEWAY_BASE_URL).toBe(
      'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic'
    );
  });

  it('falls back to ANTHROPIC_BASE_URL when no AI_GATEWAY_BASE_URL', async () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'direct-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.ANTHROPIC_API_KEY).toBe('direct-key');
    expect(result.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('maps DEV_MODE to OPENCLAW_DEV_MODE for container', async () => {
    const env = createMockEnv({ DEV_MODE: 'true' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.OPENCLAW_DEV_MODE).toBe('true');
  });

  it('passes CF_AI_GATEWAY_MODEL to container', async () => {
    const env = createMockEnv({
      CF_AI_GATEWAY_MODEL: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.CF_AI_GATEWAY_MODEL).toBe('workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('does not pass worker-level channel tokens (user config only)', async () => {
    const env = createMockEnv({
      TELEGRAM_BOT_TOKEN: 'tg-token',
      DISCORD_BOT_TOKEN: 'discord-token',
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_APP_TOKEN).toBeUndefined();
  });

  // ─── User config merging (Layers 2-4) ────────────────────────────────

  it('merges user plaintext env vars on top of platform defaults', async () => {
    const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-platform' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { CUSTOM_VAR: 'custom-value', NODE_ENV: 'production' },
    });

    expect(result.ANTHROPIC_API_KEY).toBe('sk-platform');
    expect(result.CUSTOM_VAR).toBe('custom-value');
    expect(result.NODE_ENV).toBe('production');
  });

  it('user env vars can override platform AI keys (BYOK)', async () => {
    const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-platform' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { ANTHROPIC_API_KEY: 'sk-user-own-key' },
    });

    expect(result.ANTHROPIC_API_KEY).toBe('sk-user-own-key');
  });

  it('decrypts and merges encrypted secrets', async () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'sk-platform',
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      encryptedSecrets: {
        SECRET_API_KEY: encryptForTest('decrypted-secret', testPublicKey),
      },
    });

    expect(result.SECRET_API_KEY).toBe('decrypted-secret');
    expect(result.ANTHROPIC_API_KEY).toBe('sk-platform');
  });

  it('encrypted secrets override plaintext env vars on key conflict', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { MY_KEY: 'plaintext-value' },
      encryptedSecrets: {
        MY_KEY: encryptForTest('encrypted-value', testPublicKey),
      },
    });

    expect(result.MY_KEY).toBe('encrypted-value');
  });

  it('decrypts channel tokens and maps to container env vars', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const channels: EncryptedChannelTokens = {
      telegramBotToken: encryptForTest('tg-token-123', testPublicKey),
      discordBotToken: encryptForTest('discord-token-456', testPublicKey),
      slackBotToken: encryptForTest('slack-bot-789', testPublicKey),
      slackAppToken: encryptForTest('slack-app-012', testPublicKey),
    };
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, { channels });

    expect(result.TELEGRAM_BOT_TOKEN).toBe('tg-token-123');
    expect(result.DISCORD_BOT_TOKEN).toBe('discord-token-456');
    expect(result.SLACK_BOT_TOKEN).toBe('slack-bot-789');
    expect(result.SLACK_APP_TOKEN).toBe('slack-app-012');
  });

  // ─── Reserved system vars (Layer 5) ──────────────────────────────────

  it('reserved system vars cannot be overridden by user config', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const expectedToken = await deriveGatewayToken(SANDBOX_ID, SECRET);

    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: {
        OPENCLAW_GATEWAY_TOKEN: 'user-tried-to-override',
        AUTO_APPROVE_DEVICES: 'false',
      },
    });

    expect(result.OPENCLAW_GATEWAY_TOKEN).toBe(expectedToken);
    expect(result.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('skips channel decryption when no private key configured', async () => {
    const env = createMockEnv(); // no AGENT_ENV_VARS_PRIVATE_KEY
    const channels: EncryptedChannelTokens = {
      telegramBotToken: encryptForTest('tg-token', testPublicKey),
    };
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, { channels });

    expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('works with userConfig containing only channels (no envVars/secrets)', async () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'sk-platform',
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      channels: {
        telegramBotToken: encryptForTest('tg-only', testPublicKey),
      },
    });

    expect(result.ANTHROPIC_API_KEY).toBe('sk-platform');
    expect(result.TELEGRAM_BOT_TOKEN).toBe('tg-only');
    expect(result.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('handles empty userConfig gracefully', async () => {
    const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-key' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {});

    expect(result.ANTHROPIC_API_KEY).toBe('sk-key');
    expect(result.AUTO_APPROVE_DEVICES).toBe('true');
  });
});
