import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { validateStreamTicket } from './auth.js';

const secret = 'test-secret';

describe('validateStreamTicket', () => {
  it('returns Ticket expired for expired stream tickets', () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: -1 }
    );

    expect(validateStreamTicket(ticket, secret)).toEqual({
      success: false,
      error: 'Ticket expired',
    });
  });

  it('returns the payload for valid stream tickets', () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: '1 minute' }
    );

    expect(validateStreamTicket(ticket, secret)).toMatchObject({
      success: true,
      payload: {
        type: 'stream_ticket',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
    });
  });
});
