import { describe, it, expect } from 'vitest';
import {
  generateEnvKey,
  encryptEnvValue,
  decryptEnvValue,
  isEncryptedEnvValue,
  validateUserEnvVarName,
  ENCRYPTED_ENV_PREFIX,
} from './env-encryption';

describe('generateEnvKey', () => {
  it('produces a base64 string that decodes to 32 bytes', () => {
    const key = generateEnvKey();
    const buf = Buffer.from(key, 'base64');
    expect(buf.length).toBe(32);
  });
});

describe('encryptEnvValue / decryptEnvValue', () => {
  it('round-trips: encrypt then decrypt returns original value', () => {
    const key = generateEnvKey();
    const plaintext = 'sk-test-api-key-12345';
    const encrypted = encryptEnvValue(key, plaintext);
    const decrypted = decryptEnvValue(key, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('handles empty string', () => {
    const key = generateEnvKey();
    const encrypted = encryptEnvValue(key, '');
    expect(decryptEnvValue(key, encrypted)).toBe('');
  });

  it('handles values with special characters', () => {
    const key = generateEnvKey();
    const value = 'token=\'with"special\nchars&stuff';
    const encrypted = encryptEnvValue(key, value);
    expect(decryptEnvValue(key, encrypted)).toBe(value);
  });
});

describe('isEncryptedEnvValue', () => {
  it('returns true for enc:v1: prefixed strings', () => {
    expect(isEncryptedEnvValue('enc:v1:abc123')).toBe(true);
  });

  it('returns false for plain strings', () => {
    expect(isEncryptedEnvValue('plain-value')).toBe(false);
    expect(isEncryptedEnvValue('')).toBe(false);
    expect(isEncryptedEnvValue('enc:v2:wrong-version')).toBe(false);
  });
});

describe('validateUserEnvVarName', () => {
  it('accepts valid shell identifiers', () => {
    expect(() => validateUserEnvVarName('MY_VAR')).not.toThrow();
    expect(() => validateUserEnvVarName('_private')).not.toThrow();
    expect(() => validateUserEnvVarName('var123')).not.toThrow();
  });

  it('rejects KILOCLAW_ENC_ prefix', () => {
    expect(() => validateUserEnvVarName('KILOCLAW_ENC_FOO')).toThrow('reserved prefix');
  });

  it('rejects KILOCLAW_ENV_ prefix', () => {
    expect(() => validateUserEnvVarName('KILOCLAW_ENV_KEY')).toThrow('reserved prefix');
  });

  it('rejects names with hyphens', () => {
    expect(() => validateUserEnvVarName('MY-VAR')).toThrow('valid shell identifier');
  });

  it('rejects names starting with digit', () => {
    expect(() => validateUserEnvVarName('123VAR')).toThrow('valid shell identifier');
  });

  it('rejects empty string', () => {
    expect(() => validateUserEnvVarName('')).toThrow('valid shell identifier');
  });
});

describe('ENCRYPTED_ENV_PREFIX', () => {
  it('is KILOCLAW_ENC_', () => {
    expect(ENCRYPTED_ENV_PREFIX).toBe('KILOCLAW_ENC_');
  });
});
