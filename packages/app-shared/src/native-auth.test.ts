import { describe, expect, test } from 'vitest';
import { API_GATEWAY_CREDENTIAL_FORMAT, parseNativeTokenPair } from './native-auth';

describe('parseNativeTokenPair', () => {
  test('accepts a complete tagged credential bundle without dropping metadata', () => {
    expect(
      parseNativeTokenPair({
        token: 'api-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        metadata: {
          credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
          gatewayToken: 'gateway-token',
          expiresAt: '2026-09-02T22:00:00.000Z',
        },
      })
    ).toEqual({
      token: 'api-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      metadata: {
        credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
        gatewayToken: 'gateway-token',
        expiresAt: '2026-09-02T22:00:00.000Z',
      },
    });
  });

  test.each([
    { token: 'api-token', credentialFormat: 'future-format' },
    { token: 'api-token', metadata: { credentialFormat: 'future-format' } },
    {
      token: 'api-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      metadata: { credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT, gatewayToken: 'gateway-token' },
    },
    {
      token: 'api-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      metadata: {
        credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
        gatewayToken: 'gateway-token',
        expiresAt: 'not-an-iso-date',
      },
    },
  ])('rejects tagged unknown or incomplete payloads', value => {
    expect(parseNativeTokenPair(value)).toBeNull();
  });

  test('keeps untagged legacy partial refresh responses token-only', () => {
    expect(parseNativeTokenPair({ token: 'legacy-token', refreshToken: 'partial' })).toEqual({
      token: 'legacy-token',
      created: undefined,
    });
  });

  test('preserves legacy response envelopes while stripping unrelated fields', () => {
    expect(
      parseNativeTokenPair({
        token: 'legacy-token',
        userId: 'user-1',
        userEmail: 'user@example.test',
        status: 'approved',
      })
    ).toEqual({ token: 'legacy-token', created: undefined });
  });

  test.each([undefined, null, {}, false, { gatewayToken: 'gateway-only' }])(
    'never treats malformed metadata as a legacy credential',
    metadata => {
      expect(
        parseNativeTokenPair({
          token: 'api-token',
          refreshToken: 'refresh-token',
          expiresIn: 3600,
          metadata,
        })
      ).toBeNull();
    }
  );

  test('rejects misplaced bundle fields instead of dropping them', () => {
    expect(
      parseNativeTokenPair({
        token: 'api-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        gatewayToken: 'gateway-token',
      })
    ).toBeNull();
  });
});
