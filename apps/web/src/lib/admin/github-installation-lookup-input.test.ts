import { GitHubOrganizationInstallationLookupInputSchema } from './github-installation-lookup-input';

describe('GitHubOrganizationInstallationLookupInputSchema', () => {
  test.each([
    [' Acme-Tools ', 'acme-tools'],
    ['@Acme-Tools', 'acme-tools'],
    ['https://github.com/Acme-Tools/', 'acme-tools'],
  ])('normalizes %s', (organization, expected) => {
    expect(GitHubOrganizationInstallationLookupInputSchema.parse({ organization })).toEqual({
      organization: expected,
    });
  });

  test.each([
    'github.com/acme',
    'https://github.com/acme/path',
    'https://github.com@attacker.invalid/acme',
    'https://github.com:443/acme',
    'https://github.com/acme?x=1',
    'https://github.com/acme#fragment',
    '-acme',
    'acme-',
    'acme--tools',
    'a'.repeat(40),
  ])('rejects invalid organization login %s', organization => {
    expect(() => GitHubOrganizationInstallationLookupInputSchema.parse({ organization })).toThrow(
      'Enter a valid GitHub organization login'
    );
  });
});
