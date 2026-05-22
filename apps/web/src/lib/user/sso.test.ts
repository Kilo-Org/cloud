jest.mock('@workos-inc/node', () => {
  const mockWorkOSInstance = {
    organizations: {
      listOrganizations: jest.fn(),
    },
  };

  return {
    WorkOS: jest.fn(() => mockWorkOSInstance),
    mockWorkOSInstance,
  };
});

jest.mock('@/lib/config.server', () => ({
  WORKOS_API_KEY: 'workos-test-key',
}));

jest.mock('@/lib/user', () => ({
  createOrUpdateUser: jest.fn(),
}));

jest.mock('@/lib/organizations/organizations', () => ({
  addUserToOrganization: jest.fn(async () => false),
  getOrganizationById: jest.fn(async () => ({ id: 'org-local' })),
  getOrganizationMembers: jest.fn(async () => []),
}));

jest.mock('@/lib/organizations/organization-audit-logs', () => ({
  createAuditLog: jest.fn(async () => {}),
}));

jest.mock('@/lib/email', () => ({
  sendOrgSSOUserJoinedEmail: jest.fn(async () => {}),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { createOrUpdateUser } from '@/lib/user';
import { processSSOUserLogin } from './sso';

const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);
const { mockWorkOSInstance } = jest.requireMock('@workos-inc/node') as {
  mockWorkOSInstance: { organizations: { listOrganizations: jest.Mock } };
};

function getMockListOrganizations() {
  return mockWorkOSInstance.organizations.listOrganizations;
}

describe('processSSOUserLogin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMockListOrganizations().mockResolvedValue({
      data: [{ id: 'workos-org', name: 'Example Org', externalId: 'org-local' }],
    });
    mockCreateOrUpdateUser.mockResolvedValue({
      success: true,
      user: {
        id: 'user-workos',
        google_user_email: 'new-user@example.com',
        google_user_name: 'New User',
        blocked_reason: null,
      },
      isNew: true,
    } as Awaited<ReturnType<typeof createOrUpdateUser>>);
  });

  it('passes accepted Impact attribution through WorkOS account creation', async () => {
    const requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.10' });
    const accountInfo = {
      google_user_email: 'new-user@example.com',
      google_user_name: 'New User',
      google_user_image_url: 'https://example.com/avatar.png',
      hosted_domain: 'example.com',
      provider: 'workos' as const,
      provider_account_id: 'workos-user-123',
    };
    const trackingContext = {
      affiliateTouch: null,
      referralTouch: null,
      locale: 'en-US',
      countryCode: 'US',
    };

    await expect(
      processSSOUserLogin(accountInfo, requestHeaders, 'impact-click-123', trackingContext)
    ).resolves.toBe(true);

    expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
      accountInfo,
      undefined,
      true,
      requestHeaders,
      'impact-click-123',
      trackingContext
    );
  });
});
