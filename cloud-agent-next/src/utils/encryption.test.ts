/**
 * Tests for cloud-agent encryption utilities.
 *
 * These tests verify that:
 * 1. The shared encryption module works correctly
 * 2. Secrets are properly decrypted and merged with env vars
 * 3. Error handling works correctly
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { encryptWithPublicKey } from '../../../src/lib/encryption.js';
import {
  decryptWithPrivateKey,
  decryptSecrets,
  mergeEnvVarsWithSecrets,
  DecryptionConfigurationError,
  DecryptionFormatError,
} from './encryption';

// Aliases for test readability
const EncryptionConfigurationError = DecryptionConfigurationError;
const EncryptionFormatError = DecryptionFormatError;
import type { EncryptedSecretEnvelope, EncryptedSecrets } from './encryption';

describe('cloud-agent encryption utilities', () => {
  let publicKey: string;
  let privateKey: string;
  let wrongPrivateKey: string;

  beforeAll(() => {
    // Generate RSA key pair for testing
    const { publicKey: pubKey, privateKey: privKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    publicKey = pubKey;
    privateKey = privKey;

    // Generate another key pair for testing mismatched keys
    const { privateKey: wrongPrivKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    wrongPrivateKey = wrongPrivKey;
  });

  describe('decryptWithPrivateKey', () => {
    test('decrypts encrypted value correctly', () => {
      const testValue = 'test secret value';
      const envelope = encryptWithPublicKey(testValue, publicKey);

      const decrypted = decryptWithPrivateKey(envelope, privateKey);
      expect(decrypted).toBe(testValue);
    });

    test('handles unicode and special characters', () => {
      const testValues = [
        'Hello 世界! 🌍',
        '¡Hola! ¿Cómo estás?',
        'Привет мир',
        'こんにちは',
        '你好世界',
        'Emoji test 🚀 🎉 🔐',
        'Special chars: !@#$%^&*(){}[]|\\:";\'<>?,./~`',
        'Newlines\nand\ttabs',
      ];

      for (const testValue of testValues) {
        const envelope = encryptWithPublicKey(testValue, publicKey);
        const decrypted = decryptWithPrivateKey(envelope, privateKey);
        expect(decrypted).toBe(testValue);
      }
    });

    test('handles empty string', () => {
      const envelope = encryptWithPublicKey('', publicKey);
      const decrypted = decryptWithPrivateKey(envelope, privateKey);
      expect(decrypted).toBe('');
    });

    test('handles long strings', () => {
      const longValue = 'Lorem ipsum dolor sit amet. '.repeat(1000);
      const envelope = encryptWithPublicKey(longValue, publicKey);
      const decrypted = decryptWithPrivateKey(envelope, privateKey);
      expect(decrypted).toBe(longValue);
    });

    test('throws EncryptionConfigurationError for missing private key', () => {
      const envelope = encryptWithPublicKey('test', publicKey);

      expect(() => decryptWithPrivateKey(envelope, '')).toThrow(EncryptionConfigurationError);
      expect(() => decryptWithPrivateKey(envelope, '')).toThrow(
        'Private key parameter is required'
      );
    });

    test('throws EncryptionConfigurationError for wrong private key', () => {
      const envelope = encryptWithPublicKey('test', publicKey);

      expect(() => decryptWithPrivateKey(envelope, wrongPrivateKey)).toThrow(
        EncryptionConfigurationError
      );
      expect(() => decryptWithPrivateKey(envelope, wrongPrivateKey)).toThrow('Decryption failed');
    });

    test('throws EncryptionFormatError for invalid envelope', () => {
      expect(() =>
        decryptWithPrivateKey(null as unknown as EncryptedSecretEnvelope, privateKey)
      ).toThrow(EncryptionFormatError);

      expect(() =>
        decryptWithPrivateKey({} as unknown as EncryptedSecretEnvelope, privateKey)
      ).toThrow(EncryptionFormatError);
    });

    test('throws EncryptionFormatError for unsupported algorithm', () => {
      const envelope = encryptWithPublicKey('test', publicKey);
      const badEnvelope = {
        ...envelope,
        algorithm: 'aes-128-cbc' as const,
      } as unknown as EncryptedSecretEnvelope;

      expect(() => decryptWithPrivateKey(badEnvelope, privateKey)).toThrow(EncryptionFormatError);
      expect(() => decryptWithPrivateKey(badEnvelope, privateKey)).toThrow('Unsupported algorithm');
    });

    test('throws EncryptionFormatError for unsupported version', () => {
      const envelope = encryptWithPublicKey('test', publicKey);
      const badEnvelope = {
        ...envelope,
        version: 2,
      } as unknown as EncryptedSecretEnvelope;

      expect(() => decryptWithPrivateKey(badEnvelope, privateKey)).toThrow(EncryptionFormatError);
      expect(() => decryptWithPrivateKey(badEnvelope, privateKey)).toThrow('Unsupported version');
    });
  });

  describe('decryptSecrets', () => {
    test('decrypts all secrets in a record', () => {
      const secrets: EncryptedSecrets = {
        API_KEY: encryptWithPublicKey('secret-api-key', publicKey),
        DATABASE_URL: encryptWithPublicKey('postgres://localhost/db', publicKey),
        JWT_SECRET: encryptWithPublicKey('my-jwt-secret', publicKey),
      };

      const decrypted = decryptSecrets(secrets, privateKey);

      expect(decrypted).toEqual({
        API_KEY: 'secret-api-key',
        DATABASE_URL: 'postgres://localhost/db',
        JWT_SECRET: 'my-jwt-secret',
      });
    });

    test('returns empty object for empty secrets', () => {
      const decrypted = decryptSecrets({}, privateKey);
      expect(decrypted).toEqual({});
    });
  });

  describe('mergeEnvVarsWithSecrets', () => {
    test('merges env vars with decrypted secrets', () => {
      const envVars = {
        NODE_ENV: 'production',
        PORT: '3000',
      };

      const encryptedSecrets: EncryptedSecrets = {
        API_KEY: encryptWithPublicKey('secret-api-key', publicKey),
        DATABASE_URL: encryptWithPublicKey('postgres://localhost/db', publicKey),
      };

      const merged = mergeEnvVarsWithSecrets(envVars, encryptedSecrets, privateKey);

      expect(merged).toEqual({
        NODE_ENV: 'production',
        PORT: '3000',
        API_KEY: 'secret-api-key',
        DATABASE_URL: 'postgres://localhost/db',
      });
    });

    test('decrypted secrets override existing env vars with same key', () => {
      const envVars = {
        API_KEY: 'plaintext-key', // Will be overridden
        NODE_ENV: 'production',
      };

      const encryptedSecrets: EncryptedSecrets = {
        API_KEY: encryptWithPublicKey('encrypted-secret-key', publicKey),
      };

      const merged = mergeEnvVarsWithSecrets(envVars, encryptedSecrets, privateKey);

      expect(merged.API_KEY).toBe('encrypted-secret-key');
      expect(merged.NODE_ENV).toBe('production');
    });

    test('returns env vars unchanged when no secrets provided', () => {
      const envVars = {
        NODE_ENV: 'production',
        PORT: '3000',
      };

      const merged = mergeEnvVarsWithSecrets(envVars, {}, privateKey);

      expect(merged).toEqual(envVars);
    });

    test('returns only decrypted secrets when no env vars provided', () => {
      const encryptedSecrets: EncryptedSecrets = {
        API_KEY: encryptWithPublicKey('secret-api-key', publicKey),
      };

      const merged = mergeEnvVarsWithSecrets({}, encryptedSecrets, privateKey);

      expect(merged).toEqual({
        API_KEY: 'secret-api-key',
      });
    });
  });
});
