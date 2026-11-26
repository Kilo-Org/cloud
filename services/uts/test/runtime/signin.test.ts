import {
  DeviceAuthorizationResponseSchema,
  TicketRedemptionSchema,
  TicketResponseSchema,
  TokenResponseSchema,
} from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PendingAuthorization } from '../../src/oauth/authorize';
import { handleOAuthRequest } from '../../src/oauth/routes';
import { handleDeviceAuthorization } from '../../src/signin/device/authorization';
import { deviceCodeGrant } from '../../src/signin/device/grant';
import { handleDeviceDecision, handleDevicePage } from '../../src/signin/device/verification';
import { signInHandoff } from '../../src/signin/handoff';
import { handlePasskeyOptions, handlePasskeyVerify } from '../../src/signin/passkey/ceremonies';
import type { BrowserSession, DeviceExchangeResult } from '../../src/signin/store';
import { TICKET_REDEEMERS, handleTicketIssue, redeemTicket } from '../../src/tickets/routes';
import { createFirstPartyRefreshToken, randomCredential } from '../../src/token/credentials';
import { signerAccess } from '../../src/token/mint';
import {
  dpopKey,
  dpopProof,
  errorOf,
  fakeGrants,
  formRequest,
  oauthDeps,
  storeFailure,
} from './oauth-support';
import { ORIGIN, deviceDeps, fakeSignIn, fakeTickets, pageJson } from './signin-support';
import { config, env } from './test-env';

const COOKIE = randomCredential();
const OptionsBodySchema = z.object({ options: z.record(z.string(), z.unknown()) });
const UserCodeInputSchema = z.object({ userCodeHash: z.instanceof(Uint8Array) });

function session(minutesAgo = 1): BrowserSession {
  return {
    sessionId: crypto.randomUUID(),
    accountId: 'oauth/runtime-user',
    authTime: new Date(Date.now() - minutesAgo * 60_000),
    amr: ['passkey'],
  };
}

function pending(
  redirectKind: 'loopback' | 'private_use_scheme' = 'loopback'
): PendingAuthorization {
  return {
    client: {
      kind: 'first_party',
      clientId: redirectKind === 'loopback' ? 'kilo-cli' : 'kilo-mobile',
      name: 'Kilo',
      clientClass: redirectKind === 'loopback' ? 'desktop' : 'mobile',
      redirectKind,
    },
    redirectUri: 'http://127.0.0.1:4100/callback',
    scopes: ['gateway:models.read'],
    audiences: ['gateway'],
    orgHint: null,
  };
}

function withCookie(url: string): Request {
  return new Request(url, { headers: { Cookie: `__Host-uts_session=${COOKIE}` } });
}

describe('sign-in hand-off', () => {
  const authorizeUrl = `${config.endpoints.issuer}/authorize`;

  it('shows the sign-in page without a session, and runs no statement', async () => {
    const store = fakeSignIn();
    const result = await signInHandoff(store.deps)(new Request(authorizeUrl), pending());
    if (result.status !== 'interaction') throw new Error('expected the sign-in page');
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(result.response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(await result.response.text()).toContain('Sign in with a passkey');
    expect(store.calls).toEqual([]);
  });

  it('approves a first-party loopback client for the session, whatever its sign-in age', async () => {
    const live = session(60);
    const store = fakeSignIn({ readSession: async () => live });
    const result = await signInHandoff(store.deps)(withCookie(authorizeUrl), {
      ...pending(),
      orgHint: '0e6b1f0c-8d6d-4a51-9d63-1f7a4d2b9c11',
    });
    expect(result).toEqual({
      status: 'approved',
      approval: {
        clientKind: 'first_party',
        accountId: live.accountId,
        browserSessionId: live.sessionId,
        authTime: live.authTime,
        amr: ['passkey'],
        orgId: '0e6b1f0c-8d6d-4a51-9d63-1f7a4d2b9c11',
      },
    });
  });

  it('asks a private-use-scheme client for a sign-in under 5 minutes old (RFC 8252 section 8.6)', async () => {
    const stale = fakeSignIn({ readSession: async () => session(6) });
    expect(
      (await signInHandoff(stale.deps)(withCookie(authorizeUrl), pending('private_use_scheme')))
        .status
    ).toBe('interaction');
    const fresh = fakeSignIn({ readSession: async () => session(1) });
    expect(
      (await signInHandoff(fresh.deps)(withCookie(authorizeUrl), pending('private_use_scheme')))
        .status
    ).toBe('approved');
  });

  it('denies a third-party client until the consent screen serves it', async () => {
    const store = fakeSignIn();
    const result = await signInHandoff(store.deps)(withCookie(authorizeUrl), {
      ...pending(),
      client: {
        kind: 'third_party',
        clientId: 'https://client.example.com/metadata',
        name: 'Example',
      },
    });
    expect(result).toEqual({ status: 'denied' });
    expect(store.calls).toEqual([]);
  });

  it('answers 503 with Retry-After when the session read fails and a retry can succeed', async () => {
    const store = fakeSignIn({
      readSession: async () => {
        throw storeFailure('retryable');
      },
    });
    const result = await signInHandoff(store.deps)(withCookie(authorizeUrl), pending());
    if (result.status !== 'interaction') throw new Error('expected the error page');
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get('Retry-After')).toBe('2');
  });
});

