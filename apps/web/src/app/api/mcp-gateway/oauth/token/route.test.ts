import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';

describe('POST /api/mcp-gateway/oauth/token', () => {
  test('returns a stable invalid_request response for malformed form data', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/token', {
        method: 'POST',
        body: 'malformed',
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Request body is malformed',
    });
  });

  test('rejects duplicate OAuth singleton form parameters', async () => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'first-code',
      redirect_uri: 'http://127.0.0.1:60424/callback',
      client_id: 'mcp:client',
      code_verifier:
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcdefghijk',
    });
    form.append('code', 'second-code');
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/token', {
        method: 'POST',
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );

    expect(response.status).toBe(400);
  });
});
