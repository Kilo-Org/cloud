import { describe, expect, test } from '@jest/globals';
import { getGatewayAppConfig } from './config';

const gatewayEnvKeys = [
  'MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON',
  'MCP_GATEWAY_CREDENTIAL_KEYSET_JSON',
  'MCP_GATEWAY_RATE_LIMIT_SECRET',
] as const;

describe('getGatewayAppConfig', () => {
  test('accepts base64-encoded keyset env values', () => {
    const originalGatewayEnv = Object.fromEntries(
      gatewayEnvKeys.map(key => [key, process.env[key]])
    );
    try {
      process.env.MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON = Buffer.from(
        JSON.stringify({
          issuer: 'https://app.kilo.ai',
          activeKeyId: 'jwt-active',
          keys: [
            {
              keyId: 'jwt-active',
              publicJwk: { kty: 'RSA', n: 'modulus', e: 'AQAB' },
              privateKeyPem: 'private-key',
            },
          ],
        })
      ).toString('base64');
      process.env.MCP_GATEWAY_CREDENTIAL_KEYSET_JSON = Buffer.from(
        JSON.stringify({
          active: { keyId: 'credential-active', publicKeyPem: 'public-key' },
          decrypt: [{ keyId: 'credential-active', privateKeyPem: 'private-key' }],
        })
      ).toString('base64');
      process.env.MCP_GATEWAY_RATE_LIMIT_SECRET = 'test-rate-limit-secret';

      const config = getGatewayAppConfig();

      expect(config.jwtKeyset.activeKeyId).toBe('jwt-active');
      expect(config.credentialKeyset.active.keyId).toBe('credential-active');
    } finally {
      for (const key of gatewayEnvKeys) {
        const value = originalGatewayEnv[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test('rejects invalid trailing characters in base64 keysets', () => {
    const originalGatewayEnv = Object.fromEntries(
      gatewayEnvKeys.map(key => [key, process.env[key]])
    );
    try {
      process.env.MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON = `${Buffer.from(
        JSON.stringify({
          issuer: 'https://app.kilo.ai',
          activeKeyId: 'jwt-active',
          keys: [
            {
              keyId: 'jwt-active',
              publicJwk: { kty: 'RSA', n: 'modulus', e: 'AQAB' },
              privateKeyPem: 'private-key',
            },
          ],
        })
      ).toString('base64')}!`;
      process.env.MCP_GATEWAY_CREDENTIAL_KEYSET_JSON = Buffer.from(
        JSON.stringify({
          active: { keyId: 'credential-active', publicKeyPem: 'public-key' },
          decrypt: [{ keyId: 'credential-active', privateKeyPem: 'private-key' }],
        })
      ).toString('base64');
      process.env.MCP_GATEWAY_RATE_LIMIT_SECRET = 'test-rate-limit-secret';

      expect(() => getGatewayAppConfig()).toThrow(
        'MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON must contain valid JSON or base64-encoded JSON'
      );
    } finally {
      for (const key of gatewayEnvKeys) {
        const value = originalGatewayEnv[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test('accepts legacy JWT keysets without publicKeyPem', () => {
    const originalGatewayEnv = Object.fromEntries(
      gatewayEnvKeys.map(key => [key, process.env[key]])
    );
    try {
      process.env.MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON = JSON.stringify({
        issuer: 'https://app.kilo.ai',
        activeKeyId: 'jwt-active',
        keys: [
          {
            keyId: 'jwt-active',
            publicJwk: { kty: 'RSA', n: 'legacy-modulus', e: 'AQAB' },
            privateKeyPem: 'legacy-private-key',
          },
        ],
      });
      process.env.MCP_GATEWAY_CREDENTIAL_KEYSET_JSON = JSON.stringify({
        active: { keyId: 'credential-active', publicKeyPem: 'credential-public-key' },
        decrypt: [{ keyId: 'credential-active', privateKeyPem: 'credential-private-key' }],
      });
      process.env.MCP_GATEWAY_RATE_LIMIT_SECRET = 'test-rate-limit-secret';

      const config = getGatewayAppConfig();

      expect(config.jwtKeyset.keys[0]).toEqual({
        keyId: 'jwt-active',
        publicJwk: { kty: 'RSA', n: 'legacy-modulus', e: 'AQAB' },
        privateKeyPem: 'legacy-private-key',
      });
    } finally {
      for (const key of gatewayEnvKeys) {
        const value = originalGatewayEnv[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