describe('passkey ceremonies', () => {
  it('refuse a request from another origin, without an origin, or not in JSON', async () => {
    const store = fakeSignIn();
    const body = { ceremony: 'sign_in' };
    for (const request of [
      pageJson('/signin/passkey/options', body, { origin: 'https://evil.example' }),
      pageJson('/signin/passkey/options', body, { origin: 'https://other.kiloapps.io' }),
      pageJson('/signin/passkey/options', body, { origin: null }),
    ]) {
      expect((await handlePasskeyOptions(request, store.deps)).status).toBe(403);
    }
    const form = pageJson('/signin/passkey/options', body, { contentType: 'text/plain' });
    expect((await handlePasskeyOptions(form, store.deps)).status).toBe(415);
    const crossSite = new Request(`${config.endpoints.issuer}/signin/passkey/options`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        'Sec-Fetch-Site': 'same-site',
      },
    });
    expect((await handlePasskeyOptions(crossSite, store.deps)).status).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it('give sign-in options with the configured relying party and user verification required', async () => {
    const store = fakeSignIn({
      createChallenge: async () => ({ outcome: 'created', registration: null, passkeys: [] }),
    });
    const response = await handlePasskeyOptions(
      pageJson('/signin/passkey/options', { ceremony: 'sign_in' }),
      store.deps
    );
    expect(response.status).toBe(200);
    const { options } = OptionsBodySchema.parse(await response.json());
    expect(options).toMatchObject({
      rpId: 'localhost',
      userVerification: 'required',
      allowCredentials: [],
    });
    const [call] = store.calls;
    expect(call.method).toBe('createChallenge');
    expect(call.input[0]).toMatchObject({
      ceremony: 'sign_in',
      rpId: 'localhost',
      sessionTokenHash: null,
    });
  });

  it('give registration options for the session with a resident key and the passkeys to exclude', async () => {
    const handle = crypto.getRandomValues(new Uint8Array(32));
    const existing = crypto.getRandomValues(new Uint8Array(32));
    const store = fakeSignIn({
      createChallenge: async () => ({
        outcome: 'created',
        registration: { accountEmail: 'user@example.com', userHandle: handle },
        passkeys: [{ credentialId: existing, transports: ['internal'] }],
      }),
    });
    expect(
      (
        await handlePasskeyOptions(
          pageJson('/signin/passkey/options', { ceremony: 'registration' }),
          store.deps
        )
      ).status
    ).toBe(401);
    const response = await handlePasskeyOptions(
      pageJson('/signin/passkey/options', { ceremony: 'registration' }, { cookie: COOKIE }),
      store.deps
    );
    const { options } = OptionsBodySchema.parse(await response.json());
    expect(options).toMatchObject({
      rp: { id: 'localhost' },
      user: { name: 'user@example.com', id: Buffer.from(handle).toString('base64url') },
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: [
        { id: Buffer.from(existing).toString('base64url'), transports: ['internal'] },
      ],
    });
  });

  it('map refused challenges to their answers', async () => {
    const store = fakeSignIn({ createChallenge: async () => ({ outcome: 'limit_reached' }) });
    const response = await handlePasskeyOptions(
      pageJson('/signin/passkey/options', { ceremony: 'registration' }, { cookie: COOKIE }),
      store.deps
    );
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('limit_reached');
  });

  it('refuse an assertion whose signature does not verify, and record the refusal', async () => {
    const challenge = randomCredential();
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN })
    ).toString('base64url');
    const userHandle = crypto.getRandomValues(new Uint8Array(32));
    const rawId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const store = fakeSignIn({
      readAssertion: async () => ({
        outcome: 'ok',
        passkeyId: crypto.randomUUID(),
        accountId: 'oauth/runtime-user',
        publicKey: new Uint8Array([1, 2, 3]),
        signCount: 0n,
        userHandle,
        transports: [],
      }),
      recordPasskeyFailure: async () => undefined,
    });
    const response = await handlePasskeyVerify(
      pageJson('/signin/passkey/verify', {
        ceremony: 'sign_in',
        response: {
          id: rawId,
          rawId,
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            clientDataJSON: clientData,
            authenticatorData: Buffer.alloc(37).toString('base64url'),
            signature: Buffer.alloc(64).toString('base64url'),
            userHandle: Buffer.from(userHandle).toString('base64url'),
          },
        },
      }),
      store.deps
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('passkey_refused');
    expect(store.calls.map(call => call.method)).toEqual(['readAssertion', 'recordPasskeyFailure']);
  });

  it('refuse a response without a valid challenge before any statement', async () => {
    const store = fakeSignIn();
    const response = await handlePasskeyVerify(
      pageJson('/signin/passkey/verify', {
        ceremony: 'sign_in',
        response: {
          id: 'AA',
          rawId: 'AA',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: 'AA', authenticatorData: 'AA', signature: 'AA' },
        },
      }),
      store.deps
    );
    expect(await errorOf(response)).toBe('unknown_challenge');
    expect(store.calls).toEqual([]);
  });
});

