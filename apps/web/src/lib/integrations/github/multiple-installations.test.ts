import { canOrganizationUseMultipleGitHubInstallations } from './multiple-installations';

describe('canOrganizationUseMultipleGitHubInstallations', () => {
  it.each(['9d278969-5453-4ae3-a51f-a8d2274a7b56', '30f1620a-4aad-4456-bf4d-550f335e6f55'])(
    'enables multiple installations for %s',
    organizationId => {
      expect(canOrganizationUseMultipleGitHubInstallations(organizationId)).toBe(true);
    }
  );

  it('keeps multiple installations disabled for other organizations', () => {
    expect(
      canOrganizationUseMultipleGitHubInstallations('00000000-0000-4000-8000-000000000001')
    ).toBe(false);
  });
});
