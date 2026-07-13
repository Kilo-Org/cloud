import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  mintWrapperDispatchTicket,
  validateStreamTicket,
  validateWrapperDispatchTicket,
  type WrapperDispatchTicketClaims,
} from './auth.js';

const secret = 'test-secret';

describe('validateStreamTicket', () => {
  it('returns a configuration error when NEXTAUTH_SECRET is missing', () => {
    expect(validateStreamTicket('ticket', null)).toEqual({
      success: false,
      error: 'NEXTAUTH_SECRET is not configured on the worker',
    });
  });

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

const wrapperDispatchTicketClaims: WrapperDispatchTicketClaims = {
  type: 'wrapper_dispatch_ticket',
  userId: 'user-1',
  cloudAgentSessionId: 'session-1',
  kiloSessionId: 'kilo-session-1',
  wrapperRunId: 'run-1',
  wrapperGeneration: 2,
  wrapperConnectionId: 'connection-1',
};

describe('validateWrapperDispatchTicket', () => {
  it('returns a configuration error when NEXTAUTH_SECRET is missing', async () => {
    await expect(validateWrapperDispatchTicket('Bearer ticket', null)).resolves.toEqual({
      success: false,
      error: 'NEXTAUTH_SECRET is not configured on the worker',
    });
  });

  it('returns an error when the Authorization header is missing or malformed', async () => {
    await expect(validateWrapperDispatchTicket(null, secret)).resolves.toEqual({
      success: false,
      error: 'Missing or malformed Authorization header',
    });
    await expect(validateWrapperDispatchTicket('NotBearer ticket', secret)).resolves.toEqual({
      success: false,
      error: 'Missing or malformed Authorization header',
    });
  });

  it('round-trips a minted ticket, preserving claims exactly', async () => {
    const ticket = mintWrapperDispatchTicket(wrapperDispatchTicketClaims, secret);

    await expect(validateWrapperDispatchTicket(`Bearer ${ticket}`, secret)).resolves.toEqual({
      success: true,
      claims: wrapperDispatchTicketClaims,
    });
  });

  it('rejects a raw Kilo JWT / stream ticket by its type discriminant', async () => {
    const streamTicket = jwt.sign(
      { type: 'stream_ticket', userId: 'user-1', cloudAgentSessionId: 'session-1' },
      secret,
      { algorithm: 'HS256', expiresIn: '1 minute' }
    );
    const kiloJwt = jwt.sign({ kiloUserId: 'user-1' }, secret, {
      algorithm: 'HS256',
      expiresIn: '1 minute',
    });

    await expect(validateWrapperDispatchTicket(`Bearer ${streamTicket}`, secret)).resolves.toEqual({
      success: false,
      error: 'Invalid ticket type',
    });
    await expect(validateWrapperDispatchTicket(`Bearer ${kiloJwt}`, secret)).resolves.toEqual({
      success: false,
      error: 'Invalid ticket type',
    });
  });

  it('accepts a legacy raw Kilo JWT so wrapper processes bound before ticket support shipped keep working', async () => {
    const legacyToken = jwt.sign({ version: 3, kiloUserId: 'user-1' }, secret, {
      algorithm: 'HS256',
      expiresIn: '1 minute',
    });

    await expect(validateWrapperDispatchTicket(`Bearer ${legacyToken}`, secret)).resolves.toEqual({
      success: true,
      claims: { type: 'legacy_kilo_token', userId: 'user-1' },
    });
  });

  it('rejects an audience-scoped Kilo JWT on the legacy path', async () => {
    const audienceScopedToken = jwt.sign({ version: 3, kiloUserId: 'user-1' }, secret, {
      algorithm: 'HS256',
      expiresIn: '1 minute',
      audience: 'git-token-service',
    });

    await expect(
      validateWrapperDispatchTicket(`Bearer ${audienceScopedToken}`, secret)
    ).resolves.toEqual({
      success: false,
      error: 'Invalid ticket type',
    });
  });

  it('rejects an expired ticket', async () => {
    const ticket = jwt.sign(wrapperDispatchTicketClaims, secret, {
      algorithm: 'HS256',
      expiresIn: -1,
    });

    await expect(validateWrapperDispatchTicket(`Bearer ${ticket}`, secret)).resolves.toEqual({
      success: false,
      error: 'Ticket expired',
    });
  });

  it('rejects a malformed ticket', async () => {
    await expect(validateWrapperDispatchTicket('Bearer not-a-jwt', secret)).resolves.toEqual({
      success: false,
      error: 'Invalid ticket signature',
    });
  });

  it('rejects a ticket signed with the wrong secret', async () => {
    const ticket = mintWrapperDispatchTicket(wrapperDispatchTicketClaims, 'other-secret');

    await expect(validateWrapperDispatchTicket(`Bearer ${ticket}`, secret)).resolves.toEqual({
      success: false,
      error: 'Invalid ticket signature',
    });
  });
});
