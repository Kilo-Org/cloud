import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-secret',
  NEXTAUTH_URL: 'http://localhost:3000',
}));
jest.mock('@/lib/web-config.server', () => ({
  TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
}));

const originalFetch = global.fetch;

function createRequest(body?: string, forwardedFor: string | null = '1.2.3.4') {
  return new NextRequest('http://localhost:3000/api/auth/verify-turnstile', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      ...(forwardedFor === null ? {} : { 'x-forwarded-for': forwardedFor }),
    },
  });
}

function verifySiteverifyCalls() {
  const calls = jest.mocked(global.fetch).mock.calls;
  return calls.map(([, init]) => JSON.parse(String(init?.body)));
}

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue(Response.json({ success: true }));
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('POST /api/auth/verify-turnstile request body', () => {
  it('returns 400 for malformed JSON body', async () => {
    const response = await POST(createRequest('not-json{'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Token is required' });
  });

  it('returns 400 when token is not a string', async () => {
    const response = await POST(createRequest(JSON.stringify({ token: { a: 1 } })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Token is required' });
  });
});

describe('POST /api/auth/verify-turnstile client address', () => {
  it('binds the token and the siteverify check to the first hop of a forwarded chain', async () => {
    const response = await POST(
      createRequest(JSON.stringify({ token: 'turnstile-token' }), '1.2.3.4, 10.0.0.1, 10.0.0.2')
    );

    expect(response.status).toBe(200);
    expect(verifySiteverifyCalls()).toEqual([
      { secret: 'test-turnstile-secret', response: 'turnstile-token', remoteip: '1.2.3.4' },
    ]);

    const cookie = response.cookies.get('turnstile_jwt')?.value;
    expect(cookie).toBeDefined();
    const payload = jwt.verify(cookie ?? '', 'test-secret');
    expect(payload).toMatchObject({ ip: '1.2.3.4' });
    expect(payload).not.toHaveProperty('watchwoodIp');
  });

  it('refuses to mint a token without a resolvable client address', async () => {
    const response = await POST(createRequest(JSON.stringify({ token: 'turnstile-token' }), null));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Client address unavailable' });
    expect(response.cookies.get('turnstile_jwt')).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
