import { GitHubInstallationUninstallInputSchema } from './github-installation-uninstall-input';

const input = {
  integrationId: '12345678-1234-4234-9234-123456789abc',
  installationId: '123',
  accountId: '456',
  appType: 'standard' as const,
  owner: { type: 'user' as const, id: 'oauth/github|arbitrary-user-id' },
  confirmation: '123',
};

describe('GitHubInstallationUninstallInputSchema', () => {
  test('accepts arbitrary user owner IDs and organization IDs', () => {
    expect(GitHubInstallationUninstallInputSchema.parse(input)).toEqual(input);
    expect(
      GitHubInstallationUninstallInputSchema.parse({
        ...input,
        owner: { type: 'organization', id: '12345678-1234-4234-9234-123456789abd' },
      })
    ).toEqual(
      expect.objectContaining({
        owner: { type: 'organization', id: '12345678-1234-4234-9234-123456789abd' },
      })
    );
  });

  test.each([
    { installationId: '0' },
    { installationId: '01' },
    { installationId: '9007199254740992' },
    { accountId: '-1' },
    { confirmation: '124' },
  ])('rejects unsafe destructive input %#', invalid => {
    expect(GitHubInstallationUninstallInputSchema.safeParse({ ...input, ...invalid }).success).toBe(
      false
    );
  });
});
