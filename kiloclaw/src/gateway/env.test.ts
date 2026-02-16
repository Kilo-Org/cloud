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

  it('maps DEV_MODE to OPENCLAW_DEV_MODE for container', async () => {
    const env = createMockEnv({ DEV_MODE: 'true' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.OPENCLAW_DEV_MODE).toBe('true');
  });

  it('passes KILOCODE_API_BASE_URL override to container', async () => {
    const env = createMockEnv({
      KILOCODE_API_BASE_URL: 'https://example.internal/openrouter/',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.KILOCODE_API_BASE_URL).toBe('https://example.internal/openrouter/');
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
    const env = createMockEnv({ DEV_MODE: 'true' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { CUSTOM_VAR: 'custom-value', NODE_ENV: 'production' },
    });

    expect(result.OPENCLAW_DEV_MODE).toBe('true');
    expect(result.CUSTOM_VAR).toBe('custom-value');
    expect(result.NODE_ENV).toBe('production');
  });

  it('passes KiloCode overrides from user config', async () => {
    const env = createMockEnv({ AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey });
    const models = [
      { id: 'anthropic/claude-opus-4.5', name: 'Anthropic: Claude Opus 4.5' },
      { id: 'minimax/minimax-m2.1:free', name: 'Minimax M2.1' },
    ];
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      kilocodeApiKey: 'kc-user-key',
      kilocodeDefaultModel: 'kilocode/anthropic/claude-opus-4.5',
      kilocodeModels: models,
    });

    expect(result.KILOCODE_API_KEY).toBe('kc-user-key');
    expect(result.KILOCODE_DEFAULT_MODEL).toBe('kilocode/anthropic/claude-opus-4.5');
    expect(result.KILOCODE_MODELS_JSON).toBe(JSON.stringify(models));
  });

  it('does not set KILOCODE_MODELS_JSON when kilocodeModels is null or absent', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      kilocodeApiKey: 'kc-key',
      kilocodeModels: null,
    });
    expect(result.KILOCODE_MODELS_JSON).toBeUndefined();

    const result2 = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      kilocodeApiKey: 'kc-key',
    });
    expect(result2.KILOCODE_MODELS_JSON).toBeUndefined();
  });

  it('decrypts and merges encrypted secrets', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      encryptedSecrets: {
        SECRET_API_KEY: encryptForTest('decrypted-secret', testPublicKey),
      },
    });

    expect(result.SECRET_API_KEY).toBe('decrypted-secret');
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

  // ─── Worker-level DM policy passthrough ─────────────────────────────

  it('passes TELEGRAM_DM_POLICY and DISCORD_DM_POLICY from worker env', async () => {
    const env = createMockEnv({
      TELEGRAM_DM_POLICY: 'open',
      DISCORD_DM_POLICY: 'pairing',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.TELEGRAM_DM_POLICY).toBe('open');
    expect(result.DISCORD_DM_POLICY).toBe('pairing');
  });

  it('does not set DM policy vars when not configured on worker', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.TELEGRAM_DM_POLICY).toBeUndefined();
    expect(result.DISCORD_DM_POLICY).toBeUndefined();
  });

  it('passes OPENCLAW_ALLOWED_ORIGINS from worker env', async () => {
    const env = createMockEnv({
      OPENCLAW_ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:8795',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.OPENCLAW_ALLOWED_ORIGINS).toBe('http://localhost:3000,http://localhost:8795');
  });

  it('does not set OPENCLAW_ALLOWED_ORIGINS when not configured', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.OPENCLAW_ALLOWED_ORIGINS).toBeUndefined();
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
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      channels: {
        telegramBotToken: encryptForTest('tg-only', testPublicKey),
      },
    });

    expect(result.TELEGRAM_BOT_TOKEN).toBe('tg-only');
    expect(result.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('handles empty userConfig gracefully', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {});

    expect(result.AUTO_APPROVE_DEVICES).toBe('true');
  });
});
