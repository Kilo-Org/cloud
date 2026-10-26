import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { mintApiToken, mintStreamTicket, type TestUser } from '../e2e/auth.js';

describe('E2E API token', () => {
  it('carries modern Cloud Agent runtime admission claims', () => {
    const secret = 'test-secret';
    const user: TestUser = {
      id: 'usr_e2e_test',
      email: 'e2e@example.com',
      api_token_pepper: 'pepper',
    };

    const payload = jwt.verify(mintApiToken(user, secret), secret, {
      algorithms: ['HS256'],
      audience: 'cloud-agent-next',
    });

    expect(payload).toMatchObject({
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      aud: 'cloud-agent-next',
      tokenPurpose: 'human-api',
      credentialExchange: false,
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
      tokenSource: 'cloud-agent',
    });
  });

  it('represents a missing pepper explicitly', () => {
    const secret = 'test-secret';
    const user = { id: 'usr_e2e_test' };

    const payload = jwt.verify(mintApiToken(user, secret), secret, {
      algorithms: ['HS256'],
      audience: 'cloud-agent-next',
    });

    expect(payload).toMatchObject({
      apiTokenPepper: null,
      runtimeAdmission: {
        authorizationPepper: null,
      },
    });
  });
});

describe('E2E stream ticket', () => {
  it('uses the Cloud Agent stream audience', () => {
    const secret = 'test-secret';
    const user: TestUser = {
      id: 'usr_e2e_test',
      email: 'e2e@example.com',
      api_token_pepper: 'pepper',
    };

    const payload = jwt.verify(mintStreamTicket(user, 'agent_e2e', secret), secret, {
      algorithms: ['HS256'],
      audience: 'cloud-agent-stream',
    });

    expect(payload).toMatchObject({
      type: 'stream_ticket',
      userId: user.id,
      cloudAgentSessionId: 'agent_e2e',
      aud: 'cloud-agent-stream',
    });
  });
});
