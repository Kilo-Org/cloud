import { describe, expect, it, vi } from 'vitest';
import {
  createRefreshReuseHandler,
  detectRefreshTokenReuse,
  hashRefreshToken,
  parseRefreshToken,
  rememberIssuedRefreshToken,
  type IssuedRefreshToken,
  type RefreshReuseStore,
} from './refresh-reuse';

function makeDeps() {
  const tokens = new Map<string, IssuedRefreshToken>();
  const store: RefreshReuseStore = {
    getRefreshToken: async hash => tokens.get(hash) ?? null,
    rememberRefreshToken: async (hash, parts) => {
      for (const token of tokens.values()) {
        if (token.userId === parts.userId && token.grantId === parts.grantId) token.current = false;
      }
      tokens.set(hash, { ...parts, current: true });
    },
  };
  return { tokens, store, revokeGrant: vi.fn(async (_grantId: string, _userId: string) => {}) };
}

function refreshRequest(refreshToken: string, origin?: string): Request {
  return new Request('https://kilo-mcp.test/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(origin ? { Origin: origin } : {}),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'client-1',
    }),
  });
}

describe('parseRefreshToken', () => {
  it('splits the library token format into user and grant', () => {
    expect(parseRefreshToken('user-1:grant-1:secret')).toEqual({
      userId: 'user-1',
      grantId: 'grant-1',
    });
  });

  it.each(['nope', 'a:b', 'a:b:c:d', ':grant:secret', 'user::secret', 'user:grant:'])(
    'rejects malformed token %s',
    token => expect(parseRefreshToken(token)).toBeNull()
  );
});

