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
  addSsoUserToOrganization: jest.fn(async () => false),
  getOrganizationById: jest.fn(async () => ({ id: 'org-local' })),
  getOrganizationMembers: jest.fn(async () => []),
  skipCustomerSourceSurveyForOrgJoin: jest.fn(async () => {}),
}));

jest.mock('@/lib/organizations/organization-sso-policy', () => ({
  resolveSsoAuthorityForDomain: jest.fn(async () => ({
    status: 'required',
    domain: 'example.com',
    sourceOrganizationId: 'org-local',
  })),
}));

jest.mock('@/lib/organizations/verified-domain-membership', () => ({
  ensureVerifiedDomainOrganizationMembership: jest.fn(async () => null),
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
import {
  addSsoUserToOrganization,
  skipCustomerSourceSurveyForOrgJoin,
} from '@/lib/organizations/organizations';
import { processSSOUserLogin } from './sso';
import { ensureVerifiedDomainOrganizationMembership } from '@/lib/organizations/verified-domain-membership';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';

const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);
const mockAddSsoUserToOrganization = jest.mocked(addSsoUserToOrganization);
const mockSkipCustomerSourceSurveyForOrgJoin = jest.mocked(skipCustomerSourceSurveyForOrgJoin);
const mockEnsureVerifiedDomainOrganizationMembership = jest.mocked(
  ensureVerifiedDomainOrganizationMembership
);
const mockCreateAuditLog = jest.mocked(createAuditLog);
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
    expect(mockAddSsoUserToOrganization).toHaveBeenCalledWith('org-local', 'user-workos', {
      isNewUser: true,
    });
  });

  it('skips the customer-source survey when the user joins the org via SSO', async () => {
    mockAddSsoUserToOrganization.mockResolvedValueOnce(true);
    const accountInfo = {
      google_user_email: 'new-user@example.com',
      google_user_name: 'New User',
      google_user_image_url: 'https://example.com/avatar.png',
      hosted_domain: 'example.com',
      provider: 'workos' as const,
      provider_account_id: 'workos-user-123',
    };

    await expect(processSSOUserLogin(accountInfo)).resolves.toBe(true);

    expect(mockSkipCustomerSourceSurveyForOrgJoin).toHaveBeenCalledWith('user-workos');
  });

  it('does not touch the customer-source survey when the user is already a member', async () => {
    mockAddSsoUserToOrganization.mockResolvedValueOnce(false);
    const accountInfo = {
      google_user_email: 'new-user@example.com',
      google_user_name: 'New User',
      google_user_image_url: 'https://example.com/avatar.png',
      hosted_domain: 'example.com',
      provider: 'workos' as const,
      provider_account_id: 'workos-user-123',
    };

    await expect(processSSOUserLogin(accountInfo)).resolves.toBe(true);

    expect(mockSkipCustomerSourceSurveyForOrgJoin).not.toHaveBeenCalled();
  });

  it('runs verified-domain admission after SSO JIT behavior and before the login audit', async () => {
    mockAddSsoUserToOrganization.mockImplementationOnce(async () => {
      expect(mockEnsureVerifiedDomainOrganizationMembership).not.toHaveBeenCalled();
      return true;
    });
    mockEnsureVerifiedDomainOrganizationMembership.mockImplementationOnce(async () => {
      expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.sso.auto_provision' })
      );
      return null;
    });

    const result = await processSSOUserLogin({
      google_user_email: 'new-user@example.com',
      google_user_name: 'New User',
      google_user_image_url: 'https://example.com/avatar.png',
      hosted_domain: 'example.com',
      provider: 'workos',
      provider_account_id: 'workos-user-123',
    });

    expect(result).toBe(true);
    expect(mockEnsureVerifiedDomainOrganizationMembership).toHaveBeenCalledWith('user-workos');
    expect(mockCreateAuditLog.mock.calls.map(([entry]) => entry.action)).toEqual([
      'organization.sso.auto_provision',
      'organization.user.login',
    ]);
  });

  it('fails SSO completion without recording a successful login when admission fails', async () => {
    mockAddSsoUserToOrganization.mockResolvedValueOnce(true);
    mockEnsureVerifiedDomainOrganizationMembership.mockRejectedValueOnce(
      new Error('verified-domain admission failed')
    );

    const result = await processSSOUserLogin({
      google_user_email: 'new-user@example.com',
      google_user_name: 'New User',
      google_user_image_url: 'https://example.com/avatar.png',
      hosted_domain: 'example.com',
      provider: 'workos',
      provider_account_id: 'workos-user-123',
    });

    expect(result).toBe('/users/sign_in?error=OAUTH_ERROR');
    expect(mockAddSsoUserToOrganization).toHaveBeenCalled();
    expect(mockSkipCustomerSourceSurveyForOrgJoin).toHaveBeenCalledWith('user-workos');
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'organization.sso.auto_provision' })
    );
  });
});
