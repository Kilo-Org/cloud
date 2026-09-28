import { NextRequest } from 'next/server';
import { POST } from './route';

jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-secret',
  NEXTAUTH_URL: 'http://localhost:3000',
  TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
}));

describe('POST /api/auth/verify-turnstile request body', () => {
  it('returns 400 for malformed JSON body', async () => {
    const request = new NextRequest('http://localhost:3000/api/auth/verify-turnstile', {
      method: 'POST',
      body: 'not-json{',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '1.2.3.4',
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Token is required' });
  });
});
