import type { MintBinding } from '@kilocode/service-token-client';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { glanceableDeliveryDeps } from './glanceable-delivery-deps';
import {
  GLANCEABLE_SNAPSHOT_READ,
  WEB_PRODUCTION_ORIGIN,
  glanceableSnapshotAuth,
  type GlanceableSnapshotAuthEnv,
} from './glanceable-snapshot-auth';

const SECRET = 'internal-fixture-0123456789abcdef';
const TOKEN = 'minted.web.token';
const USER_ID = 'user-snapshot-fixture';
const SNAPSHOT_URL = `${WEB_PRODUCTION_ORIGIN}/api/internal/glanceable-agents-snapshot`;

function issue(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued' as const,
      audience,
      scope,
      token: TOKEN,
      jti: 'jti-snapshot',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

function deny(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'denied' as const,
      audience,
      scope,
      reason: 'unknown_scope' as const,
    })),
  };
}

/**
 * A fresh `SecretsBroker` binding per case, so no case reads another's held token. The bundle
 * method is never called on the token path.
 */
function mintBinding(answer: (request: MintRequest) => MintResult | Promise<MintResult>) {
  const mintTokens = vi.fn(async (request: MintRequest) => answer(request));
  return { mintTokens, getBundle: vi.fn() };
}

function storeSecret(value: string) {
  return { get: vi.fn(async () => value) };
}

function lifetime() {
  return { waitUntil: vi.fn() };
}