describe('device authorization', () => {
  const request = (fields: Record<string, string>) => formRequest('/device_authorization', fields);

  it('answers the RFC 8628 codes for the CLI with its canonical scopes', async () => {
    const store = fakeSignIn({
      createDeviceCode: async () => ({
        outcome: 'created',
        expiresAt: new Date(Date.now() + 600_000),
        interval: 5,
      }),
    });
    const response = await handleDeviceAuthorization(
      request({ client_id: 'kilo-cli', scope: 'kilo-chat:messages.read gateway:models.read' }),
      deviceDeps(store.deps)
    );
    expect(response.status).toBe(200);
    const body = DeviceAuthorizationResponseSchema.parse(await response.json());
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body.verification_uri).toBe(`${config.endpoints.issuer}/device`);
    expect(body.verification_uri_complete).toBe(
      `${body.verification_uri}?user_code=${body.user_code}`
    );
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBeGreaterThan(595);
    expect(store.calls[0].input[0]).toMatchObject({
      clientId: 'kilo-cli',
      scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
    });
  });

  it('refuses a client without the device grant, and a request without scopes', async () => {
    const store = fakeSignIn();
    expect(
      await errorOf(
        await handleDeviceAuthorization(
          request({ client_id: 'kilo-mobile', scope: 'gateway:models.read' }),
          deviceDeps(store.deps)
        )
      )
    ).toBe('unauthorized_client');
    expect(
      await errorOf(
        await handleDeviceAuthorization(request({ client_id: 'kilo-cli' }), deviceDeps(store.deps))
      )
    ).toBe('invalid_scope');
    expect(store.calls).toEqual([]);
  });

  it('draws another user code when one is taken, and gives up after three', async () => {
    const store = fakeSignIn({ createDeviceCode: async () => ({ outcome: 'user_code_taken' }) });
    const response = await handleDeviceAuthorization(
      request({ client_id: 'kilo-cli', scope: 'gateway:models.read' }),
      deviceDeps(store.deps)
    );
    expect(response.status).toBe(503);
    expect(store.calls).toHaveLength(3);
    const hashes = new Set(
      store.calls.map(call =>
        Buffer.from(UserCodeInputSchema.parse(call.input[0]).userCodeHash).toString('hex')
      )
    );
    expect(hashes.size).toBe(3);
  });

  it('answers 503 for a store failure a retry can fix', async () => {
    const store = fakeSignIn({
      createDeviceCode: async () => {
        throw storeFailure('retryable');
      },
    });
    expect(
      (
        await handleDeviceAuthorization(
          request({ client_id: 'kilo-cli', scope: 'gateway:models.read' }),
          deviceDeps(store.deps)
        )
      ).status
    ).toBe(503);
  });
});

