const mockHeaders = jest.fn<Promise<Headers>, []>();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import {
  createFakeUts,
  generateKiloWebTestKey,
  type FakeUts,
} from '@kilocode/web-shared/tests/helpers/uts-kilo-web.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET as start } from './start/route';
import { GET as callback } from './callback/route';
import { GET as session } from './session/route';
import { POST as end } from './end/route';

const APP = 'http://localhost:3000';
const REDIRECT_URI = `${APP}/api/auth/uts/callback`;

let uts: FakeUts;

beforeEach(async () => {
  const key = await generateKiloWebTestKey();
  uts = createFakeUts(key);
  process.env.UTS_BROWSER_SESSIONS = 'on';
  process.env.UTS_KILO_WEB_CLIENT_KEY = key.privateJwk;
  jest.spyOn(globalThis, 'fetch').mockImplementation(uts.fetch);
  mockHeaders.mockReset();
});

afterEach(() => {
  delete process.env.UTS_BROWSER_SESSIONS;
  delete process.env.UTS_KILO_WEB_CLIENT_KEY;
  jest.restoreAllMocks();
});

const firstPair = (setCookie: string) => setCookie.split(';')[0];

function navigation(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    headers: { 'sec-fetch-site': 'same-origin', host: new URL(url).host, ...headers },
  });
}

/** The start route, a fake UTS sign-in, and the callback; the browser's cookies afterwards. */
async function signIn(userId: string) {
  const started = start(navigation(`${APP}/api/auth/uts/start?callbackPath=/profile`));
  const transaction = firstPair(started.headers.getSetCookie()[0]);
  const { verifier } = JSON.parse(
    Buffer.from(transaction.slice(transaction.indexOf('=') + 1), 'base64url').toString('utf8')
  ) as { verifier: string };
  const location = new URL(started.headers.get('Location') ?? '');
  const code = uts.issueCode(
    userId,
    REDIRECT_URI,
    createHash('sha256').update(verifier).digest('base64url')
  );
  const query = new URLSearchParams({
    code,
    state: location.searchParams.get('state') ?? '',
    iss: uts.issuer,
  });
  const completed = await callback(
    new NextRequest(`${REDIRECT_URI}?${query}`, {
      headers: { cookie: transaction, 'sec-fetch-site': 'cross-site' },
    })
  );
  return { started, completed, transaction };
}

describe('UTS browser session routes', () => {
  test('every route is absent while the switch is off', async () => {
    delete process.env.UTS_BROWSER_SESSIONS;
    expect(start(navigation(`${APP}/api/auth/uts/start`)).status).toBe(404);
    expect((await callback(new NextRequest(`${REDIRECT_URI}?code=x&state=y`))).status).toBe(404);
    expect((await session()).status).toBe(404);
    expect((await end(new Request(`${APP}/api/auth/uts/end`, { method: 'POST' }))).status).toBe(
      404
    );
  });

  test('start redirects to the UTS authorization endpoint with the fixed callback', () => {
    const response = start(navigation(`${APP}/api/auth/uts/start?callbackPath=/profile`));
    expect(response.status).toBe(303);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const location = new URL(response.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('http://localhost:8800/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(location.searchParams.get('client_id')).toBe('kilo-web');
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.getSetCookie()[0]).toMatch(
      /^kilo-web-tx=[A-Za-z0-9_-]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/
    );
  });

  test('start refuses another origin and a navigation from another site', () => {
    expect(start(navigation('http://localhost:4000/api/auth/uts/start')).status).toBe(403);
    expect(
      start(navigation(`${APP}/api/auth/uts/start`, { 'sec-fetch-site': 'cross-site' })).status
    ).toBe(403);
  });

  test('the callback sets the session cookie and returns to the page; a forged state does not', async () => {
    const user = await insertTestUser();
    const { completed, transaction } = await signIn(user.id);
    expect(completed.status).toBe(303);
    expect(completed.headers.get('Location')).toBe(`${APP}/profile`);
    const cookies = completed.headers.getSetCookie();
    expect(cookies.map(value => value.split('=')[0])).toEqual(['kilo-web-session', 'kilo-web-tx']);
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Lax');

    const forged = await callback(
      new NextRequest(`${REDIRECT_URI}?code=x&state=${'y'.repeat(43)}&iss=${uts.issuer}`, {
        headers: { cookie: transaction },
      })
    );
    expect(forged.status).toBe(400);
    expect(forged.headers.getSetCookie()).toEqual([]);
  });

  test('the session route reports the session without its handle, id or token', async () => {
    const user = await insertTestUser();
    const { completed } = await signIn(user.id);
    const cookie = firstPair(completed.headers.getSetCookie()[0]);
    mockHeaders.mockResolvedValue(new Headers({ cookie }));

    const response = await session();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'active', userId: user.id, amr: ['email'] });
    expect(Object.keys(body).sort()).toEqual(
      ['amr', 'authTime', 'expiresAt', 'idleExpiresAt', 'status', 'userId'].sort()
    );
    expect(JSON.stringify(body)).not.toContain(cookie.split('=')[1].split('.')[0]);
  });

  test('end refuses another origin, then ends the UTS session and clears the cookie', async () => {
    const user = await insertTestUser();
    const { completed } = await signIn(user.id);
    const cookie = firstPair(completed.headers.getSetCookie()[0]);
    const post = (headers: Record<string, string>) =>
      end(
        new Request(`${APP}/api/auth/uts/end`, {
          method: 'POST',
          headers: { cookie, host: 'localhost:3000', ...headers },
        })
      );

    expect((await post({})).status).toBe(403);
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect([...uts.sessions.values()].some(value => value.ended)).toBe(false);

    const ended = await post({ origin: APP });
    expect(ended.status).toBe(200);
    expect(ended.headers.getSetCookie()[0]).toMatch(/^kilo-web-session=; .*Max-Age=0/);
    expect([...uts.sessions.values()].every(value => value.ended)).toBe(true);

    mockHeaders.mockResolvedValue(new Headers({ cookie }));
    const after = await session();
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ status: 'ended' });
  });
});
