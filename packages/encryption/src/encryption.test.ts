import { describe, test, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  encryptWithPublicKey,
  decryptWithPrivateKey,
  encryptWithSymmetricKey,
  decryptWithSymmetricKey,
  decryptSecrets,
  mergeEnvVarsWithSecrets,
  EncryptionConfigurationError,
  EncryptionFormatError,
  type EncryptedEnvelope,
} from './encryption';

function generateTestKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('RSA envelope encryption', () => {
  let publicKey: string;
  let privateKey: string;
  let wrongPrivateKey: string;

  beforeAll(() => {
    ({ publicKey, privateKey } = generateTestKeyPair());
    ({ privateKey: wrongPrivateKey } = generateTestKeyPair());
  });

  test('round-trip encrypt + decrypt', () => {
    const value = 'test secret value';
    const envelope = encryptWithPublicKey(value, publicKey);

    expect(envelope.algorithm).toBe('rsa-aes-256-gcm');
    expect(envelope.version).toBe(1);
    expect(envelope.encryptedData.length).toBeGreaterThan(0);
    expect(envelope.encryptedDEK.length).toBeGreaterThan(0);

    expect(decryptWithPrivateKey(envelope, privateKey)).toBe(value);
  });

  test('empty strings, long strings, unicode', () => {
    // Empty
    const emptyEnv = encryptWithPublicKey('', publicKey);
    expect(decryptWithPrivateKey(emptyEnv, privateKey)).toBe('');

    // Long (~30KB)
    const longValue = 'Lorem ipsum dolor sit amet. '.repeat(1000);
    const longEnv = encryptWithPublicKey(longValue, publicKey);
    expect(decryptWithPrivateKey(longEnv, privateKey)).toBe(longValue);

    // Unicode
    for (const v of [
      'Hello 世界! 🌍',
      '¡Hola! ¿Cómo estás?',
      'Привет мир',
      'こんにちは',
      'Emoji test 🚀 🎉 🔐',
      'Special chars: !@#$%^&*(){}[]|\\:";\'<>?,./~`',
      'Newlines\nand\ttabs',
    ]) {
      expect(decryptWithPrivateKey(encryptWithPublicKey(v, publicKey), privateKey)).toBe(v);
    }
  });

  test('non-deterministic output (different IV/DEK each time)', () => {
    const value = 'same input value';
    const a = encryptWithPublicKey(value, publicKey);
    const b = encryptWithPublicKey(value, publicKey);

    expect(a.encryptedData).not.toBe(b.encryptedData);
    expect(a.encryptedDEK).not.toBe(b.encryptedDEK);

    expect(decryptWithPrivateKey(a, privateKey)).toBe(value);
    expect(decryptWithPrivateKey(b, privateKey)).toBe(value);
  });

  test('throws EncryptionConfigurationError for invalid public keys', () => {
    expect(() => encryptWithPublicKey('x', '')).toThrow(EncryptionConfigurationError);
    expect(() => encryptWithPublicKey('x', '')).toThrow('Public key parameter is required');

    expect(() => encryptWithPublicKey('x', 'not a valid key')).toThrow(
      EncryptionConfigurationError
    );
    expect(() => encryptWithPublicKey('x', 'not a valid key')).toThrow('Encryption failed');
  });

  test('throws EncryptionConfigurationError for invalid private keys', () => {
    const envelope = encryptWithPublicKey('test', publicKey);

    expect(() => decryptWithPrivateKey(envelope, '')).toThrow(EncryptionConfigurationError);
    expect(() => decryptWithPrivateKey(envelope, '')).toThrow('Private key parameter is required');

    expect(() => decryptWithPrivateKey(envelope, wrongPrivateKey)).toThrow(
      EncryptionConfigurationError
    );
    expect(() => decryptWithPrivateKey(envelope, wrongPrivateKey)).toThrow('Decryption failed');
  });

  test('throws EncryptionFormatError for invalid envelopes', () => {
    expect(() => decryptWithPrivateKey(null as unknown as EncryptedEnvelope, privateKey)).toThrow(
      EncryptionFormatError
    );

    expect(() => decryptWithPrivateKey({} as unknown as EncryptedEnvelope, privateKey)).toThrow(
      EncryptionFormatError
    );

    // Wrong algorithm
    const env = encryptWithPublicKey('test', publicKey);
    expect(() =>
      decryptWithPrivateKey(
        { ...env, algorithm: 'aes-128-cbc' as unknown as 'rsa-aes-256-gcm' },
        privateKey
      )
    ).toThrow('Unsupported algorithm');

    // Wrong version
    expect(() => decryptWithPrivateKey({ ...env, version: 2 as unknown as 1 }, privateKey)).toThrow(
      'Unsupported version'
    );

    // Data too short
    expect(() =>
      decryptWithPrivateKey(
        { ...env, encryptedData: Buffer.from('short').toString('base64') },
        privateKey
      )
    ).toThrow('Invalid encrypted data: too short');
  });

  test('corrupted ciphertext fails auth tag validation', () => {
    const envelope = encryptWithPublicKey('test value', publicKey);
    const corrupted = Buffer.from(envelope.encryptedData, 'base64');
    corrupted[20] ^= 0xff;

    expect(() =>
      decryptWithPrivateKey(
        { ...envelope, encryptedData: corrupted.toString('base64') },
        privateKey
      )
    ).toThrow('Decryption failed');
  });
});

