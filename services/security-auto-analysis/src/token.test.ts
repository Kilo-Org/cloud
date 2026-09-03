import { describe, expect, it } from 'vitest';
import {
  generateControlToken,
  generateInternalServiceToken,
  generateTriageToken,
} from './token.js';

const secret = 'test-secret-at-least-thirty-two-characters';
const user = { id: 'user-1', api_token_pepper: 'current-pepper' };

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('JWT payload missing');
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
}

describe('security analysis token issuance', () => {
  it('preserves legacy tokens while shared resource tokens are disabled', async () => {
    const [control, triage, session] = await Promise.all([
      generateControlToken(user, secret, 'production', false),
      generateTriageToken(user, secret, 'production', undefined),
      generateInternalServiceToken(user.id, secret, 'false'),
    ]);

    expect(decodeJwt(control)).toMatchObject({
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      env: 'production',
      internalApiUse: true,
      createdOnPlatform: 'security-agent',
    });
    expect(decodeJwt(control)).not.toHaveProperty('aud');
    expect(decodeJwt(triage)).not.toHaveProperty('aud');
    expect(decodeJwt(session)).not.toHaveProperty('aud');
    expect(decodeJwt(session)).not.toHaveProperty('apiTokenPepper');
  });

  it('mints isolated modern control, triage, and session assertions', async () => {
    const [control, triage, session] = await Promise.all([
      generateControlToken(user, secret, 'production', true),
      generateTriageToken(user, secret, 'production', true),
      generateInternalServiceToken(user.id, secret, true),
    ]);

    expect(decodeJwt(control)).toMatchObject({
      aud: 'cloud-agent-next',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
      env: 'production',
      apiTokenPepper: user.api_token_pepper,
      runtimeAdmission: {
        source: 'automation',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    });
    expect(decodeJwt(triage)).toMatchObject({
      aud: 'kilo-gateway',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
      env: 'production',
      apiTokenPepper: user.api_token_pepper,
    });
    expect(decodeJwt(triage)).not.toHaveProperty('runtimeAdmission');
    expect(decodeJwt(session)).toMatchObject({
      aud: 'session-ingest',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
    });
    expect(decodeJwt(session)).not.toHaveProperty('env');
    expect(decodeJwt(session)).not.toHaveProperty('apiTokenPepper');
  });
});
