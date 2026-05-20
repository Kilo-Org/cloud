jest.mock('@/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}));

jest.mock('@/lib/kiloclaw/composio-client', () => ({
  createComposioGoogleCalendarConnectLink: jest.fn(),
  listComposioConnectedAccounts: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/composio-identities', () => ({
  ensureManagedComposioIdentity: jest.fn(),
  getActiveManagedComposioIdentity: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/encryption', () => ({
  encryptKiloClawSecret: jest.fn((value: string) => `encrypted:${value}`),
}));

const selectedRows: unknown[][] = [];

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(async () => {
            return selectedRows.shift() ?? [];
          }),
        })),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoUpdate: jest.fn(async () => undefined),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(async () => undefined),
      })),
    })),
    delete: jest.fn(),
  },
}));

import { listComposioConnectedAccounts } from '@/lib/kiloclaw/composio-client';
import { getActiveManagedComposioIdentity } from '@/lib/kiloclaw/composio-identities';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import {
  buildComposioProvisionSecrets,
  completeManagedComposioGoogleCalendarConnection,
  composioSecretsPatchSource,
  getManagedComposioGoogleCalendarStatus,
} from './composio-onboarding';

const mockedListComposioConnectedAccounts = jest.mocked(listComposioConnectedAccounts);
const mockedGetActiveManagedComposioIdentity = jest.mocked(getActiveManagedComposioIdentity);
const mockedKiloClawInternalClient = jest.mocked(KiloClawInternalClient);

const scope = { ownerType: 'user', userId: 'user-1' } as const;
const instance = {
  id: '62f96e7b-e010-4a4f-badb-85af870b9fd9',
  userId: 'user-1',
  sandboxId: 'sandbox-1',
  organizationId: null,
  name: null,
  inboundEmailEnabled: false,
  composioConfigSource: null,
};

function mockManagedIdentity() {
  mockedGetActiveManagedComposioIdentity.mockResolvedValue({
    row: {
      id: 'identity-1',
      composio_project_id: 'project-1',
      google_calendar_connected_account_id: 'ca_123',
    },
    agentKey: 'agent-key',
    userApiKey: 'uak_123',
    apiKey: 'api-key',
    org: 'org-1',
    consumerUserId: 'consumer-user-1',
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  selectedRows.length = 0;
  mockManagedIdentity();
  mockedListComposioConnectedAccounts.mockResolvedValue([
    { id: 'ca_123', status: 'ACTIVE' },
  ] as never);
});

describe('getManagedComposioGoogleCalendarStatus', () => {
  it('does not report connected when the Composio account exists but sandbox secrets are missing', async () => {
    selectedRows.push([{ source: 'managed' }]);

    const status = await getManagedComposioGoogleCalendarStatus({
      scope,
      instance,
      sandboxHasComposioSecrets: false,
    });

    expect(status).toEqual({
      enabled: true,
      status: 'disconnected',
      connectedAccountId: null,
      sandboxConfigSource: 'managed',
    });
  });

  it('reports connected only when the account is active and the current sandbox has managed secrets', async () => {
    selectedRows.push([{ source: 'managed' }]);

    const status = await getManagedComposioGoogleCalendarStatus({
      scope,
      instance,
      sandboxHasComposioSecrets: true,
    });

    expect(status).toEqual({
      enabled: true,
      status: 'connected',
      connectedAccountId: 'ca_123',
      sandboxConfigSource: 'managed',
    });
  });

  it('keeps manual sandbox configuration separate from managed connected-account status', async () => {
    selectedRows.push([{ source: 'manual' }]);

    const status = await getManagedComposioGoogleCalendarStatus({
      scope,
      instance,
      sandboxHasComposioSecrets: true,
    });

    expect(status).toEqual({
      enabled: true,
      status: 'disconnected',
      connectedAccountId: null,
      sandboxConfigSource: 'manual',
    });
  });
});

describe('completeManagedComposioGoogleCalendarConnection', () => {
  it('does not overwrite manual credentials saved after a managed link was created', async () => {
    selectedRows.push([{ source: 'manual' }]);

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance,
      scope,
      connectedAccountId: 'ca_123',
    });

    expect(result).toBe(false);
    expect(mockedKiloClawInternalClient).not.toHaveBeenCalled();
  });

  it('patches managed credentials through workerInstanceId routing', async () => {
    selectedRows.push([{ source: 'managed' }]);
    const patchSecrets = jest.fn(async () => ({}));
    mockedKiloClawInternalClient.mockImplementation(
      () => ({ patchSecrets }) as unknown as KiloClawInternalClient
    );

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance,
      scope,
      connectedAccountId: 'ca_123',
    });

    expect(result).toBe(true);
    expect(patchSecrets).toHaveBeenCalledWith(
      'user-1',
      { secrets: expect.objectContaining({ composioUserApiKey: expect.any(String) }) },
      undefined
    );
  });
});

describe('composioSecretsPatchSource', () => {
  it('clears manual source when either manual Composio secret is removed', () => {
    expect(composioSecretsPatchSource({ composioUserApiKey: null })).toBe('clear');
    expect(composioSecretsPatchSource({ composioOrg: null })).toBe('clear');
  });
});

describe('buildComposioProvisionSecrets', () => {
  it('preserves manual Composio credentials instead of injecting managed credentials', async () => {
    const result = await buildComposioProvisionSecrets({
      scope,
      secrets: {
        composioUserApiKey: 'uak_manual',
        composioOrg: 'manual-org',
        otherSecret: 'kept',
      },
    });

    expect(result).toEqual({
      secrets: {
        composioUserApiKey: 'uak_manual',
        composioOrg: 'manual-org',
        otherSecret: 'kept',
      },
      configToMark: { source: 'manual' },
    });
    expect(mockedGetActiveManagedComposioIdentity).not.toHaveBeenCalled();
  });

  it('rehydrates previously applied managed credentials for a recreated sandbox', async () => {
    selectedRows.push([{ instanceId: 'old-instance-id' }]);

    const result = await buildComposioProvisionSecrets({
      scope,
      secrets: { otherSecret: 'kept' },
    });

    expect(result).toEqual({
      secrets: {
        otherSecret: 'kept',
        composioUserApiKey: 'uak_123',
        composioOrg: 'org-1',
      },
      configToMark: { source: 'managed' },
    });
  });

  it('does not inject managed credentials into a current manual sandbox', async () => {
    selectedRows.push([{ source: 'manual' }]);

    const result = await buildComposioProvisionSecrets({
      scope,
      instanceId: instance.id,
    });

    expect(result).toEqual({ secrets: undefined, configToMark: null });
  });

  it('rehydrates managed credentials when reprovisioning an already managed sandbox', async () => {
    selectedRows.push([{ source: 'managed' }]);

    const result = await buildComposioProvisionSecrets({
      scope,
      instanceId: instance.id,
    });

    expect(result).toEqual({
      secrets: {
        composioUserApiKey: 'uak_123',
        composioOrg: 'org-1',
      },
      configToMark: { source: 'managed' },
    });
  });
});
