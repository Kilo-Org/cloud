import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authorize, verifyGrant } from '../auth';
import type { Env } from '../env';
import type { Principal } from '../protocol';
import { testEnv } from '../../test/helpers';
import { sameTicket } from './protocol';
import {
  LiveTicketError,
  mintTicket,
  verifyTicket,
  type LiveRole,
  type LiveTicket,
} from './ticket';

const SECRET = 'synthetic-live-ticket-signing-key-0123456789';
const USER = 'usr-ticket-owner';
const ORG = '00000000-0000-4000-8000-000000000001';
const SESSION = 'ses_ticket_security';
const principal: Principal = { userID: USER, tenant: { type: 'user', id: USER } };
const env: Env = { ...testEnv, SESSION_SYNC_SECRET: SECRET, ENVIRONMENT: 'development' };
const nowSeconds = () => Math.floor(Date.now() / 1000);

function sign(claims: Record<string, unknown>, secret = SECRET, alg = 'HS256') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg, typ: 'JWT' })
    .sign(new TextEncoder().encode(secret));
}

function grant(overrides: Record<string, unknown> = {}) {
  const now = nowSeconds();
  return sign({
    version: 1,
    iss: 'session-sync',
    aud: 'session-sync',
    env: 'development',
    sub: USER,
    tenant: principal.tenant,
    iat: now,
    exp: now + 300,
    ...overrides,
  });
}

function request(token: string) {
  return new Request('https://session-sync.test/v1/sessions/ses_ticket_security/live-ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

function ticketClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    version: 1,
    aud: 'session-relay',
    env: 'development',
    tenant: principal.tenant,
    sessionID: SESSION,
    userID: USER,
    role: 'viewer',
    iat: now,
    exp: now + 120,
    ...overrides,
  };
}

