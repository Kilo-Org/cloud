import { getEnvVariable } from '@/lib/dotenvx';
import {
  canOrganizationUseMultipleGitHubInstallations,
  parseMultipleGitHubInstallationOrganizationIds,
} from './multiple-installations';

jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: jest.fn(),
}));

const mockedGetEnvVariable = jest.mocked(getEnvVariable);

describe('canOrganizationUseMultipleGitHubInstallations', () => {
  beforeEach(() => {
    mockedGetEnvVariable.mockReturnValue(
      '9d278969-5453-4ae3-a51f-a8d2274a7b56,30f1620a-4aad-4456-bf4d-550f335e6f55'
    );
  });

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

  it('keeps multiple installations disabled when the environment variable is unset', () => {
    mockedGetEnvVariable.mockReturnValue('');

    expect(
      canOrganizationUseMultipleGitHubInstallations('9d278969-5453-4ae3-a51f-a8d2274a7b56')
    ).toBe(false);
  });
});

describe('parseMultipleGitHubInstallationOrganizationIds', () => {
  it('trims and deduplicates comma-separated organization IDs', () => {
    expect(
      parseMultipleGitHubInstallationOrganizationIds(
        ' 9d278969-5453-4ae3-a51f-a8d2274a7b56,30f1620a-4aad-4456-bf4d-550f335e6f55,9d278969-5453-4ae3-a51f-a8d2274a7b56 '
      )
    ).toEqual(
      new Set(['9d278969-5453-4ae3-a51f-a8d2274a7b56', '30f1620a-4aad-4456-bf4d-550f335e6f55'])
    );
  });

  it('returns an empty set for an empty value', () => {
    expect(parseMultipleGitHubInstallationOrganizationIds('')).toEqual(new Set());
  });

  it('rejects malformed organization IDs', () => {
    expect(() => parseMultipleGitHubInstallationOrganizationIds('not-an-organization-id')).toThrow(
      'GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS must be a comma-separated list of UUIDs'
    );
  });
});
