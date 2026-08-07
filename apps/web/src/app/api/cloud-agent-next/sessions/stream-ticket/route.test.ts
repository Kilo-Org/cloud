import { checkRateLimit } from '@vercel/firewall';
import { getUserFromAuth } from '@/lib/user/server';

jest.mock('@vercel/firewall');
jest.mock('@/lib/user/server');
jest.mock('@/lib/drizzle');
jest.mock('@/lib/cloud-agent/session-ownership');
jest.mock('@/lib/cloud-agent/stream-ticket');
jest.mock('@sentry/nextjs');

import { POST } from './route';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);

function createRequest(): Request {
  return new Request('http://localhost:3000/api/cloud-agent-next/sessions/stream-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloudAgentSessionId: 'session-1' }),
  });
}

describe('POST /api/cloud-agent-next/sessions/stream-ticket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
  });

  test('returns 429 before authentication when the client IP is rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });
    const request = createRequest();

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toEqual({
      error: 'Rate limit exceeded. Please try again later.',
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('stream-ticket-ip', { request });
    expect(mockGetUserFromAuth).not.toHaveBeenCalled();
  });

  test('continues to authentication when the client IP is allowed', async () => {
    const authFailedResponse = Response.json({ error: 'Unauthorized' }, { status: 401 });
    mockGetUserFromAuth.mockResolvedValue({ user: null, authFailedResponse } as never);
    const request = createRequest();

    const response = await POST(request);

    expect(mockCheckRateLimit).toHaveBeenCalledWith('stream-ticket-ip', { request });
    expect(mockGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: false });
    expect(response).toBe(authFailedResponse);
  });
});