async function verified(token: string): Promise<LiveTicket> {
  const claims = await verifyTicket(token, env, 'session-relay');
  if (!claims) throw new Error('Expected a valid ticket');
  return claims;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('live tickets', () => {
  it.each([0, 5, 6])('allows at most five seconds of ticket issue-time skew: %s', async skew => {
    const now = nowSeconds();
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const token = await sign(ticketClaims({ iat: now + skew, exp: now + 120 }));
    const result = await verifyTicket(token, env, 'session-relay');
    if (skew <= 5) {
      expect(result).toMatchObject({ userID: USER, iat: now + skew });
    } else {
      expect(result).toBeUndefined();
    }
  });

  it('does not apply issue-time leeway to grant or ticket expiration', async () => {
    const now = nowSeconds();
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    expect(await verifyGrant(await grant({ iat: now - 60, exp: now - 1 }), env)).toBeUndefined();
    expect(
      await verifyTicket(
        await sign(ticketClaims({ iat: now - 60, exp: now - 1 })),
        env,
        'session-relay'
      )
    ).toBeUndefined();
  });

  it.each<LiveRole>(['runner', 'viewer', 'controller'])(
    'mints a relay %s ticket bounded to two minutes',
    async role => {
      const before = nowSeconds();
      const minted = await mintTicket(
        request(await grant()),
        env,
        principal,
        'session-relay',
        role,
        SESSION
      );
      const claims = await verified(minted.ticket);
      expect(claims).toMatchObject({
        version: 1,
        aud: 'session-relay',
        env: env.ENVIRONMENT,
        tenant: principal.tenant,
        userID: USER,
        sessionID: SESSION,
        role,
      });
      expect(claims.iat).toBeGreaterThanOrEqual(before);
      expect(claims.exp - claims.iat).toBe(120);
      expect(minted.expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
    }
  );

  it('never outlives the original grant', async () => {
    const deadline = nowSeconds() + 30;
    const minted = await mintTicket(
      request(await grant({ exp: deadline })),
      env,
      principal,
      'session-relay',
      'viewer',
      SESSION
    );
    expect((await verified(minted.ticket)).exp).toBe(deadline);
  });

  it.each<LiveRole>(['runner', 'viewer', 'controller'])(
    'mints a user-scoped presence %s ticket',
    async role => {
      const minted = await mintTicket(
        request(await grant()),
        env,
        principal,
        'session-presence',
        role
      );
      const claims = await verifyTicket(minted.ticket, env, 'session-presence');
      expect(claims).toMatchObject({
        userID: USER,
        role,
        aud: 'session-presence',
      });
      expect(claims).not.toHaveProperty('sessionID');
      expect(await verifyTicket(minted.ticket, env, 'session-relay')).toBeUndefined();
    }
  );

  it('preserves organization tenant binding', async () => {
    const member: Principal = { userID: USER, tenant: { type: 'organization', id: ORG } };
    const minted = await mintTicket(
      request(await grant({ tenant: member.tenant })),
      env,
      member,
      'session-relay',
      'controller',
      SESSION
    );
    expect((await verified(minted.ticket)).tenant).toEqual(member.tenant);
  });

  it.each<[string, Principal]>([
    ['changed user', { userID: 'usr-other', tenant: { type: 'organization', id: ORG } }],
    ['changed tenant', { userID: USER, tenant: { type: 'organization', id: ORG } }],
    ['invalid personal binding', { userID: USER, tenant: { type: 'user', id: 'usr-other' } }],
  ])('rechecks the grant against the route principal: %s', async (_name, changed) => {
    await expect(
      mintTicket(request(await grant()), env, changed, 'session-relay', 'viewer', SESSION)
    ).rejects.toMatchObject({ status: 401, code: 'invalid_grant' });
  });

  it.each<[string, () => Record<string, unknown>]>([
    ['expired', () => ({ iat: nowSeconds() - 60, exp: nowSeconds() - 1 })],
    ['future issued', () => ({ iat: nowSeconds() + 60 })],
    ['wrong environment', () => ({ env: 'production' })],
    ['unknown claim', () => ({ owner: true })],
    ['overlong lifetime', () => ({ exp: nowSeconds() + 1000 })],
  ])('refuses to mint from a %s grant', async (_name, overrides) => {
    await expect(
      mintTicket(
        request(await grant(overrides())),
        env,
        principal,
        'session-relay',
        'viewer',
        SESSION
      )
    ).rejects.toMatchObject({ status: 401, code: 'invalid_grant' });
  });

  it('requires a sync grant even with an already supplied principal', async () => {
    await expect(
      mintTicket(
        new Request('https://session-sync.test'),
        env,
        principal,
        'session-relay',
        'viewer',
        SESSION
      )
    ).rejects.toBeInstanceOf(LiveTicketError);
  });

  it('requires grants to be bound to the configured environment', async () => {
    const token = await grant({ env: 'development' });
    expect(await authorize(request(token), env)).toEqual(principal);
    expect(await verifyGrant(token, env)).toMatchObject({ principal });
    expect(
      await mintTicket(request(token), env, principal, 'session-relay', 'runner', SESSION)
    ).toHaveProperty('ticket');
    for (const binding of [undefined, 'production']) {
      const invalid = await grant({ env: binding });
      expect(await authorize(request(invalid), env)).toBeInstanceOf(Response);
      expect(await verifyGrant(invalid, env)).toBeUndefined();
      await expect(
        mintTicket(request(invalid), env, principal, 'session-relay', 'runner', SESSION)
      ).rejects.toMatchObject({ status: 401, code: 'invalid_grant' });
    }
  });

  it.each([
    ['session-scoped controller presence', 'session-presence', 'controller', SESSION],
    ['session-scoped presence', 'session-presence', 'runner', SESSION],
    ['relay without session', 'session-relay', 'viewer', undefined],
  ] as const)('rejects invalid mint scope: %s', async (_name, audience, role, sessionID) => {
    await expect(
      mintTicket(request(await grant()), env, principal, audience, role, sessionID)
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('requires a configured environment and strong signing secret', async () => {
    const req = request(await grant());
    await expect(
      mintTicket(
        req,
        { ...env, ENVIRONMENT: undefined },
        principal,
        'session-relay',
        'viewer',
        SESSION
      )
    ).rejects.toMatchObject({ status: 503, code: 'auth_unavailable' });
    await expect(
      mintTicket(
        req,
        { ...env, SESSION_SYNC_SECRET: 'weak' },
        principal,
        'session-relay',
        'viewer',
        SESSION
      )
    ).rejects.toMatchObject({ status: 503, code: 'auth_unavailable' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['another audience', { aud: 'session-sync' }],
    ['an audience array', { aud: ['session-relay'] }],
    ['another environment', { env: 'production' }],
    ['a missing environment', { env: undefined }],
    ['a future issue time', { iat: nowSeconds() + 60 }],
    ['a fractional issue time', { iat: nowSeconds() - 0.5 }],
    ['an expired ticket', { iat: nowSeconds() - 120, exp: nowSeconds() - 1 }],
    ['a missing expiry', { exp: undefined }],
    ['a lifetime above two minutes', { exp: nowSeconds() + 1000 }],
    ['an invalid role', { role: 'owner' }],
    ['another user personal tenant', { userID: 'usr-other' }],
    ['a malformed tenant', { tenant: { type: 'organization', id: 'not-a-uuid' } }],
    ['an extra tenant field', { tenant: { ...principal.tenant, role: 'owner' } }],
    ['a missing session', { sessionID: undefined }],
    ['a malformed session', { sessionID: 'invalid' }],
    ['an unknown claim', { admin: true }],
    ['another version', { version: 2 }],
    ['session-scoped controller presence', { aud: 'session-presence', role: 'controller' }],
    ['session-scoped presence', { aud: 'session-presence' }],
  ])('rejects signed tickets with %s', async (_name, overrides) => {
    const token = await sign(ticketClaims(overrides));
    const audience = overrides.aud === 'session-presence' ? 'session-presence' : 'session-relay';
    expect(await verifyTicket(token, env, audience)).toBeUndefined();
  });

  it('rejects forgery, algorithm confusion, sync grants, and cross-audience reuse', async () => {
    expect(
      await verifyTicket(await sign(ticketClaims(), `${SECRET}-wrong`), env, 'session-relay')
    ).toBeUndefined();
    expect(
      await verifyTicket(await sign(ticketClaims(), SECRET, 'HS384'), env, 'session-relay')
    ).toBeUndefined();
    expect(await verifyTicket(await grant(), env, 'session-relay')).toBeUndefined();
    const token = await sign(ticketClaims());
    expect(await verifyTicket(token, env, 'session-presence')).toBeUndefined();
    expect(await authorize(request(token), env)).toBeInstanceOf(Response);
  });

  it('allows reauthentication to change only its timestamps', async () => {
    const ticket = await verified(await sign(ticketClaims()));
    expect(sameTicket(ticket, { ...ticket, iat: ticket.iat + 1, exp: ticket.exp + 1 })).toBe(true);
    for (const change of [
      { aud: 'session-presence' as const },
      { env: 'production' },
      { tenant: { type: 'organization' as const, id: ORG } },
      { sessionID: 'ses_other' },
      { userID: 'usr-other' },
      { role: 'controller' as const },
    ]) {
      expect(sameTicket(ticket, { ...ticket, ...change } as LiveTicket)).toBe(false);
    }
  });
});
