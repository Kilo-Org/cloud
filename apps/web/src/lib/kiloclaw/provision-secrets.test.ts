jest.mock('@/lib/kiloclaw/encryption', () => ({
  encryptKiloClawSecret: jest.fn((value: string) => `encrypted:${value}`),
}));

import { encryptProvisionSecretsForWorker } from './provision-secrets';

describe('encryptProvisionSecretsForWorker', () => {
  it('maps valid manual Composio secret keys to worker env var names before encrypting', () => {
    expect(
      encryptProvisionSecretsForWorker({
        composioUserApiKey: 'uak_manual_credential_123',
        composioOrg: 'org-1',
        CUSTOM_SECRET: 'kept',
      })
    ).toEqual({
      COMPOSIO_USER_API_KEY: 'encrypted:uak_manual_credential_123',
      COMPOSIO_ORG: 'encrypted:org-1',
      CUSTOM_SECRET: 'encrypted:kept',
    });
  });

  it('keeps manual Composio validation when secrets are passed during provision', () => {
    expect(() =>
      encryptProvisionSecretsForWorker({
        composioUserApiKey: 'uak_short',
        composioOrg: 'org-1',
      })
    ).toThrow('Composio user API keys start with uak_');
  });

  const partialComposioCredentialPairs: Array<Record<string, string>> = [
    { composioUserApiKey: 'uak_manual_credential_123' },
    { composioOrg: 'org-1' },
  ];

  it.each(partialComposioCredentialPairs)(
    'rejects a partial manual Composio credential pair during provision',
    secrets => {
      expect(() => encryptProvisionSecretsForWorker(secrets)).toThrow(
        'Composio requires all fields to be set together'
      );
    }
  );
});
