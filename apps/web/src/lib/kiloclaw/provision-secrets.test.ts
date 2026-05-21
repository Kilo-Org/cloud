jest.mock('@/lib/kiloclaw/encryption', () => ({
  encryptKiloClawSecret: jest.fn((value: string) => `encrypted:${value}`),
}));

import { encryptProvisionSecretsForWorker } from './provision-secrets';

describe('encryptProvisionSecretsForWorker', () => {
  it('maps catalog field keys to worker env var names before encrypting', () => {
    expect(
      encryptProvisionSecretsForWorker({
        composioUserApiKey: 'uak_123',
        composioOrg: 'org-1',
        CUSTOM_SECRET: 'kept',
      })
    ).toEqual({
      COMPOSIO_USER_API_KEY: 'encrypted:uak_123',
      COMPOSIO_ORG: 'encrypted:org-1',
      CUSTOM_SECRET: 'encrypted:kept',
    });
  });
});
