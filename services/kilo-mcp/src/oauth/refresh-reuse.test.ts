import { describe, expect, it, vi } from 'vitest';
import { REFRESH_TOKEN_REUSE_DETAIL } from '../analytics';
import type { McpAnalytics } from '../analytics';
import {
  createRefreshReuseHandler,
  detectRefreshTokenReuse,
  hashRefreshToken,
  parseRefreshToken,
  parseTokenUserId,
  readTokenBody,
  rememberIssuedRefreshToken,
  type IssuedRefreshToken,
  type RefreshReuseDeps,
  type RefreshReuseStore,
} from './refresh-reuse';

function makeDeps() {
  const tokens = new Map<string, IssuedRefreshToken>();
  const store: RefreshReuseStore = {
    getRefreshToken: async hash => tokens.get(hash) ?? null,
    rememberRefreshToken: async (hash, parts, _expiresAt, presentedHash) => {
      for (const token of tokens.values()) {
        if (token.userId === parts.userId && token.grantId === parts.grantId) {
          token.current = false;
          token.previous = false;
        }
      }
      if (presentedHash !== null) {
        const presented = tokens.get(presentedHash);
        if (presented?.userId === parts.userId && presented.grantId === parts.grantId) {
          presented.previous = true;
        }
      }
      tokens.set(hash, { ...parts, current: true, previous: false });
    },
    forgetRefreshTokens: async parts => {
      for (const [hash, token] of tokens) {
        if (token.userId === parts.userId && token.grantId === parts.grantId) tokens.delete(hash);
      }
    },
  };
  return { tokens, store, revokeGrant: vi.fn(async (_grantId: string, _userId: string) => {}) };
}

/**
 * The same store as `makeDeps`, but it honours the `expiresAt` the guard
 * passes and the `nowIso` it reads with: a row is returned only while the
 * clock has not passed it. `makeDeps` ignores both forever, so it cannot show
 * whether the history outlives the grant.
 */
function makeTtlDeps() {
  const rows = new Map<string, IssuedRefreshToken & { expiresAt: string }>();
  const store: RefreshReuseStore = {
    getRefreshToken: async (hash, nowIso) => {
      const row = rows.get(hash);
      if (!row || row.expiresAt <= nowIso) return null;
      return {
        userId: row.userId,
        grantId: row.grantId,
        current: row.current,
        previous: row.previous,
      };
    },
    rememberRefreshToken: async (hash, parts, expiresAt, presentedHash) => {
      for (const row of rows.values()) {
        if (row.userId === parts.userId && row.grantId === parts.grantId) {
          row.current = false;
          row.previous = false;
        }
      }
      if (presentedHash !== null) {
        const presented = rows.get(presentedHash);
        if (presented?.userId === parts.userId && presented.grantId === parts.grantId) {
          presented.previous = true;
          presented.expiresAt = expiresAt;
        }
      }
      rows.set(hash, { ...parts, current: true, previous: false, expiresAt });
    },
    forgetRefreshTokens: async parts => {
      for (const [hash, row] of rows) {
        if (row.userId === parts.userId && row.grantId === parts.grantId) rows.delete(hash);
      }
    },
  };
  return {
    rows,
    store,
    revokeGrant: vi.fn(async (_grantId: string, _userId: string) => {}),
  };
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

function codeRequest(): Request {
  return new Request('https://kilo-mcp.test/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code&code=code',
  });
}

