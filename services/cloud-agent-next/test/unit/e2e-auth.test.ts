import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { mintStreamTicket, type TestUser } from '../e2e/auth.js';

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
