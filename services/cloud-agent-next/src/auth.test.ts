import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  mintPreviewSessionToken,
  mintWrapperDispatchTicket,
  validatePreviewEntryTicket,
  validatePreviewSessionToken,
  validateStreamTicket,
  validateWrapperDispatchTicket,
  type WrapperDispatchTicketClaims,
} from './auth.js';

const secret = 'test-secret';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const WORKTREE_ID = 'worktree_22222222-2222-4222-8222-222222222222';

const FENCE = {
  provider: 'cloudflare-containers',
  logicalSandboxId: 'workspace-container',
  allocationRef: 'allocation-ref',
} as const;

describe('preview session token', () => {
  const claims = {
    userId: 'user-1',
    cloudAgentSessionId: SESSION_ID,
    port: 5173,
    ...FENCE,
  } as const;

  it('round-trips its claims and organization', () => {
    const token = mintPreviewSessionToken({ ...claims, organizationId: 'org-1' }, secret);
    expect(validatePreviewSessionToken(token, secret)).toEqual({
      success: true,
      claims: { ...claims, organizationId: 'org-1' },
    });
  });

  it('round-trips a workspace target', () => {
    const token = mintPreviewSessionToken(
      { userId: 'user-1', worktreeId: WORKTREE_ID, port: 5173, ...FENCE },
      secret
    );
    expect(validatePreviewSessionToken(token, secret)).toEqual({
      success: true,
      claims: { userId: 'user-1', worktreeId: WORKTREE_ID, port: 5173, ...FENCE },
    });
  });

  it('rejects a legacy cookie that has no allocation fence', () => {
    const token = jwt.sign(
      {
        type: 'preview_session',
        userId: 'user-1',
        cloudAgentSessionId: SESSION_ID,
        port: 5173,
      },
      secret,
      { algorithm: 'HS256', expiresIn: 3600, audience: 'cloud-agent-preview-session' }
    );
    expect(validatePreviewSessionToken(token, secret)).toMatchObject({
      success: false,
      error: 'Invalid preview claims',
    });
  });

  it('rejects a token that names both target kinds', () => {
    const ambiguous = jwt.sign(
      {
        type: 'preview_session',
        userId: 'user-1',
        cloudAgentSessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        port: 5173,
        ...FENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      secret,
      { algorithm: 'HS256', audience: 'cloud-agent-preview-session' }
    );
    expect(validatePreviewSessionToken(ambiguous, secret)).toMatchObject({ success: false });
  });

  it('rejects a missing secret and a missing token', () => {
    expect(validatePreviewSessionToken('token', null)).toMatchObject({ success: false });
    expect(validatePreviewSessionToken(null, secret)).toMatchObject({ success: false });
  });

  it('rejects a token signed with another secret', () => {
    const token = mintPreviewSessionToken(claims, 'other-secret');
    expect(validatePreviewSessionToken(token, secret)).toMatchObject({ success: false });
  });

  it('rejects a stream ticket presented as a preview session token', () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'preview',
        userId: 'u',
        cloudAgentSessionId: SESSION_ID,
      },
      secret,
      { algorithm: 'HS256', expiresIn: '1 minute', audience: 'cloud-agent-preview-session' }
    );
    expect(validatePreviewSessionToken(ticket, secret)).toMatchObject({
      success: false,
      error: 'Invalid preview session type',
    });
  });

  it('rejects an expired preview session token', () => {
    const token = mintPreviewSessionToken(claims, secret, Math.floor(Date.now() / 1000) - 7200);
    expect(validatePreviewSessionToken(token, secret)).toMatchObject({ success: false });
  });
});

