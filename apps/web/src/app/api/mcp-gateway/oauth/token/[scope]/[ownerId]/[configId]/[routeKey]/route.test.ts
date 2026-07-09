import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';

describe('POST /api/mcp-gateway/oauth/token/[scope]/...', () => {
  test('returns no-store headers when scoped route params are invalid', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest(
        'http://localhost:3000/api/mcp-gateway/oauth/token/user/user-1/not-a-uuid/short',
        {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'some-code',
            redirect_uri: 'http://localhost:3000/callback',
            client_id: 'mcp:client',
            code_verifier:
              'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk',
          }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      ),
      {
        params: Promise.resolve({
          scope: 'user',
          ownerId: 'user-1',
          configId: 'not-a-uuid',
          routeKey: 'short',
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
});
