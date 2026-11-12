import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';
import { getProfileOrganizations } from '@kilocode/web-shared/lib/organizations/organizations';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isUserBlacklistedByDomain } from '@kilocode/web-shared/lib/user/server';
import { createDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { createPagesAuthCode } from '@/lib/pages-auth/pages-auth-code';
import { getUserAuthProviders } from '@/lib/user';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-pages-auth-exchange-secret',
  PAGES_AUTH_SECRET: 'p'.repeat(40),
  PAGES_DEV_AUTH_SECRET: 'd'.repeat(40),
}));

jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  isUserBlacklistedByDomain: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  getProfileOrganizations: jest.fn(),
}));

jest.mock('@/lib/user', () => ({
  getUserAuthProviders: jest.fn(),
}));

const mockedFindUserById = jest.mocked(findUserById);
const mockedGetUserAuthProviders = jest.mocked(getUserAuthProviders);
const mockedIsUserBlacklistedByDomain = jest.mocked(isUserBlacklistedByDomain);
const mockedGetProfileOrganizations = jest.mocked(getProfileOrganizations);

const NEXTAUTH_TEST_SECRET = 'synthetic-pages-auth-exchange-secret';
const NOW = new Date('2026-03-01T12:00:00.000Z');
const PAGES = 'pages';
const PAGES_DEV = 'pages-dev';
const SECRET = 'p'.repeat(40);
const DEV_SECRET = 'd'.repeat(40);
const STATE = 'S'.repeat(43);
const organizations = [{ id: 'org-1', name: 'Kilo', role: 'member' }];

/** Provider rows as the route reads them; only `provider` and `email` matter. */
const providerRows = (...rows: [provider: string, email: string][]) =>
  rows.map(([provider, email]) => ({ provider, email })) as never;

/** `secret` is sent as a bearer credential; `authorization` replaces the whole header. */
function exchange(body: unknown, secret: string | null = SECRET, authorization?: string) {
  const credential = authorization ?? (secret === null ? null : `Bearer ${secret}`);
  return POST(
    new NextRequest('http://localhost:3000/api/pages-auth/exchange', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...(credential === null ? {} : { Authorization: credential }),
      },
    })
  );
}
const codeFor = (audience = PAGES, state = STATE) =>
  createPagesAuthCode({ userId: 'user-1', audience, state });

function tokenFor(
  options: {
    audience?: string;
    secret?: string;
    purpose?: 'delegated-workload' | 'device-access';
    pepper?: string;
    extra?: Record<string, unknown>;
    issuedAt?: number;
    lifetime?: number;
    env?: string;
  } = {}
) {
  const issuedAt = options.issuedAt ?? Math.floor(NOW.getTime() / 1000);
  const payload = buildModernKiloTokenPayload({
    userId: 'user-1',
    pepper: options.pepper,
    env: options.env ?? process.env.NODE_ENV,
    audience: options.audience ?? 'pages',
    issuedAt,
    expiresAt: issuedAt + (options.lifetime ?? 300),
    tokenPurpose: options.purpose ?? 'delegated-workload',
    credentialExchange: false,
    extra: options.extra,
  });
  return jwt.sign(payload, options.secret ?? NEXTAUTH_TEST_SECRET, {
    algorithm: 'HS256',
  });
}