describe('preview entry ticket', () => {
  function entryTicket(payload: Record<string, unknown>, audience = 'cloud-agent-preview') {
    return jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'preview',
        userId: 'user-1',
        cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
        port: 5173,
        nonce: 'nonce-1',
        ...payload,
      },
      secret,
      { algorithm: 'HS256', expiresIn: 60, audience }
    );
  }

  it('returns the claims, nonce and expiry of a valid entry ticket', () => {
    const ticket = entryTicket({ organizationId: 'org-1' });
    const { exp } = jwt.decode(ticket) as { exp: number };
    expect(validatePreviewEntryTicket(ticket, secret)).toEqual({
      success: true,
      claims: {
        userId: 'user-1',
        cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
        port: 5173,
        organizationId: 'org-1',
      },
      nonce: 'nonce-1',
      expiresAtMs: exp * 1000,
    });
  });

  it('accepts a workspace-target entry ticket', () => {
    const ticket = entryTicket({
      cloudAgentSessionId: undefined,
      worktreeId: WORKTREE_ID,
    });
    expect(validatePreviewEntryTicket(ticket, secret)).toMatchObject({
      success: true,
      claims: {
        userId: 'user-1',
        worktreeId: WORKTREE_ID,
        port: 5173,
      },
    });
  });

  it('rejects an entry ticket that names both target kinds', () => {
    expect(
      validatePreviewEntryTicket(entryTicket({ worktreeId: WORKTREE_ID }), secret)
    ).toMatchObject({ success: false });
  });

  it('rejects an entry ticket without a nonce', () => {
    expect(validatePreviewEntryTicket(entryTicket({ nonce: undefined }), secret)).toMatchObject({
      success: false,
    });
  });

  it('rejects a ticket for another purpose, audience or without a port', () => {
    expect(validatePreviewEntryTicket(entryTicket({ purpose: 'terminal' }), secret)).toMatchObject({
      success: false,
    });
    expect(
      validatePreviewEntryTicket(entryTicket({}, 'cloud-agent-terminal'), secret)
    ).toMatchObject({ success: false });
    expect(validatePreviewEntryTicket(entryTicket({ port: undefined }), secret)).toMatchObject({
      success: false,
    });
  });

  it('rejects the preview session token presented as an entry ticket', () => {
    const token = mintPreviewSessionToken(
      {
        userId: 'user-1',
        cloudAgentSessionId: SESSION_ID,
        port: 5173,
        ...FENCE,
      },
      secret
    );
    expect(validatePreviewEntryTicket(token, secret)).toMatchObject({ success: false });
  });
});

describe('validateStreamTicket', () => {
  it('returns a configuration error when NEXTAUTH_SECRET is missing', () => {
    expect(validateStreamTicket('ticket', null, 'cloud-agent-stream')).toEqual({
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
      { algorithm: 'HS256', expiresIn: -1, audience: 'cloud-agent-stream' }
    );

    expect(validateStreamTicket(ticket, secret, 'cloud-agent-stream')).toEqual({
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
      { algorithm: 'HS256', expiresIn: '1 minute', audience: 'cloud-agent-stream' }
    );

    expect(validateStreamTicket(ticket, secret, 'cloud-agent-stream')).toMatchObject({
      success: true,
      payload: {
        type: 'stream_ticket',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
    });
  });

  it('rejects a stream ticket presented with the terminal audience', () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: '1 minute', audience: 'cloud-agent-stream' }
    );

    expect(validateStreamTicket(ticket, secret, 'cloud-agent-terminal')).toEqual({
      success: false,
      error: 'Invalid ticket audience',
    });
  });

  it('rejects a terminal ticket presented with the stream audience', () => {
    const ticket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'terminal',
        userId: 'user-1',
        cloudAgentSessionId: 'session-1',
      },
      secret,
      { algorithm: 'HS256', expiresIn: '1 minute', audience: 'cloud-agent-terminal' }
    );

    expect(validateStreamTicket(ticket, secret, 'cloud-agent-stream')).toEqual({
      success: false,
      error: 'Invalid ticket audience',
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

  it.each([
    ['the Cloud Agent Next REST audience', 'cloud-agent-next'],
    ['an array containing the REST audience', ['other-service', 'cloud-agent-next']],
    ['a different resource audience', 'kilo-gateway'],
    ['an explicit null audience', null],
    ['an explicit empty audience', ''],
    ['a malformed empty audience list', []],
    ['a malformed null audience list', [null]],
    ['a malformed audience object', { audience: 'cloud-agent-next' }],
  ])('rejects a legacy Kilo JWT with %s', async (_description, aud) => {
    const token = jwt.sign({ version: 3, kiloUserId: 'user-1', aud }, secret, {
      algorithm: 'HS256',
      expiresIn: '1 minute',
    });

    await expect(validateWrapperDispatchTicket(`Bearer ${token}`, secret)).resolves.toEqual({
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

  it('accepts a legacy Kilo JWT carrying deviceSessionId claim', async () => {
    const legacyToken = jwt.sign(
      { version: 3, kiloUserId: 'user-1', deviceSessionId: 'session-xyz-999' },
      secret,
      { algorithm: 'HS256', expiresIn: '1 minute' }
    );

    await expect(validateWrapperDispatchTicket(`Bearer ${legacyToken}`, secret)).resolves.toEqual({
      success: true,
      claims: { type: 'legacy_kilo_token', userId: 'user-1' },
    });
  });
});
