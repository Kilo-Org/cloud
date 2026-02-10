import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, publicEncrypt, randomBytes, createCipheriv, constants } from 'crypto';
import type { EncryptedEnvelope, EncryptedChannelTokens } from '../schemas/instance-config';
import {
  decryptWithPrivateKey,
  decryptSecrets,
  mergeEnvVarsWithSecrets,
  decryptChannelTokens,
  EncryptionConfigurationError,
  EncryptionFormatError,
} from './encryption';

/**
 * Helper: encrypt a string using the same RSA+AES envelope scheme
 * used by the shared lib (src/lib/encryption.ts). This allows us
 * to test decryption without importing the shared encryption module.
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

describe('encryption utilities', () => {
  let publicKey: string;
  let privateKey: string;
  let wrongPrivateKey: string;

  beforeAll(() => {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;

    const wrongPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    wrongPrivateKey = wrongPair.privateKey;
  });

  describe('decryptWithPrivateKey', () => {
    it('decrypts an encrypted value correctly', () => {
      const envelope = encryptForTest('hello secret', publicKey);
      expect(decryptWithPrivateKey(envelope, privateKey)).toBe('hello secret');
    });

    it('handles empty string', () => {
      const envelope = encryptForTest('', publicKey);
      expect(decryptWithPrivateKey(envelope, privateKey)).toBe('');
    });

    it('handles unicode and special characters', () => {
      const values = ['Hello 世界!', 'Emoji 🔐🚀', 'Special: !@#$%^&*()'];
      for (const value of values) {
        const envelope = encryptForTest(value, publicKey);
        expect(decryptWithPrivateKey(envelope, privateKey)).toBe(value);
      }
    });

    it('handles long strings', () => {
      const longValue = 'x'.repeat(10000);
      const envelope = encryptForTest(longValue, publicKey);
      expect(decryptWithPrivateKey(envelope, privateKey)).toBe(longValue);
    });

    it('throws EncryptionConfigurationError for empty private key', () => {
      const envelope = encryptForTest('test', publicKey);
      expect(() => decryptWithPrivateKey(envelope, '')).toThrow(EncryptionConfigurationError);
      expect(() => decryptWithPrivateKey(envelope, '')).toThrow(
        'Private key parameter is required'
      );
    });

    it('throws EncryptionConfigurationError for wrong private key', () => {
      const envelope = encryptForTest('test', publicKey);
      expect(() => decryptWithPrivateKey(envelope, wrongPrivateKey)).toThrow(
        EncryptionConfigurationError
      );
      expect(() => decryptWithPrivateKey(envelope, wrongPrivateKey)).toThrow('Decryption failed');
    });

    it('throws EncryptionFormatError for null envelope', () => {
      expect(() => decryptWithPrivateKey(null as unknown as EncryptedEnvelope, privateKey)).toThrow(
        EncryptionFormatError
      );
    });

    it('throws EncryptionFormatError for unsupported algorithm', () => {
      const envelope = encryptForTest('test', publicKey);
      const bad = { ...envelope, algorithm: 'aes-128-cbc' } as unknown as EncryptedEnvelope;
      expect(() => decryptWithPrivateKey(bad, privateKey)).toThrow(EncryptionFormatError);
      expect(() => decryptWithPrivateKey(bad, privateKey)).toThrow('Unsupported algorithm');
    });

    it('throws EncryptionFormatError for unsupported version', () => {
      const envelope = encryptForTest('test', publicKey);
      const bad = { ...envelope, version: 2 } as unknown as EncryptedEnvelope;
      expect(() => decryptWithPrivateKey(bad, privateKey)).toThrow(EncryptionFormatError);
      expect(() => decryptWithPrivateKey(bad, privateKey)).toThrow('Unsupported version');
    });

    it('throws EncryptionFormatError for missing encryptedData', () => {
      const envelope = encryptForTest('test', publicKey);
      const bad = { ...envelope, encryptedData: '' };
      expect(() => decryptWithPrivateKey(bad, privateKey)).toThrow(EncryptionFormatError);
    });
  });

  describe('decryptSecrets', () => {
    it('decrypts all secrets in a record', () => {
      const secrets: Record<string, EncryptedEnvelope> = {
        API_KEY: encryptForTest('secret-key', publicKey),
        DATABASE_URL: encryptForTest('postgres://localhost/db', publicKey),
      };
      const result = decryptSecrets(secrets, privateKey);
      expect(result).toEqual({
        API_KEY: 'secret-key',
        DATABASE_URL: 'postgres://localhost/db',
      });
    });

    it('returns empty object for empty secrets', () => {
      expect(decryptSecrets({}, privateKey)).toEqual({});
    });
  });

  describe('mergeEnvVarsWithSecrets', () => {
    it('merges env vars with decrypted secrets', () => {
      const envVars = { NODE_ENV: 'production', PORT: '3000' };
      const secrets: Record<string, EncryptedEnvelope> = {
        API_KEY: encryptForTest('secret-key', publicKey),
      };
      const result = mergeEnvVarsWithSecrets(envVars, secrets, privateKey);
      expect(result).toEqual({
        NODE_ENV: 'production',
        PORT: '3000',
        API_KEY: 'secret-key',
      });
    });

    it('secrets override env vars on conflict', () => {
      const envVars = { API_KEY: 'plaintext-key' };
      const secrets: Record<string, EncryptedEnvelope> = {
        API_KEY: encryptForTest('encrypted-key', publicKey),
      };
      const result = mergeEnvVarsWithSecrets(envVars, secrets, privateKey);
      expect(result.API_KEY).toBe('encrypted-key');
    });

    it('returns env vars unchanged when no secrets provided', () => {
      const envVars = { NODE_ENV: 'production' };
      expect(mergeEnvVarsWithSecrets(envVars, undefined, privateKey)).toEqual(envVars);
    });

    it('returns env vars unchanged when secrets record is empty', () => {
      const envVars = { NODE_ENV: 'production' };
      expect(mergeEnvVarsWithSecrets(envVars, {}, privateKey)).toEqual(envVars);
    });

    it('returns only decrypted secrets when no env vars provided', () => {
      const secrets: Record<string, EncryptedEnvelope> = {
        API_KEY: encryptForTest('secret', publicKey),
      };
      const result = mergeEnvVarsWithSecrets(undefined, secrets, privateKey);
      expect(result).toEqual({ API_KEY: 'secret' });
    });

    it('throws EncryptionConfigurationError when secrets present but no private key', () => {
      const secrets: Record<string, EncryptedEnvelope> = {
        API_KEY: encryptForTest('secret', publicKey),
      };
      expect(() => mergeEnvVarsWithSecrets(undefined, secrets, undefined)).toThrow(
        EncryptionConfigurationError
      );
      expect(() => mergeEnvVarsWithSecrets(undefined, secrets, undefined)).toThrow(
        'AGENT_ENV_VARS_PRIVATE_KEY is required'
      );
    });

    it('returns empty object when both envVars and secrets are undefined', () => {
      expect(mergeEnvVarsWithSecrets(undefined, undefined, undefined)).toEqual({});
    });
  });

  describe('decryptChannelTokens', () => {
    it('decrypts and maps all channel tokens', () => {
      const channels: EncryptedChannelTokens = {
        telegramBotToken: encryptForTest('tg-token-123', publicKey),
        discordBotToken: encryptForTest('discord-token-456', publicKey),
        slackBotToken: encryptForTest('slack-bot-789', publicKey),
        slackAppToken: encryptForTest('slack-app-012', publicKey),
      };
      const result = decryptChannelTokens(channels, privateKey);
      expect(result).toEqual({
        TELEGRAM_BOT_TOKEN: 'tg-token-123',
        DISCORD_BOT_TOKEN: 'discord-token-456',
        SLACK_BOT_TOKEN: 'slack-bot-789',
        SLACK_APP_TOKEN: 'slack-app-012',
      });
    });

    it('only maps channels that are present', () => {
      const channels: EncryptedChannelTokens = {
        telegramBotToken: encryptForTest('tg-token', publicKey),
      };
      const result = decryptChannelTokens(channels, privateKey);
      expect(result).toEqual({ TELEGRAM_BOT_TOKEN: 'tg-token' });
      expect(result.DISCORD_BOT_TOKEN).toBeUndefined();
      expect(result.SLACK_BOT_TOKEN).toBeUndefined();
      expect(result.SLACK_APP_TOKEN).toBeUndefined();
    });

    it('returns empty object when no channel tokens are set', () => {
      const channels: EncryptedChannelTokens = {};
      expect(decryptChannelTokens(channels, privateKey)).toEqual({});
    });
  });
});