describe('symmetric encryption', () => {
  const validKey = Buffer.from('a'.repeat(32)).toString('base64');

  test('round-trip encrypt + decrypt', () => {
    const value = 'symmetric secret';
    const encrypted = encryptWithSymmetricKey(value, validKey);
    expect(decryptWithSymmetricKey(encrypted, validKey)).toBe(value);
  });

  test('output format is iv:authTag:encrypted', () => {
    const encrypted = encryptWithSymmetricKey('test', validKey);
    expect(encrypted.split(':').length).toBe(3);
  });

  test('non-deterministic', () => {
    const a = encryptWithSymmetricKey('same', validKey);
    const b = encryptWithSymmetricKey('same', validKey);
    expect(a).not.toBe(b);
  });

  test('throws for missing key', () => {
    expect(() => encryptWithSymmetricKey('x', '')).toThrow('Encryption key is required');
  });

  test('throws for wrong-length key', () => {
    const shortKey = Buffer.from('short').toString('base64');
    expect(() => encryptWithSymmetricKey('x', shortKey)).toThrow(
      'Encryption key must be exactly 32 bytes'
    );
    expect(() => decryptWithSymmetricKey('a:b:c', shortKey)).toThrow(
      'Encryption key must be exactly 32 bytes'
    );
  });

  test('throws for bad format', () => {
    expect(() => decryptWithSymmetricKey('not-three-parts', validKey)).toThrow(
      'Invalid encrypted value format'
    );
  });
});

describe('decryptSecrets', () => {
  let publicKey: string;
  let privateKey: string;

  beforeAll(() => {
    ({ publicKey, privateKey } = generateTestKeyPair());
  });

  test('decrypts all secrets', () => {
    const secrets = {
      API_KEY: encryptWithPublicKey('secret-api-key', publicKey),
      DB_URL: encryptWithPublicKey('postgres://localhost/db', publicKey),
    };

    expect(decryptSecrets(secrets, privateKey)).toEqual({
      API_KEY: 'secret-api-key',
      DB_URL: 'postgres://localhost/db',
    });
  });

  test('returns empty for empty input', () => {
    expect(decryptSecrets({}, privateKey)).toEqual({});
  });
});

describe('mergeEnvVarsWithSecrets', () => {
  let publicKey: string;
  let privateKey: string;

  beforeAll(() => {
    ({ publicKey, privateKey } = generateTestKeyPair());
  });

  test('merges env vars with decrypted secrets', () => {
    const envVars = { NODE_ENV: 'production', PORT: '3000' };
    const secrets = {
      API_KEY: encryptWithPublicKey('secret-api-key', publicKey),
    };

    expect(mergeEnvVarsWithSecrets(envVars, secrets, privateKey)).toEqual({
      NODE_ENV: 'production',
      PORT: '3000',
      API_KEY: 'secret-api-key',
    });
  });

  test('secrets override env vars with same key', () => {
    const envVars = { API_KEY: 'plaintext', NODE_ENV: 'production' };
    const secrets = {
      API_KEY: encryptWithPublicKey('encrypted-secret', publicKey),
    };

    const merged = mergeEnvVarsWithSecrets(envVars, secrets, privateKey);
    expect(merged.API_KEY).toBe('encrypted-secret');
    expect(merged.NODE_ENV).toBe('production');
  });

  test('returns env vars unchanged without secrets', () => {
    const envVars = { NODE_ENV: 'production' };
    expect(mergeEnvVarsWithSecrets(envVars, {}, privateKey)).toEqual(envVars);
    expect(mergeEnvVarsWithSecrets(envVars, undefined, undefined)).toEqual(envVars);
  });

  test('throws when secrets present but no private key', () => {
    const secrets = {
      API_KEY: encryptWithPublicKey('secret', publicKey),
    };
    expect(() => mergeEnvVarsWithSecrets({}, secrets, undefined)).toThrow(
      'Private key is required'
    );
  });
});
