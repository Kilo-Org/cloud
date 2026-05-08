import { describe, expect, test } from '@jest/globals';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { createLinearBotLinkState, verifyLinearBotLinkState } from './linear-link-state';

const USER_ID = 'kilo-user-1';
const PLATFORM_INTEGRATION_ID = 'pi_linear_1';
const ORGANIZATION_ID = 'org-linear-123';

function signPayload(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', NEXTAUTH_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

describe('linear bot-link state', () => {
  test('round trips a payload', () => {
    const state = createLinearBotLinkState({
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
    expect(verifyLinearBotLinkState(state)).toEqual({
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
      callbackPath: '/linear/link',
    });
  });

  test('returns null for null state', () => {
    expect(verifyLinearBotLinkState(null)).toBeNull();
  });

  test('returns null for malformed state', () => {
    expect(verifyLinearBotLinkState('garbage')).toBeNull();
  });

  test('returns null when the signature is tampered with', () => {
    const state = createLinearBotLinkState({
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
    });
    const dotIndex = state.indexOf('.');
    expect(
      verifyLinearBotLinkState(
        `${state.slice(0, dotIndex)}.${'A'.repeat(state.length - dotIndex - 1)}`
      )
    ).toBeNull();
  });

  test('returns null when the kind discriminator is missing', () => {
    // A correctly-signed payload that does not declare kind: 'linear-bot-link'
    // must be rejected. This guards against confusing install-flow states with
    // bot-link states.
    const stateWithoutKind = signPayload({
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
      callbackPath: '/linear/link',
      iat: Math.floor(Date.now() / 1000),
      nonce: 'nonce',
    });
    expect(verifyLinearBotLinkState(stateWithoutKind)).toBeNull();
  });

  test('returns null when the kind discriminator is wrong', () => {
    const stateWithWrongKind = signPayload({
      kind: 'github-bot-link',
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
      callbackPath: '/linear/link',
      iat: Math.floor(Date.now() / 1000),
      nonce: 'nonce',
    });
    expect(verifyLinearBotLinkState(stateWithWrongKind)).toBeNull();
  });

  test('returns null for expired states', () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000_000_000;
      const state = createLinearBotLinkState({
        userId: USER_ID,
        platformIntegrationId: PLATFORM_INTEGRATION_ID,
        organizationId: ORGANIZATION_ID,
      });
      Date.now = () => 1_000_000_000_000 + 11 * 60 * 1000;
      expect(verifyLinearBotLinkState(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('returns null when callbackPath is not a path', () => {
    const state = signPayload({
      kind: 'linear-bot-link',
      userId: USER_ID,
      platformIntegrationId: PLATFORM_INTEGRATION_ID,
      organizationId: ORGANIZATION_ID,
      callbackPath: 'https://evil.example.com',
      iat: Math.floor(Date.now() / 1000),
      nonce: 'nonce',
    });
    expect(verifyLinearBotLinkState(state)).toBeNull();
  });
});