describe('device verification page', () => {
  const pageUrl = (code?: string) =>
    `${config.endpoints.issuer}/device${code === undefined ? '' : `?user_code=${code}`}`;

  it('shows the sign-in page without a session cookie', async () => {
    const store = fakeSignIn();
    const response = await handleDevicePage(
      new Request(pageUrl('BCDF-GHJK')),
      deviceDeps(store.deps)
    );
    expect(await response.text()).toContain('Sign in with a passkey');
    expect(store.calls).toEqual([]);
  });

  it('shows what asks and from where, escaped, with one statement', async () => {
    const store = fakeSignIn({
      readDeviceCode: async () => ({
        outcome: 'pending',
        clientId: 'kilo-cli',
        scopes: ['gateway:models.read'],
        createdAt: new Date('2026-11-26T10:00:00Z'),
        expiresAt: new Date('2026-11-26T10:10:00Z'),
        userAgent: '<script>alert(1)</script>',
        country: 'DE',
        city: 'Berlin',
      }),
    });
    const response = await handleDevicePage(
      withCookie(pageUrl('bcdf ghjk')),
      deviceDeps(store.deps)
    );
    const html = await response.text();
    expect(html).toContain('BCDF-GHJK');
    expect(html).toContain('Kilo CLI');
    expect(html).toContain('Berlin, DE');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(store.calls.map(call => call.method)).toEqual(['readDeviceCode']);
  });

  it('answers an unknown code with the entry page and too many with 429', async () => {
    const unknown = fakeSignIn({ readDeviceCode: async () => ({ outcome: 'unknown_code' }) });
    expect(
      await (
        await handleDevicePage(withCookie(pageUrl('BCDF-GHJK')), deviceDeps(unknown.deps))
      ).text()
    ).toContain('unknown or has expired');
    const limited = fakeSignIn({ readDeviceCode: async () => ({ outcome: 'too_many_attempts' }) });
    expect(
      (await handleDevicePage(withCookie(pageUrl('BCDF-GHJK')), deviceDeps(limited.deps))).status
    ).toBe(429);
    const malformed = fakeSignIn();
    expect(
      await (
        await handleDevicePage(withCookie(pageUrl('AAAA-1111')), deviceDeps(malformed.deps))
      ).text()
    ).toContain('unknown or has expired');
    expect(malformed.calls).toEqual([]);
  });

  it('answers each decision outcome with its status', async () => {
    for (const [outcome, status] of [
      ['approved', 200],
      ['denied', 200],
      ['gate_required', 403],
      ['unknown_code', 404],
      ['too_many_attempts', 429],
      ['no_session', 401],
    ] as const) {
      const store = fakeSignIn({ decideDeviceCode: async () => outcome });
      const response = await handleDeviceDecision(
        pageJson('/device/decision', { user_code: 'BCDF-GHJK', approve: true }, { cookie: COOKIE }),
        deviceDeps(store.deps)
      );
      expect(response.status).toBe(status);
    }
    const crossOrigin = fakeSignIn();
    const refused = await handleDeviceDecision(
      pageJson(
        '/device/decision',
        { user_code: 'BCDF-GHJK', approve: true },
        { cookie: COOKIE, origin: 'https://evil.example' }
      ),
      deviceDeps(crossOrigin.deps)
    );
    expect(refused.status).toBe(403);
    expect(crossOrigin.calls).toEqual([]);
  });
});

