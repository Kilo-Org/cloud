import { describe, expect, test } from '@jest/globals';
import { createLinearLinkToken, verifyLinearLinkToken } from './linear-link-token';

const PLATFORM_INTEGRATION_ID = 'pi_linear_1';
const ORGANIZATION_ID = 'org-linear-123';

describe('linear link tokens', () => {
  test('round trips a payload', () => {
    const token = createLinearLinkToken({
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(verifyLinearLinkToken(token)).toEqual({
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
  });

  test('returns null for null tokens', () => {
    expect(verifyLinearLinkToken(null)).toBeNull();
  });

  test('returns null for tokens missing the signature separator', () => {
    expect(verifyLinearLinkToken('not-a-token')).toBeNull();
  });

  test('returns null when the signature is tampered with', () => {
    const token = createLinearLinkToken({
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
    const dotIndex = token.indexOf('.');
    const tampered = `${token.slice(0, dotIndex)}.${'A'.repeat(token.length - dotIndex - 1)}`;
    expect(verifyLinearLinkToken(tampered)).toBeNull();
  });

  test('returns null when the payload is tampered with', () => {
    const token = createLinearLinkToken({
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
    const dotIndex = token.indexOf('.');
    const fakePayload = Buffer.from(
      JSON.stringify({
        platformIntegrationId: 'pi_evil',
        organizationId: ORGANIZATION_ID,
        iat: Math.floor(Date.now() / 1000),
        nonce: 'aaaa',
      })
    ).toString('base64url');
    expect(verifyLinearLinkToken(`${fakePayload}.${token.slice(dotIndex + 1)}`)).toBeNull();
  });

  test('returns null for expired tokens', () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000_000_000;
      const token = createLinearLinkToken({
        platformIntegrationId: PLATFORM_INTEGRATION_ID,
        organizationId: ORGANIZATION_ID,
      });
      // Jump 31 minutes forward — TTL is 30 minutes.
      Date.now = () => 1_000_000_000_000 + 31 * 60 * 1000;
      expect(verifyLinearLinkToken(token)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('returns null when platformIntegrationId is missing', () => {
    expect(
      verifyLinearLinkToken(
        createLinearLinkToken({ platformIntegrationId: '', organizationId: ORGANIZATION_ID })
      )
    ).toBeNull();
  });

  test('returns null when organizationId is missing', () => {
    expect(
      verifyLinearLinkToken(
        createLinearLinkToken({
          platformIntegrationId: PLATFORM_INTEGRATION_ID,
          organizationId: '',
        })
      )
    ).toBeNull();
  });
});
