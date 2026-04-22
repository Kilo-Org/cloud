import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPairSync, publicEncrypt, randomBytes, createCipheriv, constants } from 'crypto';
import { buildEnvVars, FEATURE_TO_ENV_VAR } from './env';
import { DEFAULT_INSTANCE_FEATURES } from '../schemas/instance-config';
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

  it('puts OPENCLAW_GATEWAY_TOKEN in sensitive and AUTO_APPROVE_DEVICES in env', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    const expectedToken = await deriveGatewayToken(SANDBOX_ID, SECRET);
    expect(result.sensitive.OPENCLAW_GATEWAY_TOKEN).toBe(expectedToken);
    expect(result.sensitive.OPENCLAW_GATEWAY_TOKEN).toHaveLength(64);
    expect(result.env.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('omits KILO_EXA_SEARCH_MODE when user has not selected a mode', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.env.KILO_EXA_SEARCH_MODE).toBeUndefined();
  });

  it('sets KILO_EXA_SEARCH_MODE from user config', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      kiloExaSearchMode: 'kilo-proxy',
    });

    expect(result.env.KILO_EXA_SEARCH_MODE).toBe('kilo-proxy');
  });

  it('passes KILOCODE_API_BASE_URL override in env bucket', async () => {
    const env = createMockEnv({
      KILOCODE_API_BASE_URL: 'https://example.internal/openrouter/',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.env.KILOCODE_API_BASE_URL).toBe('https://example.internal/openrouter/');
  });

  it('does not pass worker-level channel tokens (user config only)', async () => {
    const env = createMockEnv({
      TELEGRAM_BOT_TOKEN: 'tg-token',
      DISCORD_BOT_TOKEN: 'discord-token',
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.sensitive.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.sensitive.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.sensitive.SLACK_BOT_TOKEN).toBeUndefined();
    expect(result.sensitive.SLACK_APP_TOKEN).toBeUndefined();
  });

  // ─── User config merging (Layers 2-4) ────────────────────────────────

  it('merges user plaintext env vars on top of platform defaults', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { CUSTOM_VAR: 'custom-value', NODE_ENV: 'production' },
    });

    expect(result.env.CUSTOM_VAR).toBe('custom-value');
    expect(result.env.NODE_ENV).toBe('production');
  });

  it('puts KILOCODE_API_KEY in sensitive, default model in env', async () => {
    const env = createMockEnv({ AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      kilocodeApiKey: 'kc-user-key',
      kilocodeDefaultModel: 'kilocode/anthropic/claude-opus-4.6',
    });

    expect(result.sensitive.KILOCODE_API_KEY).toBe('kc-user-key');
    expect(result.env.KILOCODE_DEFAULT_MODEL).toBe('kilocode/anthropic/claude-opus-4.6');
    // Model catalog is handled natively by OpenClaw's kilocode provider
    expect(result.env.KILOCODE_MODELS_JSON).toBeUndefined();
  });

  it('does not set KILOCODE_DEFAULT_MODEL when absent', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      kilocodeApiKey: 'kc-key',
    });
    expect(result.env.KILOCODE_DEFAULT_MODEL).toBeUndefined();
  });

  it('passes user timezone in env bucket', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      userTimezone: 'Europe/Amsterdam',
    });

    expect(result.env.KILOCLAW_USER_TIMEZONE).toBe('Europe/Amsterdam');
    expect(result.sensitive.KILOCLAW_USER_TIMEZONE).toBeUndefined();
  });

  it('does not set KILOCLAW_USER_TIMEZONE when absent', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {});

    expect(result.env.KILOCLAW_USER_TIMEZONE).toBeUndefined();
  });

  it('passes user location in sensitive bucket', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      userLocation: 'Amsterdam, North Holland, Netherlands',
    });

    expect(result.sensitive.KILOCLAW_USER_LOCATION).toBe('Amsterdam, North Holland, Netherlands');
    expect(result.env.KILOCLAW_USER_LOCATION).toBeUndefined();
  });

  it('does not set KILOCLAW_USER_LOCATION when absent', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {});

    expect(result.sensitive.KILOCLAW_USER_LOCATION).toBeUndefined();
    expect(result.env.KILOCLAW_USER_LOCATION).toBeUndefined();
  });

  it('puts decrypted secrets in sensitive bucket', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      encryptedSecrets: {
        SECRET_API_KEY: encryptForTest('decrypted-secret', testPublicKey),
      },
    });

    expect(result.sensitive.SECRET_API_KEY).toBe('decrypted-secret');
    expect(result.env.SECRET_API_KEY).toBeUndefined();
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

    // Encrypted secrets win and go to sensitive bucket
    expect(result.sensitive.MY_KEY).toBe('encrypted-value');
    expect(result.env.MY_KEY).toBeUndefined();
  });

  it('puts decrypted channel tokens in sensitive bucket', async () => {
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

    expect(result.sensitive.TELEGRAM_BOT_TOKEN).toBe('tg-token-123');
    expect(result.sensitive.DISCORD_BOT_TOKEN).toBe('discord-token-456');
    expect(result.sensitive.SLACK_BOT_TOKEN).toBe('slack-bot-789');
    expect(result.sensitive.SLACK_APP_TOKEN).toBe('slack-app-012');
  });

  // ─── Worker-level DM policy passthrough ─────────────────────────────

  it('passes TELEGRAM_DM_POLICY and DISCORD_DM_POLICY in env bucket', async () => {
    const env = createMockEnv({
      TELEGRAM_DM_POLICY: 'open',
      DISCORD_DM_POLICY: 'pairing',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.env.TELEGRAM_DM_POLICY).toBe('open');
    expect(result.env.DISCORD_DM_POLICY).toBe('pairing');
  });

  it('does not set DM policy vars when not configured on worker', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.env.TELEGRAM_DM_POLICY).toBeUndefined();
    expect(result.env.DISCORD_DM_POLICY).toBeUndefined();
  });

  it('passes OPENCLAW_ALLOWED_ORIGINS in env bucket', async () => {
    const env = createMockEnv({
      OPENCLAW_ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:8795',
    });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.env.OPENCLAW_ALLOWED_ORIGINS).toBe('http://localhost:3000,http://localhost:8795');
  });

  it('does not set OPENCLAW_ALLOWED_ORIGINS when not configured', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);

    expect(result.env.OPENCLAW_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('passes REQUIRE_PROXY_TOKEN from worker env when configured', async () => {
    const env = createMockEnv({ REQUIRE_PROXY_TOKEN: 'true' });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.env.REQUIRE_PROXY_TOKEN).toBe('true');
  });

  it('defaults REQUIRE_PROXY_TOKEN to false when unset', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(result.env.REQUIRE_PROXY_TOKEN).toBe('false');
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

    expect(result.sensitive.OPENCLAW_GATEWAY_TOKEN).toBe(expectedToken);
    expect(result.env.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('skips channel decryption when no private key configured', async () => {
    const env = createMockEnv(); // no AGENT_ENV_VARS_PRIVATE_KEY
    const channels: EncryptedChannelTokens = {
      telegramBotToken: encryptForTest('tg-token', testPublicKey),
    };
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, { channels });

    expect(result.sensitive.TELEGRAM_BOT_TOKEN).toBeUndefined();
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

    expect(result.sensitive.TELEGRAM_BOT_TOKEN).toBe('tg-only');
    expect(result.env.AUTO_APPROVE_DEVICES).toBe('true');
  });

  it('handles empty userConfig gracefully', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {});

    expect(result.env.AUTO_APPROVE_DEVICES).toBe('true');
  });

  // ─── Reserved prefix validation ──────────────────────────────────────

  it('drops user envVars with reserved KILOCLAW_ prefix instead of throwing', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { KILOCLAW_ENC_FOO: 'bad', VALID_VAR: 'good' },
    });

    expect(result.env.KILOCLAW_ENC_FOO).toBeUndefined();
    expect(result.sensitive.KILOCLAW_ENC_FOO).toBeUndefined();
    expect(result.env.VALID_VAR).toBe('good');
  });

  it('drops encrypted secrets with reserved KILOCLAW_ prefix instead of throwing', async () => {
    const env = createMockEnv({ AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey });
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      encryptedSecrets: {
        KILOCLAW_ENV_BAD: encryptForTest('val', testPublicKey),
      },
    });

    expect(result.sensitive.KILOCLAW_ENV_BAD).toBeUndefined();
  });

  it('drops user envVars with invalid shell identifier instead of throwing', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { 'MY-VAR': 'bad', GOOD_VAR: 'good' },
    });

    expect(result.env['MY-VAR']).toBeUndefined();
    expect(result.env.GOOD_VAR).toBe('good');
  });

  // ─── Google credentials (Layer 4b) ───────────────────────────────────

  it('decrypts Google gog config tarball into sensitive bucket', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const tarballBase64 = Buffer.from('fake-tarball').toString('base64');
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      googleCredentials: {
        gogConfigTarball: encryptForTest(tarballBase64, testPublicKey),
        email: 'user@gmail.com',
      },
    });

    expect(result.sensitive.KILOCLAW_GOG_CONFIG_TARBALL).toBe(tarballBase64);
    expect(result.env.KILOCLAW_GOOGLE_ACCOUNT_EMAIL).toBe('user@gmail.com');
    // Should not leak into plaintext
    expect(result.env.KILOCLAW_GOG_CONFIG_TARBALL).toBeUndefined();
  });

  it('decrypts Google gog config tarball without email', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const tarballBase64 = Buffer.from('fake-tarball').toString('base64');
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      googleCredentials: {
        gogConfigTarball: encryptForTest(tarballBase64, testPublicKey),
      },
    });

    expect(result.sensitive.KILOCLAW_GOG_CONFIG_TARBALL).toBe(tarballBase64);
    expect(result.env.KILOCLAW_GOOGLE_ACCOUNT_EMAIL).toBeUndefined();
  });

  it('continues without Google access when credential decryption fails', async () => {
    const env = createMockEnv({
      AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      googleCredentials: {
        gogConfigTarball: {
          encryptedData: 'bad',
          encryptedDEK: 'bad',
          algorithm: 'rsa-aes-256-gcm' as const,
          version: 1 as const,
        },
      },
    });

    expect(result.sensitive.KILOCLAW_GOG_CONFIG_TARBALL).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to decrypt Google credentials, starting without Google access:',
      expect.any(Error)
    );
    warnSpy.mockRestore();
  });

  it('skips Google credential decryption when no private key configured', async () => {
    const env = createMockEnv(); // no AGENT_ENV_VARS_PRIVATE_KEY
    const tarballBase64 = Buffer.from('fake-tarball').toString('base64');
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      googleCredentials: {
        gogConfigTarball: encryptForTest(tarballBase64, testPublicKey),
      },
    });

    expect(result.sensitive.KILOCLAW_GOG_CONFIG_TARBALL).toBeUndefined();
  });

  // ─── Catalog-derived SENSITIVE_KEYS equivalence ───────────────────────
  // Verifies that switching from hardcoded SENSITIVE_KEYS to catalog-derived
  // ALL_SECRET_ENV_VARS produces identical classification behavior.
  // The catalog contains the exact same 4 env var names that were hardcoded.

  it('classifies all catalog channel env vars as sensitive (catalog-derived SENSITIVE_KEYS)', async () => {
    const env = createMockEnv({ AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey });

    // Provide all 4 channel env var names as plaintext user env vars.
    // They should all land in the sensitive bucket because SENSITIVE_KEYS
    // is now derived from the catalog (which includes all 4).
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: {
        TELEGRAM_BOT_TOKEN: 'tg-plain',
        DISCORD_BOT_TOKEN: 'discord-plain',
        SLACK_BOT_TOKEN: 'slack-bot-plain',
        SLACK_APP_TOKEN: 'slack-app-plain',
      },
    });

    // All 4 must be in sensitive — same behavior as the old hardcoded set
    expect(result.sensitive.TELEGRAM_BOT_TOKEN).toBe('tg-plain');
    expect(result.sensitive.DISCORD_BOT_TOKEN).toBe('discord-plain');
    expect(result.sensitive.SLACK_BOT_TOKEN).toBe('slack-bot-plain');
    expect(result.sensitive.SLACK_APP_TOKEN).toBe('slack-app-plain');

    // None should leak into the plaintext env bucket
    expect(result.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(result.env.SLACK_APP_TOKEN).toBeUndefined();
  });

  // ─── Instance feature flags (Layer 6) ───────────────────────────────

  it('maps instanceFeatures to KILOCLAW_* env vars', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      instanceFeatures: ['npm-global-prefix'],
    });

    expect(result.env.KILOCLAW_NPM_GLOBAL_PREFIX).toBe('true');
  });

  it('ignores unknown feature names without emitting env vars', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      instanceFeatures: ['nonexistent-feature'],
    });

    // No feature-flag env vars should be set.
    const knownFeatureVars = new Set(Object.values(FEATURE_TO_ENV_VAR));
    const featureVars = Object.keys(result.env).filter(k => knownFeatureVars.has(k));
    expect(featureVars).toEqual([]);
  });

  it('emits no feature env vars when instanceFeatures is empty', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      instanceFeatures: [],
    });

    expect(result.env.KILOCLAW_NPM_GLOBAL_PREFIX).toBeUndefined();
  });

  it('drops user KILOCLAW_* env var and feature flag still applies (defense-in-depth)', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      envVars: { KILOCLAW_NPM_GLOBAL_PREFIX: 'false' },
      instanceFeatures: ['npm-global-prefix'],
    });

    // User's attempt to set it to 'false' was dropped; feature flag sets it to 'true'
    expect(result.env.KILOCLAW_NPM_GLOBAL_PREFIX).toBe('true');
  });

  it('every DEFAULT_INSTANCE_FEATURES entry has a FEATURE_TO_ENV_VAR mapping', () => {
    for (const feature of DEFAULT_INSTANCE_FEATURES) {
      expect(
        FEATURE_TO_ENV_VAR[feature],
        `Missing FEATURE_TO_ENV_VAR mapping for "${feature}"`
      ).toBeDefined();
    }
  });

  // ─── Exec preset env vars ─────────────────────────────────────────────

  it('passes KILOCLAW_EXEC_SECURITY and KILOCLAW_EXEC_ASK in env when set', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      execSecurity: 'full',
      execAsk: 'off',
    });

    expect(result.env.KILOCLAW_EXEC_SECURITY).toBe('full');
    expect(result.env.KILOCLAW_EXEC_ASK).toBe('off');
  });

  it('does not set exec env vars when execSecurity and execAsk are null', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      execSecurity: null,
      execAsk: null,
    });

    expect(result.env.KILOCLAW_EXEC_SECURITY).toBeUndefined();
    expect(result.env.KILOCLAW_EXEC_ASK).toBeUndefined();
  });

  it('does not set exec env vars when not provided in userConfig', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {});

    expect(result.env.KILOCLAW_EXEC_SECURITY).toBeUndefined();
    expect(result.env.KILOCLAW_EXEC_ASK).toBeUndefined();
  });

  // ─── Custom secrets (non-catalog) ──────────────────────────────────

  it('routes custom encrypted secrets to the sensitive bucket', async () => {
    const env = createMockEnv({ AGENT_ENV_VARS_PRIVATE_KEY: testPrivateKey });
    const customEnvelope = encryptForTest('my-secret-value', testPublicKey);

    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      encryptedSecrets: { MY_CUSTOM_KEY: customEnvelope },
    });

    expect(result.sensitive.MY_CUSTOM_KEY).toBe('my-secret-value');
    expect(result.env.MY_CUSTOM_KEY).toBeUndefined();
  });

  it('serializes customSecretMeta config paths as KILOCLAW_SECRET_CONFIG_PATHS', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      customSecretMeta: {
        MY_KEY: { configPath: 'models.providers.openai.apiKey' },
        OTHER_KEY: { configPath: 'talk.apiKey' },
      },
    });

    expect(JSON.parse(result.env.KILOCLAW_SECRET_CONFIG_PATHS) as unknown).toEqual({
      MY_KEY: 'models.providers.openai.apiKey',
      OTHER_KEY: 'talk.apiKey',
    });
  });

  it('omits KILOCLAW_SECRET_CONFIG_PATHS when no config paths exist', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      customSecretMeta: { MY_KEY: {} },
    });

    expect(result.env.KILOCLAW_SECRET_CONFIG_PATHS).toBeUndefined();
  });

  it('omits KILOCLAW_SECRET_CONFIG_PATHS when customSecretMeta is null', async () => {
    const env = createMockEnv();
    const result = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      customSecretMeta: null,
    });

    expect(result.env.KILOCLAW_SECRET_CONFIG_PATHS).toBeUndefined();
  });

  // ─── Vector memory + dreaming ───────────────────────────────────────

  it('emits KILOCLAW_VECTOR_MEMORY_ENABLED only when vectorMemoryEnabled is truthy', async () => {
    const env = createMockEnv();

    const unset = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(unset.env.KILOCLAW_VECTOR_MEMORY_ENABLED).toBeUndefined();

    const off = await buildEnvVars(env, SANDBOX_ID, SECRET, { vectorMemoryEnabled: false });
    expect(off.env.KILOCLAW_VECTOR_MEMORY_ENABLED).toBeUndefined();

    const on = await buildEnvVars(env, SANDBOX_ID, SECRET, { vectorMemoryEnabled: true });
    expect(on.env.KILOCLAW_VECTOR_MEMORY_ENABLED).toBe('true');
  });

  it('emits KILOCLAW_VECTOR_MEMORY_MODEL only when vectorMemoryModel is set', async () => {
    const env = createMockEnv();

    const none = await buildEnvVars(env, SANDBOX_ID, SECRET, { vectorMemoryEnabled: true });
    expect(none.env.KILOCLAW_VECTOR_MEMORY_MODEL).toBeUndefined();

    const set = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      vectorMemoryEnabled: true,
      vectorMemoryModel: 'openai/text-embedding-3-small',
    });
    expect(set.env.KILOCLAW_VECTOR_MEMORY_MODEL).toBe('openai/text-embedding-3-small');

    const nulled = await buildEnvVars(env, SANDBOX_ID, SECRET, {
      vectorMemoryEnabled: true,
      vectorMemoryModel: null,
    });
    expect(nulled.env.KILOCLAW_VECTOR_MEMORY_MODEL).toBeUndefined();
  });

  it('emits KILOCLAW_DREAMING_ENABLED only when dreamingEnabled is truthy', async () => {
    const env = createMockEnv();

    const unset = await buildEnvVars(env, SANDBOX_ID, SECRET);
    expect(unset.env.KILOCLAW_DREAMING_ENABLED).toBeUndefined();

    const off = await buildEnvVars(env, SANDBOX_ID, SECRET, { dreamingEnabled: false });
    expect(off.env.KILOCLAW_DREAMING_ENABLED).toBeUndefined();

    const on = await buildEnvVars(env, SANDBOX_ID, SECRET, { dreamingEnabled: true });
    expect(on.env.KILOCLAW_DREAMING_ENABLED).toBe('true');
  });
});
