jest.mock('@/lib/kiloclaw/encryption', () => ({
  encryptKiloClawSecret: jest.fn((value: string) => `encrypted:${value}`),
}));

import { encryptProvisionSecretsForWorker } from './provision-secrets';

describe('encryptProvisionSecretsForWorker', () => {
  it('maps valid manual Composio secret keys to worker env var names before encrypting', () => {
    expect(
      encryptProvisionSecretsForWorker({
        composioConsumerKey: 'ck_manual_credential_123',
        CUSTOM_SECRET: 'kept',
      })
    ).toEqual({
      COMPOSIO_CONSUMER_KEY: 'encrypted:ck_manual_credential_123',
      CUSTOM_SECRET: 'encrypted:kept',
    });
  });

  it('keeps manual Composio validation when secrets are passed during provision', () => {
    expect(() =>
      encryptProvisionSecretsForWorker({
        composioConsumerKey: 'ck_short',
      })
    ).toThrow('Composio consumer keys start with ck_');
  });

  it('rejects a Composio CLI user API key, which belongs to a different surface', () => {
    expect(() =>
      encryptProvisionSecretsForWorker({
        composioConsumerKey: 'uak_manual_credential_123',
      })
    ).toThrow('Composio consumer keys start with ck_');
  });

  // Credentials configured before the Composio Connect switch keep flowing to
  // the instance as ordinary custom secrets, so a stale CLI login is not
  // silently broken by an upgrade.
  it('passes legacy Composio CLI env vars through untouched', () => {
    expect(
      encryptProvisionSecretsForWorker({
        COMPOSIO_USER_API_KEY: 'uak_manual_credential_123',
        COMPOSIO_ORG: 'org-1',
      })
    ).toEqual({
      COMPOSIO_USER_API_KEY: 'encrypted:uak_manual_credential_123',
      COMPOSIO_ORG: 'encrypted:org-1',
    });
  });
});
