import { generateAutoTriageInstallationToken } from './installation-token';

describe('generateAutoTriageInstallationToken', () => {
  it('mints retries with the pinned installation and app identity', async () => {
    const generateToken = jest.fn().mockResolvedValue({
      token: 'lite-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    });

    const integration = {
      platform_installation_id: 'secondary-installation',
      github_app_type: 'lite' as const,
    };

    await expect(generateAutoTriageInstallationToken(integration, generateToken)).resolves.toEqual({
      token: 'lite-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    await generateAutoTriageInstallationToken(integration, generateToken);

    expect(generateToken).toHaveBeenNthCalledWith(1, 'secondary-installation', 'lite');
    expect(generateToken).toHaveBeenNthCalledWith(2, 'secondary-installation', 'lite');
  });
});