/** The handler's steps in order: read the body, then decide. */
async function guard(request: Request, deps: RefreshReuseDeps): Promise<Response | null> {
  const body = await readTokenBody(request);
  return body.kind === 'form' ? detectRefreshTokenReuse(request, body.params, deps) : null;
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

describe('parseTokenUserId', () => {
  it('returns the account id in a well-formed token prefix', () => {
    expect(parseTokenUserId('user-1:grant-1:secret')).toBe('user-1');
  });

  it('caps the id and rejects anything malformed', () => {
    expect(parseTokenUserId(`u${'x'.repeat(128)}:grant:secret`)).toBeNull();
    expect(parseTokenUserId(`u${'x'.repeat(127)}:grant:secret`)).toBe(`u${'x'.repeat(127)}`);
    for (const token of ['nope', 'a:b', ':grant:secret', 'user:grant:']) {
      expect(parseTokenUserId(token)).toBeNull();
    }
  });
});

describe('detectRefreshTokenReuse', () => {
  it('does not revoke a grant when only its public token parts match', async () => {
    const deps = makeDeps();
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:real' }), deps);
    expect(await guard(refreshRequest('u:g:forged'), deps)).toBeNull();
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('leaves unknown and malformed tokens to the library', async () => {
    const deps = makeDeps();
    for (const token of ['u:g:first', 'nope', 'u:g:']) {
      expect(await guard(refreshRequest(token), deps)).toBeNull();
    }
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('accepts the token the provider rotated away from and keeps its successor current', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    await handle(codeRequest(), async () => Response.json({ refresh_token: 'u:g:first' }));
    expect(
      (
        await handle(refreshRequest('u:g:first'), async () =>
          Response.json({ refresh_token: 'u:g:second' })
        )
      ).status
    ).toBe(200);
    // The provider accepts the current and the immediately previous token, so
    // this rotation is the tolerated race/lost-response case, not a replay.
    expect(
      (
        await handle(refreshRequest('u:g:first'), async () =>
          Response.json({ refresh_token: 'u:g:third' })
        )
      ).status
    ).toBe(200);
    expect(deps.revokeGrant).not.toHaveBeenCalled();
    expect(deps.tokens.get(await hashRefreshToken('u:g:third'))?.current).toBe(true);
    expect(deps.tokens.get(await hashRefreshToken('u:g:first'))?.previous).toBe(true);
    expect(deps.tokens.get(await hashRefreshToken('u:g:second'))?.current).toBe(false);
    expect(deps.tokens.get(await hashRefreshToken('u:g:second'))?.previous).toBe(false);
  });

  it('revokes a token older than the previous one and answers with the reuse error', async () => {
    const deps = makeDeps();
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:second' }),
      deps,
      'u:g:first'
    );
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:third' }),
      deps,
      'u:g:second'
    );
    const response = await guard(refreshRequest('u:g:first', 'https://client.test'), deps);
    expect(response?.status).toBe(400);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('https://client.test');
    expect(await response?.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token reuse detected; the grant has been revoked.',
    });
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('g', 'u');
  });

  it('revokes the token a previous-token acceptance superseded', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    // R1 is presented while R2 is current, so the provider issues R3 and keeps
    // R1 acceptable; R2 is now neither token the provider accepts.
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:second' }),
      deps,
      'u:g:first'
    );
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:third' }),
      deps,
      'u:g:first'
    );

    // R1 is the previous token again, so presenting it is forwarded.
    expect(
      (
        await handle(refreshRequest('u:g:first'), async () =>
          Response.json({ refresh_token: 'u:g:fourth' })
        )
      ).status
    ).toBe(200);
    expect(deps.revokeGrant).not.toHaveBeenCalled();

    // R2 is neither current nor previous — the provider would refuse it, so
    // the guard revokes instead of forwarding a doomed request.
    const middle = await guard(refreshRequest('u:g:second'), deps);
    expect(middle?.status).toBe(400);
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('g', 'u');
  });

  it('forgets the revoked grant’s hashes and leaves a live grant’s alone', async () => {
    const deps = makeDeps();
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:second' }),
      deps,
      'u:g:first'
    );
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:third' }),
      deps,
      'u:g:second'
    );
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:other:live' }), deps);

    expect(await guard(refreshRequest('u:g:first'), deps)).not.toBeNull();

    // A revoked grant's hashes can never authenticate another replay, so they
    // are dropped with the revocation instead of waiting for the history TTL.
    expect(deps.tokens.has(await hashRefreshToken('u:g:first'))).toBe(false);
    expect(deps.tokens.has(await hashRefreshToken('u:g:third'))).toBe(false);
    expect([...deps.tokens.values()].map(token => token.grantId)).toEqual(['other']);
  });

  it('uses the stored identity rather than parsing the presented token for revocation', async () => {
    const deps = makeDeps();
    deps.tokens.set(await hashRefreshToken('not:trusted:parts'), {
      userId: 'stored-user',
      grantId: 'stored-grant',
      current: false,
      previous: false,
    });
    await guard(refreshRequest('not:trusted:parts'), deps);
    expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('stored-grant', 'stored-user');
  });

  it('still detects a token older than the previous one late in the one-month session', async () => {
    vi.useFakeTimers();
    try {
      // Day 0: the code exchange issues the first token, then two rotations.
      vi.setSystemTime(Date.UTC(2026, 0, 1, 12));
      const deps = makeTtlDeps();
      await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
      await rememberIssuedRefreshToken(
        Response.json({ refresh_token: 'u:g:second' }),
        deps,
        'u:g:first'
      );
      await rememberIssuedRefreshToken(
        Response.json({ refresh_token: 'u:g:third' }),
        deps,
        'u:g:second'
      );

      // Day 29: the last full day of the session. With a history shorter than
      // the session this revoked row would be gone, the guard would forward the
      // replay, and the provider would refuse it without ending the session —
      // the replay would stay undetected. The history must cover the whole
      // session the provider serves.
      vi.setSystemTime(Date.UTC(2026, 0, 30, 12));
      const response = await guard(refreshRequest('u:g:first'), deps);
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'Refresh token reuse detected; the grant has been revoked.',
      });
      expect(deps.revokeGrant).toHaveBeenCalledExactlyOnceWith('g', 'u');
    } finally {
      vi.useRealTimers();
    }
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
        body: 'grant_type=refresh_token&refresh_token=u:g:second&refresh_token=u:g:first',
      }),
      new Request('https://kilo-mcp.test/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&refresh_token=u:g:first',
      }),
      refreshRequest(''),
    ]) {
      expect(await guard(request, deps)).toBeNull();
    }
    expect(deps.revokeGrant).not.toHaveBeenCalled();
  });

  it('records the destroyed session with the account and a fixed detail', async () => {
    const oauthSignIn = vi.fn();
    const deps = { ...makeDeps(), analytics: () => ({ oauthSignIn }) as unknown as McpAnalytics };
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:second' }),
      deps,
      'u:g:first'
    );
    await rememberIssuedRefreshToken(
      Response.json({ refresh_token: 'u:g:third' }),
      deps,
      'u:g:second'
    );

    expect(await guard(refreshRequest('u:g:first'), deps)).not.toBeNull();
    expect(oauthSignIn).toHaveBeenCalledExactlyOnceWith({
      phase: 'failed',
      identity: { kiloUserId: 'u', organizationId: null },
      reason: 'invalid_grant',
      detail: REFRESH_TOKEN_REUSE_DETAIL,
    });
  });

  it('emits nothing when the guard forwards the request', async () => {
    const oauthSignIn = vi.fn();
    const deps = { ...makeDeps(), analytics: () => ({ oauthSignIn }) as unknown as McpAnalytics };
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:first' }), deps);

    for (const token of ['u:g:first', 'u:g:unknown']) {
      expect(await guard(refreshRequest(token), deps)).toBeNull();
    }
    expect(deps.revokeGrant).not.toHaveBeenCalled();
    expect(oauthSignIn).not.toHaveBeenCalled();
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
  it('serializes concurrent uses of one token, accepting the second as the previous token', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    await rememberIssuedRefreshToken(Response.json({ refresh_token: 'u:g:current' }), deps);
    let issued = 0;
    const forward = vi.fn(async () => Response.json({ refresh_token: `u:g:next-${++issued}` }));
    const responses = await Promise.all([
      handle(refreshRequest('u:g:current'), forward),
      handle(refreshRequest('u:g:current'), forward),
    ]);
    // Two processes refreshing at once is the case the provider tolerates: the
    // second presents the token the first rotated away from.
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(deps.revokeGrant).not.toHaveBeenCalled();
    expect(deps.tokens.get(await hashRefreshToken('u:g:next-2'))?.current).toBe(true);
    expect(deps.tokens.get(await hashRefreshToken('u:g:next-1'))?.current).toBe(false);
    expect(deps.tokens.get(await hashRefreshToken('u:g:next-1'))?.previous).toBe(false);
    expect(deps.tokens.get(await hashRefreshToken('u:g:current'))?.previous).toBe(true);
  });

  it('hands the forwarded handler the account in the presented refresh token', async () => {
    const deps = makeDeps();
    const handle = createRefreshReuseHandler(deps);
    const seen: Array<{ tokenUserId: string | null }> = [];
    const forward = vi.fn(async (_request: Request, context: { tokenUserId: string | null }) => {
      seen.push(context);
      return Response.json({ refresh_token: 'u:g:next' });
    });
    await handle(codeRequest(), forward);
    await handle(refreshRequest('u-7:g:secret'), forward);
    await handle(refreshRequest('nope'), forward);
    expect(seen).toEqual([{ tokenUserId: null }, { tokenUserId: 'u-7' }, { tokenUserId: null }]);
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