describe('device grant at the token endpoint', () => {
  const deviceCode = randomCredential();
  const tokenRequest = async (clientId = 'kilo-cli', proof = true) =>
    formRequest(
      '/token',
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
      },
      proof ? { DPoP: await dpopProof(await dpopKey()) } : {}
    );
  const grant = (result: DeviceExchangeResult) => {
    const store = fakeSignIn({ exchangeDeviceCode: async () => result });
    return {
      store,
      grant: deviceCodeGrant({ config, sign: signerAccess(env, config) }, store.deps.signIn),
    };
  };
  const call = async (request: Request, result: DeviceExchangeResult) => {
    const { grant: hook, store } = grant(result);
    const response = await handleOAuthRequest(
      request,
      '/token',
      oauthDeps(fakeGrants().access, { device: { grant: hook, pages: deviceDeps(store.deps) } })
    );
    if (response === null) throw new Error('not served');
    return response;
  };

  it('answers the RFC 8628 errors before the user decided', async () => {
    for (const outcome of [
      'authorization_pending',
      'slow_down',
      'access_denied',
      'expired_token',
    ] as const) {
      const response = await call(await tokenRequest(), { outcome });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(outcome);
    }
    expect(await errorOf(await call(await tokenRequest(), { outcome: 'dpop_replay' }))).toBe(
      'invalid_dpop_proof'
    );
  });

  it('needs a DPoP proof and a client that uses the device grant', async () => {
    expect(
      await errorOf(await call(await tokenRequest('kilo-cli', false), { outcome: 'invalid_grant' }))
    ).toBe('invalid_dpop_proof');
    expect(
      await errorOf(await call(await tokenRequest('kilo-mobile'), { outcome: 'invalid_grant' }))
    ).toBe('unauthorized_client');
  });

  it('signs the tokens of an approved code and answers a refresh grant', async () => {
    const response = await call(await tokenRequest(), {
      outcome: 'issued',
      subjectId: 'oauth/runtime-user',
      orgId: null,
      authTime: new Date(Date.now() - 60_000),
      amr: ['passkey', 'device_grant'],
      tokenIds: [crypto.randomUUID()],
      scopes: ['gateway:models.read'],
      refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    expect(response.status).toBe(200);
    const body = TokenResponseSchema.parse(await response.json());
    expect(body.refresh_token).toMatch(/^kilo_rt_/);
    expect(body.refresh_token_expires_in).toBeGreaterThan(29 * 86_400);
  });
});

describe('one-time tickets', () => {
  const grantId = crypto.randomUUID();
  const refreshToken = createFirstPartyRefreshToken(grantId);
  const issueRequest = async (fields: Record<string, string> = {}, proof = true) =>
    formRequest(
      '/tickets',
      {
        client_id: 'kilo-cli',
        refresh_token: refreshToken,
        purpose: 'stream',
        resource: 'urn:kilo:service:kilo-chat',
        resource_id: 'session-1',
        ...fields,
      },
      proof ? { DPoP: await dpopProof(await dpopKey(), `${config.endpoints.issuer}/tickets`) } : {}
    );

  it('mint a 60-second ticket from the grant with a DPoP proof for the tickets URL', async () => {
    const store = fakeTickets({
      issue: async () => ({ outcome: 'issued', expiresAt: new Date(Date.now() + 60_000) }),
    });
    const response = await handleTicketIssue(await issueRequest(), store.deps);
    expect(response.status).toBe(200);
    const body = TicketResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ expires_in: 60, purpose: 'stream', audience: 'kilo-chat' });
    expect(store.calls[0].input[0]).toMatchObject({
      grantId,
      clientId: 'kilo-cli',
      audience: 'kilo-chat',
      purpose: 'stream',
      resource: 'session-1',
    });
  });

  it('refuse a sign-in ticket, another resource form, a token proof and a missing proof', async () => {
    const store = fakeTickets();
    expect(
      await errorOf(await handleTicketIssue(await issueRequest({ purpose: 'sign_in' }), store.deps))
    ).toBe('invalid_request');
    expect(
      await errorOf(
        await handleTicketIssue(await issueRequest({ resource: 'kilo-chat' }), store.deps)
      )
    ).toBe('invalid_target');
    expect(await errorOf(await handleTicketIssue(await issueRequest({}, false), store.deps))).toBe(
      'invalid_dpop_proof'
    );
    const tokenProof = formRequest(
      '/tickets',
      {
        client_id: 'kilo-cli',
        refresh_token: refreshToken,
        purpose: 'stream',
        resource: 'urn:kilo:service:kilo-chat',
      },
      { DPoP: await dpopProof(await dpopKey()) }
    );
    expect(await errorOf(await handleTicketIssue(tokenProof, store.deps))).toBe(
      'invalid_dpop_proof'
    );
    expect(store.calls).toEqual([]);
  });

  it('map the statement refusals', async () => {
    for (const [outcome, error] of [
      ['invalid_grant', 'invalid_grant'],
      ['invalid_target', 'invalid_target'],
      ['dpop_mismatch', 'invalid_grant'],
      ['dpop_replay', 'invalid_dpop_proof'],
    ] as const) {
      const store = fakeTickets({ issue: async () => ({ outcome }) });
      expect(await errorOf(await handleTicketIssue(await issueRequest(), store.deps))).toBe(error);
    }
  });

  const redeemedStore = () =>
    fakeTickets({
      redeem: async () => ({
        outcome: 'redeemed',
        accountId: 'oauth/runtime-user',
        purpose: 'stream',
        resource: 'session-1',
        orgId: null,
        grantId,
        clientId: 'kilo-cli',
      }),
    });

  it('redeem for a listed caller and one of its audiences', async () => {
    const store = redeemedStore();
    const result = await redeemTicket(
      store.deps,
      'uts-ticket-test',
      randomCredential(),
      'kilo-chat'
    );
    if (result.status !== 'redeemed') throw new Error('expected a redemption');
    expect(TicketRedemptionSchema.parse(result.redemption)).toEqual({
      sub: 'oauth/runtime-user',
      sid: grantId,
      client_id: 'kilo-cli',
      purpose: 'stream',
      audience: 'kilo-chat',
      resource: 'session-1',
    });
  });

  it('refuse an unlisted caller, a binding without props and an audience not the caller’s, before any statement', async () => {
    const store = redeemedStore();
    const ticket = randomCredential();
    expect(await redeemTicket(store.deps, 'o11y', ticket, 'kilo-chat')).toEqual({
      status: 'refused',
    });
    expect(await redeemTicket(store.deps, null, ticket, 'kilo-chat')).toEqual({
      status: 'refused',
    });
    expect(await redeemTicket(store.deps, 'uts-ticket-test', ticket, 'session-ingest')).toEqual({
      status: 'refused',
    });
    expect(await redeemTicket(store.deps, 'uts-ticket-test', ticket, 42)).toEqual({
      status: 'refused',
    });
    expect(store.calls).toEqual([]);
  });

  it('refuse every caller in production and staging, whose redeemer lists are empty', async () => {
    for (const environment of ['production', 'staging'] as const) {
      expect(TICKET_REDEEMERS[environment]).toEqual({});
      const store = fakeTickets();
      const deps = { ...store.deps, config: { ...config, environment } };
      expect(await redeemTicket(deps, 'uts-ticket-test', randomCredential(), 'kilo-chat')).toEqual({
        status: 'refused',
      });
      expect(store.calls).toEqual([]);
    }
  });

  it('answer invalid_ticket alike for a malformed or unknown ticket, and 503-style failures by class', async () => {
    const unknown = fakeTickets({ redeem: async () => ({ outcome: 'unknown' }) });
    expect(await redeemTicket(unknown.deps, 'uts-ticket-test', 'short', 'kilo-chat')).toEqual({
      status: 'invalid_ticket',
    });
    expect(
      await redeemTicket(unknown.deps, 'uts-ticket-test', randomCredential(), 'kilo-chat')
    ).toEqual({
      status: 'invalid_ticket',
    });
    const failing = fakeTickets({
      redeem: async () => {
        throw storeFailure('retryable');
      },
    });
    expect(
      await redeemTicket(failing.deps, 'uts-ticket-test', randomCredential(), 'kilo-chat')
    ).toEqual({
      status: 'unavailable',
    });
  });

  it('read the caller from the binding props of the TicketRedeemer entrypoint', async () => {
    // An unlisted caller is refused before the identity store is touched; the listed one passes
    // the caller check and reaches the store, which the test pool cannot connect to.
    expect(await env.OTHER_REDEEMER.redeem(randomCredential(), 'kilo-chat')).toEqual({
      status: 'refused',
    });
    const listed = await env.TICKET_REDEEMER.redeem(randomCredential(), 'kilo-chat');
    expect(['unavailable', 'failed']).toContain(listed.status);
  });

  it('are not redeemable over the internet', async () => {
    expect(
      await handleOAuthRequest(
        formRequest('/tickets/redeem', { ticket: randomCredential(), audience: 'kilo-chat' }),
        '/tickets/redeem',
        oauthDeps(fakeGrants().access)
      )
    ).toBeNull();
  });
});

describe('sign-in routes', () => {
  it('serve the page script from the issuer origin with its type', async () => {
    const response = await handleOAuthRequest(
      new Request(`${config.endpoints.issuer}/signin/assets/signin.js`),
      '/signin/assets/signin.js',
      oauthDeps(fakeGrants().access)
    );
    expect(response?.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await response?.text()).toContain('navigator.credentials.get');
  });

  it('do not serve the device pages without the user-code secret', async () => {
    for (const path of ['/device_authorization', '/device', '/device/decision']) {
      expect(
        await handleOAuthRequest(
          new Request(`${config.endpoints.issuer}${path}`),
          path,
          oauthDeps(fakeGrants().access)
        )
      ).toBeNull();
    }
  });
});
