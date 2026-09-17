import { NextRequest } from 'next/server';
import { createDelegatedResourceToken } from '@/lib/auth/resource-delegation';
import { POST } from './route';

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(async () => ({ user: { id: 'oauth/test-user' } })),
}));
jest.mock('@/lib/auth/resource-delegation', () => ({
  isDelegableResource: (value: string) =>
    ['api', 'gateway', 'attribution', 'html-deploy'].includes(value),
  createDelegatedResourceToken: jest.fn(async () => ({ token: 'delegated', expiresAt: 'expiry' })),
}));

beforeEach(() => jest.clearAllMocks());

it('rejects personal attribution issuance because the reader requires organization claims', async () => {
  const response = await POST(
    new NextRequest('https://example.test/api/auth/resource-token', {
      method: 'POST',
      headers: { origin: 'https://example.test' },
      body: JSON.stringify({ resource: 'attribution' }),
    })
  );
  expect(response.status).toBe(403);
  expect(createDelegatedResourceToken).not.toHaveBeenCalled();
});

it.each(['api', 'gateway', 'html-deploy'])('retains personal %s negotiation', async resource => {
  const response = await POST(
    new NextRequest('https://example.test/api/auth/resource-token', {
      method: 'POST',
      headers: { origin: 'https://example.test' },
      body: JSON.stringify({ resource }),
    })
  );
  expect(response.status).toBe(200);
  expect(createDelegatedResourceToken).toHaveBeenCalledWith(
    { id: 'oauth/test-user' },
    resource,
    expect.objectContaining({ headers: expect.any(Headers) })
  );
});
