import { NextRequest } from 'next/server';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-secret',
  NEXTAUTH_URL: 'http://localhost:3000',
}));
jest.mock('@/lib/web-config.server', () => ({
  TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
}));

function createRequest(body?: string) {
  return new NextRequest('http://localhost:3000/api/auth/verify-turnstile', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
    },
  });
}

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
