import React from 'react';

const mockGetUserForCredentialIssuance = jest.fn();
const mockGenerateApiToken = jest.fn();
const mockGetCustomerInfo = jest.fn();
const mockIntegrationsCard = jest.fn(() => null);

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuanceOrRedirect: mockGetUserForCredentialIssuance,
}));
jest.mock('@/lib/tokens', () => ({ generateApiToken: mockGenerateApiToken }));
jest.mock('@/lib/customerInfo', () => ({ getCustomerInfo: mockGetCustomerInfo }));
jest.mock('@/components/auth/getExtensionUrl', () => ({
  getExtensionUrl: jest.fn(() => ({ ideName: 'VS Code' })),
}));
jest.mock('next/headers', () => ({ cookies: jest.fn() }));
jest.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/profile/ProfileCreditsCounter', () => () => null);
jest.mock('@/components/profile/ProfileExpiringCredits', () => () => null);
jest.mock('@/components/dev/DevNukeAccountButton', () => ({ DevNukeAccountButton: () => null }));
jest.mock('@/components/dev/DevConsumeCreditsButton', () => ({
  DevConsumeCreditsButton: () => null,
}));
jest.mock('@/components/dev/DevAddCreditsButton', () => ({ DevAddCreditsButton: () => null }));
jest.mock('@/components/payment/CreditPurchaseOptions', () => () => null);
jest.mock('@/components/cloud-agent/MessageErrorBoundary', () => ({
  MessageErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/SurveyCredits', () => ({ SurveyCredits: () => null }));
jest.mock('@/components/profile/RedeemPromoCode', () => ({ RedeemPromoCode: () => null }));
jest.mock('@/components/payment/AutoTopUpToggle', () => ({ AutoTopUpToggle: () => null }));
jest.mock('@/components/profile/IntegrationsCard', () => ({
  IntegrationsCard: mockIntegrationsCard,
}));
jest.mock('@/components/profile/ProfileOrganizationsSection', () => ({
  ProfileOrganizationsSection: () => null,
}));
jest.mock('@/components/profile/ProfileKiloPassSection', () => ({
  ProfileKiloPassSection: () => null,
}));
jest.mock('@/components/dev/CreateKilocodeOrgButton', () => ({
  CreateKilocodeOrgButton: () => null,
}));
jest.mock('@/components/profile/UserProfileCard', () => ({ UserProfileCard: () => null }));
jest.mock('@/components/auto-routing/AutoRoutingModeCard', () => ({
  AutoRoutingModeCard: () => null,
}));
jest.mock('@/components/profile/DeleteAccountDialog', () => ({ DeleteAccountDialog: () => null }));
jest.mock('@/lib/user', () => ({ getOAuthDisplayNames: jest.fn(() => new Map()) }));
jest.mock('@/lib/organizations/organizations', () => ({
  getUserOrganizationsWithSeats: jest.fn(() => []),
}));
jest.mock('@/lib/posthog-feature-flags', () => ({ isFeatureFlagEnabled: jest.fn(() => false) }));
jest.mock('@/lib/contributor-champions/service', () => ({
  getContributorChampionProfileBadgeForUser: jest.fn(() => null),
}));

describe('ProfilePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not issue an API token when the session credential guard redirects', async () => {
    mockGetUserForCredentialIssuance.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const { default: ProfilePage } = await import('./page');

    await expect(
      ProfilePage({ params: Promise.resolve(undefined), searchParams: Promise.resolve({}) })
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(mockGetUserForCredentialIssuance).toHaveBeenCalledWith('/users/sign_in');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
    expect(mockGetCustomerInfo).not.toHaveBeenCalled();
  });

  it.each([undefined, 'vscode'])(
    'passes only the issued credential with source %s',
    async source => {
      const user = { id: 'profile-user' };
      mockGetUserForCredentialIssuance.mockResolvedValue(user);
      mockGenerateApiToken.mockReturnValue('profile-test-token');
      mockGetCustomerInfo.mockResolvedValue({ hasOrganizations: false, hasPaid: false, user });
      const { default: ProfilePage } = await import('./page');

      const page = await ProfilePage({
        params: Promise.resolve(undefined),
        searchParams: Promise.resolve({ source }),
      });
      const cards: unknown[] = [];
      function collectCards(node: React.ReactNode) {
        if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return;
        if (node.type === mockIntegrationsCard) cards.push(node.props);
        React.Children.forEach(node.props.children, collectCards);
      }
      collectCards(page);

      expect(mockGenerateApiToken).toHaveBeenCalledWith(user);
      expect(cards).toEqual([
        {
          kiloToken: 'profile-test-token',
          ideName: 'VS Code',
          logoSrc: undefined,
          isProminent: !!source,
        },
      ]);
    }
  );
});
