import { beforeEach, describe, expect, it } from '@jest/globals';

jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/organizations/organizations', () => ({ getProfileOrganizations: jest.fn() }));
jest.mock('@/lib/organizations/verified-domain-destination', () => ({
  resolvePreferredVerifiedDomainOrganizationId: jest.fn(),
}));

import { getProfileOrganizations } from '@/lib/organizations/organizations';
import { resolvePreferredVerifiedDomainOrganizationId } from '@/lib/organizations/verified-domain-destination';
import { getUserFromAuth } from '@/lib/user/server';
import { GET } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockGetProfileOrganizations = jest.mocked(getProfileOrganizations);
const mockResolvePreferredOrganization = jest.mocked(resolvePreferredVerifiedDomainOrganizationId);

describe('GET /api/profile', () => {
  const organizations = [
    { id: 'oldest-org', name: 'Oldest', role: 'owner' as const },
    { id: 'verified-org', name: 'Verified', role: 'member' as const },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockAuthenticatedUser() {
    mockGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: {
        id: 'profile-user',
        google_user_email: 'person@verified.example.com',
        google_user_name: 'Profile User',
        google_user_image_url: 'https://example.com/profile.png',
        personal_account_disabled: false,
      },
    } as Awaited<ReturnType<typeof getUserFromAuth>>);
    mockGetProfileOrganizations.mockResolvedValue(organizations);
  }

  it('selects the verified-domain organization without reordering or removing contexts', async () => {
    mockAuthenticatedUser();
    mockResolvePreferredOrganization.mockResolvedValue('verified-org');

    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      user: {
        id: 'profile-user',
        email: 'person@verified.example.com',
        name: 'Profile User',
        image: 'https://example.com/profile.png',
      },
      organizations,
      hasPersonalAccount: true,
      selectedOrganizationId: 'verified-org',
    });
    expect(mockResolvePreferredOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'profile-user' }),
      organizations
    );
  });

  it('keeps the existing first-organization fallback when there is no preference', async () => {
    mockAuthenticatedUser();
    mockResolvePreferredOrganization.mockResolvedValue(null);

    const response = await GET();

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        organizations,
        hasPersonalAccount: true,
        selectedOrganizationId: 'oldest-org',
      })
    );
  });
});
