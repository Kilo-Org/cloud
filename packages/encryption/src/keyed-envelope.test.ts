import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  decryptKeyedEnvelope,
  encryptKeyedEnvelope,
  EncryptionConfigurationError,
  EncryptionFormatError,
  parseKeyedEnvelope,
  serializeKeyedEnvelope,
  type KeyedEnvelope,
} from './index';

const scheme = 'example-token-rsa-aes-256-gcm';

function generateTestKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('keyed envelopes', () => {
  test('serializes and parses a typed keyed wrapper', () => {
    const envelope: KeyedEnvelope<typeof scheme> = {
      scheme,
      version: 1,
      keyId: 'active-key',
      ciphertext: {
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
        encryptedData: 'encrypted-data',
        encryptedDEK: 'encrypted-dek',
      },
    };

    expect(parseKeyedEnvelope(serializeKeyedEnvelope(envelope), scheme)).toEqual(envelope);
  });

  test('encrypts with and decrypts from the active key slot using caller AAD', () => {
    const { publicKey, privateKey } = generateTestKeyPair();
    const aad = 'authorization:v1:user-1:access';
    const serialized = encryptKeyedEnvelope(
      'active token',
      scheme,
      { keyId: 'active-key', publicKeyPem: publicKey },
      aad
    );

    expect(
      decryptKeyedEnvelope(
        serialized,
        scheme,
        { active: { keyId: 'active-key', privateKeyPem: privateKey } },
        aad
      )
    ).toBe('active token');
    expect(parseKeyedEnvelope(serialized, scheme).keyId).toBe('active-key');
  });

  test('rejects malformed serialized keyed envelopes', () => {
    expect(() => parseKeyedEnvelope('{', scheme)).toThrow(EncryptionFormatError);
    expect(() =>
      parseKeyedEnvelope(JSON.stringify({ scheme, version: 1, keyId: 'active-key' }), scheme)
    ).toThrow('malformed ciphertext');
  });

  test('decrypts old ciphertext from a configured retired slot', () => {
    const { publicKey: retiredPublicKey, privateKey: retiredPrivateKey } = generateTestKeyPair();
    const { publicKey: activePublicKey, privateKey: activePrivateKey } = generateTestKeyPair();
    const serialized = encryptKeyedEnvelope('retired token', scheme, {
      keyId: 'retired-key',
      publicKeyPem: retiredPublicKey,
    });

    expect(
      decryptKeyedEnvelope(serialized, scheme, {
        active: { keyId: 'active-key', privateKeyPem: activePrivateKey },
        decrypt: [{ keyId: 'retired-key', privateKeyPem: retiredPrivateKey }],
      })
    ).toBe('retired token');

    const activeSerialized = encryptKeyedEnvelope('active token', scheme, {
      keyId: 'active-key',
      publicKeyPem: activePublicKey,
    });
    expect(parseKeyedEnvelope(activeSerialized, scheme).keyId).toBe('active-key');
  });

  test('rejects an envelope whose key ID does not match an active or decrypt slot', () => {
    const { publicKey } = generateTestKeyPair();
    const serialized = encryptKeyedEnvelope('retired token', scheme, {
      keyId: 'retired-key',
      publicKeyPem: publicKey,
    });

    expect(() =>
      decryptKeyedEnvelope(serialized, scheme, { active: { keyId: 'active-key' } })
    ).toThrow(EncryptionFormatError);
    expect(() =>
      decryptKeyedEnvelope(serialized, scheme, { active: { keyId: 'active-key' } })
    ).toThrow('Unknown keyed envelope key ID');
  });

  test('reports missing private-key material for a configured slot as configuration error', () => {
    const { publicKey } = generateTestKeyPair();
    const serialized = encryptKeyedEnvelope('active token', scheme, {
      keyId: 'active-key',
      publicKeyPem: publicKey,
    });

    expect(() =>
      decryptKeyedEnvelope(serialized, scheme, { active: { keyId: 'active-key' } })
    ).toThrow(EncryptionConfigurationError);
    expect(() =>
      decryptKeyedEnvelope(serialized, scheme, { active: { keyId: 'active-key' } })
    ).toThrow('Private key is not configured');
  });
});
