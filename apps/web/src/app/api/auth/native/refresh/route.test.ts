import { NextRequest } from 'next/server';

jest.mock('@/lib/auth/device-sessions');

import { POST } from './route';
import { rotateRefreshToken } from '@/lib/auth/device-sessions';

const mockRotateRefreshToken = jest.mocked(rotateRefreshToken);

describe('POST /api/auth/native/refresh', () => {
  const createRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/auth/native/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

  const createMalformedRequest = () =>
    new NextRequest('http://localhost:3000/api/auth/native/refresh', {
      method: 'POST',
      body: '{',
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 with new pair on successful rotation', async () => {
    mockRotateRefreshToken.mockResolvedValue({
      ok: true,
      token: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3600,
    });

    const response = await POST(createRequest({ refreshToken: 'valid-refresh' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3600,
    });
  });

  it('returns 401 for unknown refresh token', async () => {
    mockRotateRefreshToken.mockResolvedValue({
      ok: false,
      error: 'INVALID_REFRESH_TOKEN',
    });

    const response = await POST(createRequest({ refreshToken: 'bogus' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'INVALID_REFRESH_TOKEN' });
  });

  it('returns 401 for reused refresh token', async () => {
    mockRotateRefreshToken.mockResolvedValue({
      ok: false,
      error: 'INVALID_REFRESH_TOKEN',
    });

    const response = await POST(createRequest({ refreshToken: 'reused-refresh' }));
    expect(response.status).toBe(401);
  });

  it('returns 401 for revoked session', async () => {
    mockRotateRefreshToken.mockResolvedValue({
      ok: false,
      error: 'SESSION_REVOKED',
    });

    const response = await POST(createRequest({ refreshToken: 'revoked-session-refresh' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'SESSION_REVOKED' });
  });

  it('returns 401 for blocked user', async () => {
    mockRotateRefreshToken.mockResolvedValue({
      ok: false,
      error: 'USER_BLOCKED',
    });

    const response = await POST(createRequest({ refreshToken: 'blocked-user-refresh' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'USER_BLOCKED' });
  });

  it('returns 400 for missing refreshToken', async () => {
    const response = await POST(createRequest({}));
    expect(response.status).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await POST(createMalformedRequest());
    expect(response.status).toBe(400);
  });
});
