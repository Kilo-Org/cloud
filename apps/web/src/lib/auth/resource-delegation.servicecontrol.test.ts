import { describe, expect, test } from '@jest/globals';
import jwt from 'jsonwebtoken';

const shared = { enabled: true };
jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'service-control-test-secret',
  isSharedResourceTokenIssuanceEnabled: () => shared.enabled,
}));
jest.mock('@/lib/user/server', () => ({ getUserFromSessionForCredentialIssuance: jest.fn() }));

import { generateCloudAgentWorkflowToken } from '@/lib/tokens';
import { defineTestUser } from '@/tests/helpers/user.helper';

describe('workflow service control tokens', () => {
  test('uses bounded modern automation admission', () => {
    const user = defineTestUser({ api_token_pepper: 'workflow-pepper' });
    const token = generateCloudAgentWorkflowToken(user, {
      expiresIn: 300,
      tokenSource: 'reviewer',
      botId: 'reviewer',
    });
    const claims = jwt.verify(token, 'service-control-test-secret') as jwt.JwtPayload;
    expect(claims).toMatchObject({
      aud: 'cloud-agent-next',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
      runtimeAdmission: {
        source: 'automation',
        authorizationUserId: user.id,
        authorizationPepper: 'workflow-pepper',
      },
    });
    expect(claims.exp! - claims.iat!).toBe(300);
  });

  test('caps modern workflow admission to one hour', () => {
    const user = defineTestUser({ api_token_pepper: 'workflow-pepper' });
    const token = generateCloudAgentWorkflowToken(user, {
      expiresIn: 5 * 365 * 24 * 60 * 60,
      tokenSource: 'reviewer',
    });
    const claims = jwt.decode(token) as jwt.JwtPayload;

    expect(claims.exp! - claims.iat!).toBe(60 * 60);
  });

  test('requires an authorization pepper for modern workflow admission', () => {
    const user = defineTestUser({ api_token_pepper: 'workflow-pepper' });
    const authorizationUser = defineTestUser({ api_token_pepper: null });

    expect(() =>
      generateCloudAgentWorkflowToken(user, {
        expiresIn: 300,
        tokenSource: 'reviewer',
        authorizationUser,
      })
    ).toThrow('current authorization pepper');
  });

  test('preserves the legacy workflow token shape when shared issuance is disabled', () => {
    shared.enabled = false;
    const user = defineTestUser({ api_token_pepper: 'workflow-pepper' });
    const token = generateCloudAgentWorkflowToken(user, {
      expiresIn: 300,
      tokenSource: 'reviewer',
      botId: 'reviewer',
    });
    const claims = jwt.verify(token, 'service-control-test-secret') as jwt.JwtPayload;
    expect(claims).toMatchObject({
      kiloUserId: user.id,
      tokenSource: 'reviewer',
      botId: 'reviewer',
    });
    expect(claims).not.toHaveProperty('tokenPurpose');
    expect(claims.exp! - claims.iat!).toBe(300);
  });
});
