import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  detectRefreshTokenReuse,
  forwardWithRefreshReuseDetection,
  hashRefreshToken,
  parseRefreshToken,
  rememberIssuedRefreshToken,
  type RefreshReuseKv,
} from './refresh-reuse';

/** In-memory KV standing in for OAUTH_KV. */
type FakeKv = RefreshReuseKv & { store: Map<string, string> };

type RevokeGrant = (grantId: string, userId: string) => Promise<void>;

function makeKv(initial: Record<string, string> = {}): FakeKv {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function token(userId: string, grantId: string, secret: string): string {
  return `${userId}:${grantId}:${secret}`;
}

function refreshRequest(refreshToken: string, origin?: string): Request {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: 'client-1',
  }).toString();
  return new Request('https://kilo-mcp.test/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(origin ? { Origin: origin } : {}),
    },
    body,
  });
}

function makeDeps(): { kv: FakeKv; revokeGrant: Mock<RevokeGrant> } {
  return {
    kv: makeKv(),
    revokeGrant: vi.fn<RevokeGrant>().mockResolvedValue(undefined),
  };
}

describe('parseRefreshToken', () => {
  it('splits the library token format into user and grant', () => {
    expect(parseRefreshToken('user-1:grant-1:secret')).toEqual({
      userId: 'user-1',
      grantId: 'grant-1',
    });
  });

  it('rejects tokens that are not three non-empty parts', () => {
    expect(parseRefreshToken('nope')).toBeNull();
    expect(parseRefreshToken('a:b')).toBeNull();
    expect(parseRefreshToken('a:b:c:d')).toBeNull();
    expect(parseRefreshToken(':grant:secret')).toBeNull();
    expect(parseRefreshToken('user::secret')).toBeNull();
  });
});

describe('detectRefreshTokenReuse', () => {
  it('ignores requests that are not a POST to the token endpoint', async () => {
    const deps = makeDeps();
    expect(
      await detectRefreshTokenReuse(
        new Request('https://kilo-mcp.test/mcp', { method: 'POST', body: 'x' }),
        deps
      )
    ).toBeNull();
    expect(
      await detectRefreshTokenReuse(new Request('https://kilo-mcp.test/token'), deps)
    ).toBeNull();
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('ignores non-refresh grants and missing or malformed tokens', async () => {
    const deps = makeDeps();
    const codeExchange = new Request('https://kilo-mcp.test/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'c',
        refresh_token: 'a:b:c',
      }).toString(),
    });
    expect(await detectRefreshTokenReuse(codeExchange, deps)).toBeNull();

    const noToken = new Request('https://kilo-mcp.test/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token' }).toString(),
    });
    expect(await detectRefreshTokenReuse(noToken, deps)).toBeNull();

    expect(await detectRefreshTokenReuse(refreshRequest('not-a-token'), deps)).toBeNull();
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('allows the first refresh of a grant (nothing recorded yet)', async () => {
    const deps = makeDeps();
    expect(await detectRefreshTokenReuse(refreshRequest(token('u', 'g', 's1')), deps)).toBeNull();
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('allows the refresh token the server most recently issued', async () => {
    const current = token('u', 'g', 's2');
    const kv = makeKv({ [`refresh-latest:u:g`]: await hashRefreshToken(current) });
    const revokeGrant = vi.fn<RevokeGrant>().mockResolvedValue(undefined);
    expect(await detectRefreshTokenReuse(refreshRequest(current), { kv, revokeGrant })).toBeNull();
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('rejects a superseded token, revokes the grant, and answers invalid_grant', async () => {
    const superseded = token('u', 'g', 's1');
    const kv = makeKv({ [`refresh-latest:u:g`]: await hashRefreshToken(token('u', 'g', 's2')) });
    const revokeGrant = vi.fn<RevokeGrant>().mockResolvedValue(undefined);

    const response = await detectRefreshTokenReuse(
      refreshRequest(superseded, 'https://client.test'),
      {
        kv,
        revokeGrant,
      }
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    expect(response!.headers.get('Content-Type')).toBe('application/json');
    expect(response!.headers.get('Cache-Control')).toBe('no-store');
    expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('https://client.test');
    expect(await response!.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token reuse detected; the grant has been revoked.',
    });
    expect(revokeGrant).toHaveBeenCalledTimes(1);
    expect(revokeGrant).toHaveBeenCalledWith('g', 'u');
  });
});

describe('rememberIssuedRefreshToken', () => {
  it('stores the hash of the issued refresh token on a successful response', async () => {
    const deps = makeDeps();
    const issued = token('u', 'g', 's2');
    await rememberIssuedRefreshToken(
      new Response(JSON.stringify({ refresh_token: issued }), { status: 200 }),
      deps
    );
    expect(deps.kv.store.get('refresh-latest:u:g')).toBe(await hashRefreshToken(issued));
  });

  it('stores a hash, never the token itself', async () => {
    const deps = makeDeps();
    const issued = token('u', 'g', 's2');
    await rememberIssuedRefreshToken(
      new Response(JSON.stringify({ refresh_token: issued }), { status: 200 }),
      deps
    );
    expect(deps.kv.store.get('refresh-latest:u:g')).not.toContain(issued);
  });

  it('ignores error responses, refusals, and bodies without a refresh token', async () => {
    const deps = makeDeps();
    await rememberIssuedRefreshToken(new Response('{}', { status: 400 }), deps);
    await rememberIssuedRefreshToken(new Response('not json', { status: 200 }), deps);
    await rememberIssuedRefreshToken(
      new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }),
      deps
    );
    expect(deps.kv.store.size).toBe(0);
  });
});

describe('forwardWithRefreshReuseDetection', () => {
  it('records the issued token so the same token refreshes again, then rejects a replay', async () => {
    const deps = makeDeps();
    const issuedFirst = token('u', 'g', 's1');
    const issuedSecond = token('u', 'g', 's2');

    const forward = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: issuedFirst })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ refresh_token: issuedSecond })));

    // 1. Authorization-code exchange: no reuse check, records s1.
    await forwardWithRefreshReuseDetection(
      new Request('https://kilo-mcp.test/token', {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c' }).toString(),
      }),
      forward,
      deps
    );

    // 2. Refresh with s1: matches the record, allowed, records s2.
    const ok = await forwardWithRefreshReuseDetection(refreshRequest(issuedFirst), forward, deps);
    expect(ok.status).toBe(200);

    // 3. Replay s1: superseded -> rejected, revoked, library never called.
    const replay = await forwardWithRefreshReuseDetection(
      refreshRequest(issuedFirst),
      forward,
      deps
    );
    expect(replay.status).toBe(400);
    expect(deps.revokeGrant).toHaveBeenCalledWith('g', 'u');
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it('passes non-token requests straight through', async () => {
    const deps = makeDeps();
    const forward = vi.fn().mockResolvedValue(new Response('ok'));
    const response = await forwardWithRefreshReuseDetection(
      new Request('https://kilo-mcp.test/mcp', { method: 'POST', body: '{}' }),
      forward,
      deps
    );
    expect(await response.text()).toBe('ok');
    expect(forward).toHaveBeenCalledTimes(1);
    expect(deps.kv.store.size).toBe(0);
  });
});
