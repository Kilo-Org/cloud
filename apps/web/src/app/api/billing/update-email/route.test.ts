import { NextRequest } from 'next/server';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuthOrRedirect: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuthOrRedirect);

function createRequest(body?: string) {
  return new NextRequest('http://localhost:3000/api/billing/update-email', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/billing/update-email request body', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      id: 'user-1',
      stripe_customer_id: 'cus_123',
    } as never);
  });

  it('returns 400 for malformed JSON body', async () => {
    const response = await POST(createRequest('not-json{'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Valid email is required' });
  });

  it('returns 400 when email is not a string', async () => {
    const response = await POST(createRequest(JSON.stringify({ email: { a: 1 } })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Valid email is required' });
  });
});