describe('detectRefreshTokenReuse', () => {
  it('does not revoke a grant when only its public token parts match', async () => {
    const deps = makeDeps();
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:real' }), deps);
    expect(await detectRefreshTokenReuse(refreshRequest('u:g:forged'), deps)).toBeNull();
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('leaves unknown and malformed tokens to the library', async () => {
    const deps = makeDeps();
    for (const token of ['u:g:first', 'nope', 'u:g:']) {
      expect(await detectRefreshTokenReuse(refreshRequest(token), deps)).toBeNull();
    }
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('allows the current token but revokes on a known superseded token', async () => {
    const deps = makeDeps();
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:second' }), deps);
    expect(await detectRefreshTokenReuse(refreshRequest('u:g:second'), deps)).toBeNull();
    const response = await detectRefreshTokenReuse(
      refreshRequest('u:g:first', 'https://client.test'),
      deps
    );
    expect(response?.status).toBe(400);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://client.test');
    expect(await response?.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token reuse detected; the grant has been revoked.',
    });
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('g', 'u');
  });

  it('uses the stored identity rather than parsing the presented token for revocation', async () => {
    const deps = makeDeps();
    deps.tokens.set(await hashRefreshToken('not:trusted:parts'), {
      userId: 'stored-user',
      grantId: 'stored-grant',
      current: false,
    });
    await detectRefreshTokenReuse(refreshRequest('not:trusted:parts'), deps);
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('stored-grant', 'stored-user');
  });

  it('leaves wrong media types, ambiguous parameters and non-refresh requests to the library', async () => {
    const deps = makeDeps();
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:second' }), deps);
    for (const request of [
      new Request('https://kilo-mcp.test/token'),
      new Request('https://kilo-mcp.test/mcp', { method: 'POST', body: '{}' }),
      new Request('https://kilo-mcp.test/token', {
        method: 'POST',
        body: 'grant_type=refresh_token&refresh_token=u:g:first',
      }),
      new Request('https://kilo-mcp.test/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=u:g:first&refresh_token=u:g:second',
      }),
      new Request('https://kilo-mcp.test/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&refresh_token=u:g:first',
      }),
      refreshRequest(''),
    ]) {
      expect(await detectRefreshTokenReuse(request, deps)).toBeNull();
    }
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });
});

describe('rememberIssuedRefreshToken', () => {
  it('stores full token hashes only, isolating grants and users', async () => {
    const deps = makeDeps();
    for (const token of ['u:g:first', 'u:other:secret', 'other:g:secret', 'u:g:second']) {
      await rememberIssuedRefreshToken(Response.json({ refresh_token: token }), deps);
      expect(deps.tokens.has(token)).toBe(false);
    }
    expect(deps.tokens.get(await hashRefreshToken('u:g:first'))?.current).toBe(false);
    for (const token of ['u:other:secret', 'other:g:secret', 'u:g:second']) {
      expect(deps.tokens.get(await hashRefreshToken(token))?.current).toBe(true);
    }
  });

  it('ignores failed, empty and malformed token responses', async () => {
    const deps = makeDeps();
    for (const response of [
      Response.json({ refresh_token: 'u:g:first' }, { status: 503 }),
      new Response('not json'),
      Response.json({ access_token: 'access' }),
      Response.json({ refresh_token: 1 }),
      Response.json({ refresh_token: 'malformed' }),
    ])
      await rememberIssuedRefreshToken(response, deps);
    expect(deps.tokens.size).toBe(0);
  });
});

describe('createRefreshReuseHandler (one per named DO)', () => {
  it('never issues two rotations for concurrent uses of the same token', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:current' }), deps);
    let issued = 0;
    const forward = vi.fn(async () => Response.json({ refresh_token: `u:g:next-${++issued}` }));
    const responses = await Promise.all([
      handle(refreshRequest('u:g:current'), forward),
      handle(refreshRequest('u:g:current'), forward),
    ]);
    expect(responses.filter(response => response.ok)).toHaveLength(1);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('g', 'u');
  });

  it.each(['/mcp', '/register', '/authorize', '/.well-known/oauth-authorization-server', '/token'])(
    'never clones an unrelated response body (%s GET)',
    async path => {
      const deps = makeDeps();
      const response = Response.json({ refresh_token: 'u:g:must-not-be-recorded' });
      const clone = vi.spyOn(response, 'clone');
      expect(
        await createRefreshReuseHandler(deps)(
          new Request(`https://kilo-mcp.test${path}`),
          async () => response
        )
      ).toBe(response);
      expect(clone).not.toHaveBeenCalled();
      expect(deps.tokens.size).toBe(0);
    }
  );

  it('records code exchange, accepts successive rotations and rejects old history after recreation', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    await handle(
      new Request('https://kilo-mcp.test/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=code',
      }),
      async () => Response.json({ refresh_token: 'u:g:first' })
    );
    expect(
      (
        await handle(refreshRequest('u:g:first'), async () =>
          Response.json({ refresh_token: 'u:g:second' })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await handle(refreshRequest('u:g:second'), async () =>
          Response.json({ refresh_token: 'u:g:third' })
        )
      ).status
    ).toBe(200);
    const forward = vi.fn();
    const replay = await createRefreshReuseHandler(deps)(refreshRequest('u:g:first'), forward);
    expect(replay.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('g', 'u');
  });

  it('a failed exchange does not poison the queue or consume the token, and retry succeeds', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:current' }), deps);
    await expect(
      handle(refreshRequest('u:g:current'), async () => {
        throw new Error('storage unavailable');
      })
    ).rejects.toThrow('storage unavailable');
    expect(
      (
        await handle(refreshRequest('u:g:current'), async () =>
          Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
        )
      ).status
    ).toBe(503);
    expect(
      (
        await handle(refreshRequest('u:g:current'), async () =>
          Response.json({ refresh_token: 'u:g:next' })
        )
      ).status
    ).toBe(200);
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('does not release an issued response before its history is durable', async () => {
    const deps = makeDeps();
    let fail = true;
    const remember = deps.store.rememberRefreshToken.bind(deps.store);
    deps.store.rememberRefreshToken = async (...args) => {
      if (fail) throw new Error('history unavailable');
      return remember(...args);
    };
    const handle = createRefreshReuseHandler(deps);
    const forward = async () => Response.json({ refresh_token: 'u:g:next' });
    await expect(handle(refreshRequest('u:g:current'), forward)).rejects.toThrow(
      'history unavailable'
    );
    fail = false;
    expect((await handle(refreshRequest('u:g:current'), forward)).status).toBe(200);
  });
});