function authEnv(vars: Partial<GlanceableSnapshotAuthEnv>): GlanceableSnapshotAuthEnv {
  return { SECRETS_SOURCE: 'secrets-store', ...vars };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('glanceableSnapshotAuth', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['sts', 'sts'],
  ])(
    'sends only a web snapshot token when the switch is %s',
    async (_label, GLANCEABLE_SNAPSHOT_SENDER_AUTH) => {
      const STS = mintBinding(issue);
      const internal = storeSecret(SECRET);
      const env = authEnv({ GLANCEABLE_SNAPSHOT_SENDER_AUTH, STS, INTERNAL_API_SECRET: internal });

      const auth = await glanceableSnapshotAuth(env, WEB_PRODUCTION_ORIGIN, lifetime());

      expect(auth).toEqual({ kind: 'headers', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(STS.mintTokens).toHaveBeenCalledWith({ tokens: [GLANCEABLE_SNAPSHOT_READ] });
      expect(internal.get).not.toHaveBeenCalled();
    }
  );

  it('sends the internal secret under legacy and never mints', async () => {
    const STS = mintBinding(issue);
    const internal = storeSecret(SECRET);
    const env = authEnv({
      GLANCEABLE_SNAPSHOT_SENDER_AUTH: 'legacy',
      STS,
      INTERNAL_API_SECRET: internal,
    });

    const auth = await glanceableSnapshotAuth(env, WEB_PRODUCTION_ORIGIN, lifetime());

    expect(auth).toEqual({ kind: 'headers', headers: { 'x-internal-secret': SECRET } });
    expect(STS.mintTokens).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', storeSecret('')],
    ['unbound', undefined],
  ])('reports a %s internal secret under legacy', async (_label, INTERNAL_API_SECRET) => {
    const env = authEnv({ GLANCEABLE_SNAPSHOT_SENDER_AUTH: 'legacy', INTERNAL_API_SECRET });

    expect(await glanceableSnapshotAuth(env, WEB_PRODUCTION_ORIGIN, lifetime())).toEqual({
      kind: 'unavailable',
      reason: 'internal_secret_missing',
    });
  });

  it.each(['STS', 'Legacy', 'secrets-store', 'both'])(
    'refuses the unknown switch value %s without minting or reading the secret',
    async value => {
      const STS = mintBinding(issue);
      const internal = storeSecret(SECRET);
      const env = authEnv({
        GLANCEABLE_SNAPSHOT_SENDER_AUTH: value,
        STS,
        INTERNAL_API_SECRET: internal,
      });

      expect(await glanceableSnapshotAuth(env, WEB_PRODUCTION_ORIGIN, lifetime())).toEqual({
        kind: 'unavailable',
        reason: 'invalid_auth',
      });
      expect(STS.mintTokens).not.toHaveBeenCalled();
      expect(internal.get).not.toHaveBeenCalled();
    }
  );

  it.each([
    'https://snapshot.test',
    'http://app.kilo.ai',
    'https://app.kilo.ai.evil.test',
    'https://staging-app.kilo.ai',
    'not a url',
  ])('never mints a token for the base URL %s', async baseUrl => {
    const STS = mintBinding(issue);
    const env = authEnv({ STS });

    expect(await glanceableSnapshotAuth(env, baseUrl, lifetime())).toEqual({
      kind: 'unavailable',
      reason: 'origin_mismatch',
    });
    expect(STS.mintTokens).not.toHaveBeenCalled();
  });

  it('accepts a base URL with a path on the production origin', async () => {
    const env = authEnv({ STS: mintBinding(issue) });

    expect(await glanceableSnapshotAuth(env, `${WEB_PRODUCTION_ORIGIN}/`, lifetime())).toEqual({
      kind: 'headers',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  });

  it('reports a missing STS binding under sts and never reads the secret', async () => {
    const internal = storeSecret(SECRET);
    const env = authEnv({ INTERNAL_API_SECRET: internal });

    expect(await glanceableSnapshotAuth(env, WEB_PRODUCTION_ORIGIN, lifetime())).toEqual({
      kind: 'unavailable',
      reason: 'sts_binding_missing',
    });
    expect(internal.get).not.toHaveBeenCalled();
  });

  it('reports a denied token with its reason and no fallback', async () => {
    const internal = storeSecret(SECRET);
    const env = authEnv({ STS: mintBinding(deny), INTERNAL_API_SECRET: internal });

    expect(await glanceableSnapshotAuth(env, WEB_PRODUCTION_ORIGIN, lifetime())).toEqual({
      kind: 'unavailable',
      reason: 'token_denied',
      deniedReason: 'unknown_scope',
    });
    expect(internal.get).not.toHaveBeenCalled();
  });

  it('reports an unanswered mint as unavailable', async () => {
    const env = authEnv({
      STS: mintBinding(() => ({ status: 'unavailable', retryAfterSeconds: 5 })),
    });

    expect(await glanceableSnapshotAuth(env, WEB_PRODUCTION_ORIGIN, lifetime())).toEqual({
      kind: 'unavailable',
      reason: 'token_unavailable',
    });
  });
});

describe('glanceable snapshot request under sts', () => {
  function serviceEnv(STS: MintBinding) {
    return {
      HYPERDRIVE: { connectionString: 'postgres://unused' },
      KILO_WEB_API_BASE_URL: WEB_PRODUCTION_ORIGIN,
      INTERNAL_API_SECRET: storeSecret(SECRET),
      STS,
    };
  }

  function respond(response: Response) {
    const requests: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers) });
      return response;
    });
    return requests;
  }

  it('presents the token and no internal secret', async () => {
    const requests = respond(new Response(null, { status: 503 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await glanceableDeliveryDeps(serviceEnv(mintBinding(issue)) as never, lifetime()).buildSnapshot(
      USER_ID,
      null
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(SNAPSHOT_URL);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].headers.has('x-internal-secret')).toBe(false);
  });

  it('sends nothing without a token and logs only closed reasons', async () => {
    const requests = respond(new Response(null, { status: 200 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await glanceableDeliveryDeps(
      serviceEnv(mintBinding(deny)) as never,
      lifetime()
    ).buildSnapshot(USER_ID, null);

    expect(result).toBeNull();
    expect(requests).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Glanceable snapshot credential unavailable; skipping aggregate delivery',
      { reason: 'token_denied', deniedReason: 'unknown_scope' }
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it('keeps the cards when the route refuses the credential with a challenge', async () => {
    respond(
      new Response(null, {
        status: 403,
        headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' },
      })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      await glanceableDeliveryDeps(
        serviceEnv(mintBinding(issue)) as never,
        lifetime()
      ).buildSnapshot(USER_ID, 'org-fixture')
    ).toBeNull();
  });

  it('ends the cards on a membership refusal without a challenge', async () => {
    respond(new Response(null, { status: 403 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      await glanceableDeliveryDeps(
        serviceEnv(mintBinding(issue)) as never,
        lifetime()
      ).buildSnapshot(USER_ID, 'org-fixture')
    ).toBe('access_denied');
  });
});
