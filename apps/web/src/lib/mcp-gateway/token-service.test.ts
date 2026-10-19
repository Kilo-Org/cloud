import { describe, expect, test } from '@jest/globals';
import { createGatewayServices } from './services';
import type { GatewayAppConfig } from './config';

function createTestConfig(): GatewayAppConfig {
  return {
    appBaseUrl: 'https://app.kilo.ai',
    gatewayBaseUrl: 'https://mcp.kilosessions.ai',
    issuer: 'https://app.kilo.ai',
    accessTokenTtlSeconds: 900,
    authorizationRequestTtlSeconds: 1_800,
    authorizationCodeTtlSeconds: 600,
    registrationCredentialTtlSeconds: 30 * 24 * 60 * 60,
    rateLimitSecret: 'test-rate-limit-secret',
    jwtKeyset: {
      issuer: 'https://app.kilo.ai',
      activeKeyId: 'jwt-active',
      keys: [
        {
          keyId: 'jwt-active',
          publicJwk: {
            kty: 'RSA',
            n: 'modulus',
            e: 'AQAB',
            use: 'sig',
            alg: 'RS256',
            key_ops: ['verify'],
            // Type-cast only: the point of this test is that the published
            // keyset never carries members outside the public allowlist, even
            // if a config object somehow holds them.
            d: 'should-never-be-published',
          } as GatewayAppConfig['jwtKeyset']['keys'][number]['publicJwk'],
          privateKeyPem: 'private-key',
        },
      ],
    },
    credentialKeyset: {
      active: { keyId: 'credential-active', publicKeyPem: 'public-key' },
      decrypt: [],
    },
  };
}

describe('MCP gateway published keyset', () => {
  test('publishes only allowlisted public members plus kid', () => {
    const config = createTestConfig();
    const services = createGatewayServices({ config });

    const { keys } = services.tokenService.publicJwks(config);

    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'e', 'key_ops', 'kid', 'kty', 'n', 'use']);
    expect(keys[0]).toMatchObject({
      kid: 'jwt-active',
      kty: 'RSA',
      n: 'modulus',
      e: 'AQAB',
      use: 'sig',
      alg: 'RS256',
      key_ops: ['verify'],
    });
  });
});
