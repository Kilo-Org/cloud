import { NextRequest } from 'next/server';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { POST } from './route';

jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuthOrRedirect);

describe('POST /api/billing/update-email request body', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1', stripe_customer_id: 'cus_123' },
    } as never);
  });

  it('returns 400 for malformed JSON body', async () => {
    const request = new NextRequest('http://localhost:3000/api/billing/update-email', {
      method: 'POST',
      body: 'not-json{',
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Valid email is required' });
  });
});