describe('POST /api/pages-auth/exchange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockedFindUserById.mockResolvedValue({
      id: 'user-1',
      google_user_name: 'Ada Lovelace',
      google_user_email: 'ada@kilo.test',
      blocked_reason: null,
    } as never);
    mockedIsUserBlacklistedByDomain.mockResolvedValue(false);
    mockedGetProfileOrganizations.mockResolvedValue(organizations as never);
    mockedGetUserAuthProviders.mockResolvedValue(providerRows(['google', 'ada@kilo.test']));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('answers with who signed in and their verified address, and nothing else', async () => {
    const response = await exchange({
      code: codeFor(),
      audience: PAGES,
      state: STATE,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      user: { id: 'user-1', name: 'Ada Lovelace', verified_email: 'ada@kilo.test' },
      organizations,
    });
    expect(mockedFindUserById).toHaveBeenCalledWith('user-1');
    expect(mockedGetProfileOrganizations).toHaveBeenCalledWith('user-1', {
      excludeAccessBlocked: true,
    });
    expect(mockedGetUserAuthProviders).toHaveBeenCalledWith('user-1');
  });

  describe('verified_email', () => {
    const exchanges = [
      ['a code', () => exchange({ code: codeFor(), audience: PAGES, state: STATE })],
      ['a token', () => exchange({ token: tokenFor(), audience: PAGES })],
    ] as const;

    describe.each(exchanges)('for %s', (_kind, send) => {
      test.each([
        ['a Google row', providerRows(['google', 'ada@kilo.test'])],
        ['an Anaconda row', providerRows(['anaconda', 'ada@kilo.test'])],
        ['an email row', providerRows(['email', 'ada@kilo.test'])],
        ['a row that differs only in case', providerRows(['google', 'Ada@Kilo.TEST'])],
        [
          'a verified row beside unverified ones',
          providerRows(['github', 'ada@kilo.test'], ['email', 'ada@kilo.test']),
        ],
      ])('carries the primary address that %s verified', async (_name, rows) => {
        mockedGetUserAuthProviders.mockResolvedValueOnce(rows);

        const response = await send();

        expect(response.status).toBe(200);
        expect((await response.json()).user).toEqual({
          id: 'user-1',
          name: 'Ada Lovelace',
          verified_email: 'ada@kilo.test',
        });
      });

      test.each([
        [
          'only providers that do not verify addresses',
          providerRows(
            ['github', 'ada@kilo.test'],
            ['apple', 'ada@kilo.test'],
            ['workos', 'ada@kilo.test']
          ),
        ],
        ['a verified row for a different address', providerRows(['google', 'grace@kilo.test'])],
        ['a verified row for a + alias', providerRows(['email', 'ada+pages@kilo.test'])],
        ['no provider rows', providerRows()],
      ])('leaves the key out for an account with %s', async (_name, rows) => {
        mockedGetUserAuthProviders.mockResolvedValueOnce(rows);

        const response = await send();

        expect(response.status).toBe(200);
        const { user } = await response.json();
        expect(user).toEqual({ id: 'user-1', name: 'Ada Lovelace' });
        expect('verified_email' in user).toBe(false);
      });
    });
  });

  test.each([
    ['no credential', null],
    ['a wrong secret', 'q'.repeat(40)],
    ["another deployment's secret", DEV_SECRET],
  ])('refuses a caller with %s before looking anyone up', async (_name, secret) => {
    const response = await exchange({ code: codeFor(), audience: PAGES, state: STATE }, secret);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_client' });
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test.each([
    ['a lowercase scheme', `bearer ${SECRET}`],
    ['an uppercase scheme', `BEARER ${SECRET}`],
    ['space around the credential', `  Bearer   ${SECRET}  `],
  ])('reads a bearer credential sent with %s', async (_name, authorization) => {
    const body = { code: codeFor(), audience: PAGES, state: STATE };
    const response = await exchange(body, null, authorization);

    expect(response.status).toBe(200);
  });

  test.each([
    ['another scheme', `Basic ${SECRET}`],
    ['no scheme', SECRET],
    ['a scheme and nothing else', 'Bearer '],
  ])('refuses a credential sent with %s', async (_name, authorization) => {
    const body = { code: codeFor(), audience: PAGES, state: STATE };
    const response = await exchange(body, null, authorization);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_client' });
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses an audience that is not a deployment, whatever it presents', async () => {
    const audience = 'kilo-api';
    const response = await exchange({
      code: codeFor(audience),
      audience,
      state: STATE,
    });

    expect(response.status).toBe(401);
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses a code minted for another deployment', async () => {
    const response = await exchange({
      code: codeFor(PAGES_DEV),
      audience: PAGES,
      state: STATE,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_code' });
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses a code presented with another state', async () => {
    const response = await exchange({
      code: codeFor(),
      audience: PAGES,
      state: 'T'.repeat(43),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_code' });
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses a stale code', async () => {
    const code = codeFor();
    jest.setSystemTime(new Date(NOW.getTime() + 61_000));

    const response = await exchange({ code, audience: PAGES, state: STATE });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_code' });
  });

  test('refuses a tampered code and a token minted for another purpose', async () => {
    const code = codeFor();
    const tampered = code.slice(0, -1) + (code.at(-1) === 'a' ? 'b' : 'a');

    for (const candidate of [tampered, createDeviceAuthViewerToken('ABCD-EFGH', 'user-1')]) {
      const response = await exchange({
        code: candidate,
        audience: PAGES,
        state: STATE,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_code' });
    }
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses an account that is gone, blocked, or on a blacklisted domain', async () => {
    mockedFindUserById.mockResolvedValueOnce(undefined);
    const gone = await exchange({
      code: codeFor(),
      audience: PAGES,
      state: STATE,
    });

    mockedFindUserById.mockResolvedValueOnce({
      id: 'user-1',
      google_user_name: 'Ada Lovelace',
      blocked_reason: 'abuse',
    } as never);
    const blocked = await exchange({
      code: codeFor(),
      audience: PAGES,
      state: STATE,
    });

    mockedIsUserBlacklistedByDomain.mockResolvedValueOnce(true);
    const blacklisted = await exchange({
      code: codeFor(),
      audience: PAGES,
      state: STATE,
    });
    expect(mockedIsUserBlacklistedByDomain).toHaveBeenCalledWith(
      expect.objectContaining({ google_user_email: 'ada@kilo.test' })
    );

    for (const response of [gone, blocked, blacklisted]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'account_unavailable' });
    }
    expect(mockedGetProfileOrganizations).not.toHaveBeenCalled();
    expect(mockedGetUserAuthProviders).not.toHaveBeenCalled();
  });

  test('refuses an account whose block timestamp is set', async () => {
    mockedFindUserById.mockResolvedValueOnce({
      id: 'user-1',
      google_user_name: 'Ada Lovelace',
      google_user_email: 'ada@kilo.test',
      blocked_at: '2026-01-15T12:00:00.000Z',
      blocked_reason: null,
    } as never);

    const response = await exchange({ code: codeFor(), audience: PAGES, state: STATE });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'account_unavailable' });
    expect(mockedGetProfileOrganizations).not.toHaveBeenCalled();
    expect(mockedGetUserAuthProviders).not.toHaveBeenCalled();
  });

  test.each([
    ['a body that is not JSON', 'not json'],
    ['no code', { audience: PAGES, state: STATE }],
    ['no audience', { code: 'a.b', state: STATE }],
    ['no state', { code: 'a.b', audience: PAGES }],
    ['a state of the wrong shape', { code: 'a.b', audience: PAGES, state: 'short' }],
  ])('refuses %s', async (_name, body) => {
    const response = await exchange(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  describe('token flow', () => {
    test('answers with the person a token for the deployment names', async () => {
      const response = await exchange(
        { token: tokenFor({ audience: 'pages-dev' }), audience: PAGES_DEV },
        DEV_SECRET
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        user: { id: 'user-1', name: 'Ada Lovelace', verified_email: 'ada@kilo.test' },
        organizations,
      });
      expect(mockedFindUserById).toHaveBeenCalledWith('user-1');
      expect(mockedGetProfileOrganizations).toHaveBeenCalledWith('user-1', {
        excludeAccessBlocked: true,
      });
    });

    test('accepts a production token at the production deployment', async () => {
      const response = await exchange({ token: tokenFor(), audience: PAGES });
      expect(response.status).toBe(200);
    });

    test.each([
      ['a dev token at production', tokenFor({ audience: 'pages-dev' }), PAGES, SECRET],
      ['a production token at dev', tokenFor({ audience: 'pages' }), PAGES_DEV, DEV_SECRET],
    ])('refuses %s', async (_name, token, audience, secret) => {
      const response = await exchange({ token, audience }, secret);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_token' });
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });

    test.each([
      ['no credential', null],
      ['a wrong secret', 'q'.repeat(40)],
      ["another deployment's secret", DEV_SECRET],
    ])('refuses a caller with %s before verifying the token', async (_name, secret) => {
      // A malformed token would be a 400 if it were looked at.
      const response = await exchange({ token: 'not-a-jwt', audience: PAGES }, secret);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'invalid_client' });
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });

    test('refuses an audience that is not a deployment', async () => {
      const audience = 'kilo-api';
      const response = await exchange({ token: tokenFor(), audience });

      expect(response.status).toBe(401);
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });

    test('refuses an expired token', async () => {
      const token = tokenFor();
      jest.setSystemTime(new Date(NOW.getTime() + 301_000));

      const response = await exchange({ token, audience: PAGES });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_token' });
    });

    test('refuses a token issued in the future', async () => {
      const token = tokenFor({
        issuedAt: Math.floor(NOW.getTime() / 1000) + 3600,
      });
      const response = await exchange({ token, audience: PAGES });
      expect(response.status).toBe(400);
    });

    test('refuses a tampered token and one signed with another secret', async () => {
      const token = tokenFor();
      const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');

      for (const candidate of [tampered, tokenFor({ secret: 'z'.repeat(40) }), 'not-a-jwt']) {
        const response = await exchange({ token: candidate, audience: PAGES });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_token' });
      }
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });

    test.each(['kilo-gateway', 'kilo-api', 'ai-attribution'])(
      'refuses a token for the %s audience',
      async audience => {
        const response = await exchange({
          token: tokenFor({ audience }),
          audience: PAGES,
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_token' });
        expect(mockedFindUserById).not.toHaveBeenCalled();
      }
    );

    test('refuses a device-auth viewer token and a sign-in code', async () => {
      for (const candidate of [createDeviceAuthViewerToken('ABCD-EFGH', 'user-1'), codeFor()]) {
        const response = await exchange({ token: candidate, audience: PAGES });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_token' });
      }
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });

    test.each([
      ['another purpose', { purpose: 'device-access' as const }],
      ['a pepper', { pepper: 'pepper' }],
      ['organization claims', { extra: { organizationId: 'org-1', organizationRole: 'owner' } }],
      ['organization memberships', { extra: { orgMemberships: [{ orgId: 'o', role: 'member' }] } }],
      ['a token source', { extra: { tokenSource: 'harness' } }],
      ['another environment', { env: 'elsewhere' }],
    ] as const)('refuses a token with %s', async (_name, options) => {
      const response = await exchange({
        token: tokenFor(options),
        audience: PAGES,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_token' });
      expect(mockedFindUserById).not.toHaveBeenCalled();
    });

    test('refuses an account that is gone, blocked, or on a blacklisted domain', async () => {
      mockedFindUserById.mockResolvedValueOnce(undefined);
      const gone = await exchange({ token: tokenFor(), audience: PAGES });

      mockedFindUserById.mockResolvedValueOnce({
        id: 'user-1',
        google_user_name: 'Ada Lovelace',
        blocked_reason: 'abuse',
      } as never);
      const blocked = await exchange({ token: tokenFor(), audience: PAGES });

      mockedIsUserBlacklistedByDomain.mockResolvedValueOnce(true);
      const blacklisted = await exchange({
        token: tokenFor(),
        audience: PAGES,
      });

      for (const response of [gone, blocked, blacklisted]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'account_unavailable' });
      }
      expect(mockedGetProfileOrganizations).not.toHaveBeenCalled();
      expect(mockedGetUserAuthProviders).not.toHaveBeenCalled();
    });

    test.each([
      [
        'both a code and a token',
        () => ({
          code: codeFor(),
          token: tokenFor(),
          audience: PAGES,
          state: STATE,
        }),
      ],
      [
        'a token and a state without a code',
        () => ({ token: tokenFor(), audience: PAGES, state: STATE }),
      ],
      ['neither a code nor a token', () => ({ audience: PAGES })],
      ['an empty token', () => ({ token: '', audience: PAGES })],
      ['a token that is not a string', () => ({ token: 1, audience: PAGES })],
    ])('refuses a body with %s', async (_name, body) => {
      const response = await exchange(body());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    });
  });
});
