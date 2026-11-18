import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createDelegatedResourceToken } from '@/lib/auth/resource-delegation';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(async () => ({ user: { id: 'oauth/test-user' } })),
}));
jest.mock('@/lib/auth/resource-delegation', () => ({
  isDelegableResource: (value: string) =>
    ['api', 'gateway', 'attribution', 'html-deploy', 'pages', 'pages-dev'].includes(value),
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

it.each(['api', 'gateway', 'html-deploy', 'pages', 'pages-dev'])(
  'retains personal %s negotiation',
  async resource => {
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
  }
);

it('refuses Pages tokens for organization credentials', async () => {
  jest.mocked(getUserFromAuth).mockResolvedValueOnce({
    user: { id: 'oauth/test-user' },
    organizationId: 'org',
  } as Awaited<ReturnType<typeof getUserFromAuth>>);
  const response = await POST(
    new NextRequest('https://example.test/api/auth/resource-token', {
      method: 'POST',
      headers: { authorization: 'Bearer org-token' },
      body: JSON.stringify({ resource: 'pages' }),
    })
  );
  expect(response.status).toBe(403);
  expect(createDelegatedResourceToken).not.toHaveBeenCalled();
});

it('returns the token and its expiry for a Pages mint', async () => {
  const response = await POST(
    new NextRequest('https://example.test/api/auth/resource-token', {
      method: 'POST',
      headers: { authorization: 'Bearer personal' },
      body: JSON.stringify({ resource: 'pages-dev' }),
    })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ token: 'delegated', expiresAt: 'expiry' });
});
