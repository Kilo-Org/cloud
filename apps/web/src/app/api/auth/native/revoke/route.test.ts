import { NextRequest } from 'next/server';

jest.mock('@/lib/auth/device-sessions');

import { POST } from './route';
import { revokeDeviceSessionByRefreshToken } from '@/lib/auth/device-sessions';

const mockRevoke = jest.mocked(revokeDeviceSessionByRefreshToken);

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/native/revoke', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/auth/native/revoke', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 with the settled outcome for a live session', async () => {
    mockRevoke.mockResolvedValue({ outcome: 'revoked' });

    const response = await POST(createRequest({ refreshToken: 'stored-refresh' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'revoked' });
    expect(mockRevoke).toHaveBeenCalledWith('stored-refresh');
  });

  it('reports an already revoked session as settled', async () => {
    mockRevoke.mockResolvedValue({ outcome: 'already_revoked' });

    const response = await POST(createRequest({ refreshToken: 'stored-refresh' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'already_revoked' });
  });

  it('reports an unknown token as settled, so the client stops retrying it', async () => {
    mockRevoke.mockResolvedValue({ outcome: 'unknown_token' });

    const response = await POST(createRequest({ refreshToken: 'bogus' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'unknown_token' });
  });

  it('returns 400 for a missing refreshToken without touching the session', async () => {
    const response = await POST(createRequest({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/auth/native/revoke', {
        method: 'POST',
        body: '{',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    expect(response.status).toBe(400);
  });

  it('propagates a server failure, so the client retries under its own bound', async () => {
    mockRevoke.mockRejectedValue(new Error('database unavailable'));

    await expect(POST(createRequest({ refreshToken: 'stored-refresh' }))).rejects.toThrow(
      'database unavailable'
    );
  });
});
