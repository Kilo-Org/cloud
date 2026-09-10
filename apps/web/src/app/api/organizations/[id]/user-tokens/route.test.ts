import { NextRequest } from 'next/server';
import { isResourceTokenIssuanceEnabled } from '@/lib/config.server';
import { createDelegatedResourceToken } from '@/lib/auth/resource-delegation';
import { generateOrganizationApiToken } from '@/lib/tokens';
import { POST } from './route';

jest.mock('@/lib/config.server', () => ({ isResourceTokenIssuanceEnabled: jest.fn() }));
jest.mock('@/lib/organizations/organization-auth', () => ({
  getAuthorizedOrgContext: jest.fn(async () => ({
    success: true,
    data: { user: { id: 'oauth/test-user', role: 'member' }, organization: { name: 'Test' } },
  })),
}));
jest.mock('@/lib/organizations/organization-audit-logs', () => ({ createAuditLog: jest.fn() }));
jest.mock('@/lib/auth/resource-delegation', () => ({
  isDelegableResource: (value: string) =>
    ['api', 'gateway', 'attribution', 'html-deploy'].includes(value),
  canIssueLegacyOrganizationToken: (headers: Headers) => !headers.has('authorization'),
  createDelegatedResourceToken: jest.fn(async () => ({ token: 'delegated', expiresAt: 'expiry' })),
}));
jest.mock('@/lib/tokens', () => ({
  generateOrganizationApiToken: jest.fn(() => ({ token: 'legacy', expiresAt: 'expiry' })),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isResourceTokenIssuanceEnabled).mockReturnValue(false);
});

it.each(['api', 'gateway', 'attribution', 'html-deploy'])(
  'requires the delegated-resource family for explicit %s issuance',
  async resource => {
    const request = () =>
      new NextRequest('http://localhost/api/organizations/org/user-tokens', {
        method: 'POST',
        body: JSON.stringify({ resource }),
      });
    const params = Promise.resolve({ id: 'org' });
    expect((await POST(request(), { params })).status).toBe(503);
    expect(isResourceTokenIssuanceEnabled).toHaveBeenCalledWith('delegated-resource');
    expect(createDelegatedResourceToken).not.toHaveBeenCalled();
    expect(generateOrganizationApiToken).not.toHaveBeenCalled();
    jest.mocked(isResourceTokenIssuanceEnabled).mockReturnValue(true);
    expect((await POST(request(), { params })).status).toBe(200);
    expect(createDelegatedResourceToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'oauth/test-user' }),
      resource,
      expect.objectContaining({ organizationId: 'org', organizationRole: 'member' })
    );
    expect(generateOrganizationApiToken).not.toHaveBeenCalled();
  }
);

it('retains legacy session issuance while the family gate is false', async () => {
  const request = new NextRequest('http://localhost/api/organizations/org/user-tokens', {
    method: 'POST',
    body: '{}',
  });
  const response = await POST(request, { params: Promise.resolve({ id: 'org' }) });
  expect(response.status).toBe(200);
  expect(generateOrganizationApiToken).toHaveBeenCalled();
  expect(createDelegatedResourceToken).not.toHaveBeenCalled();
});
