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
  // Production code branches on `instanceof KiloClawApiError`; the mock must
  // export a real class so retry/terminal paths exercise that boundary.
  KiloClawApiError: class KiloClawApiError extends Error {
    readonly statusCode: number;
    readonly responseBody: string;

    constructor(statusCode: number, responseBody = '') {
      super(`KiloClaw API error (${statusCode})`);
      this.name = 'KiloClawApiError';
      this.statusCode = statusCode;
      this.responseBody = responseBody;
    }
  },
  KiloClawInternalClient: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/encryption', () => ({
  encryptKiloClawSecret: jest.fn((value: string) => `encrypted:${value}`),
}));

const selectedRows: unknown[][] = [];
const updateSets: unknown[] = [];

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
      set: jest.fn((values: unknown) => {
        updateSets.push(values);
        return {
          where: jest.fn(async () => undefined),
        };
      }),
    })),
    delete: jest.fn(),
  },
}));

import { listComposioConnectedAccounts } from '@/lib/kiloclaw/composio-client';
import { getActiveManagedComposioIdentity } from '@/lib/kiloclaw/composio-identities';
import { KiloClawApiError, KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
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

function mockManagedIdentity(connectedAccountId: string | null = 'ca_123') {
  mockedGetActiveManagedComposioIdentity.mockResolvedValue({
    row: {
      id: 'identity-1',
      composio_project_id: 'project-1',
      google_calendar_connected_account_id: connectedAccountId,
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
  updateSets.length = 0;
  mockManagedIdentity();
  mockedKiloClawInternalClient.mockImplementation(
    () => ({ patchSecrets: jest.fn(async () => ({})) }) as unknown as KiloClawInternalClient
  );
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
    expect(mockedListComposioConnectedAccounts).not.toHaveBeenCalled();
  });

  it('does not report connected when the current sandbox is not marked managed', async () => {
    selectedRows.push([{ source: null }]);

    const status = await getManagedComposioGoogleCalendarStatus({
      scope,
      instance,
      sandboxHasComposioSecrets: true,
    });

    expect(status).toEqual({
      enabled: true,
      status: 'disconnected',
      connectedAccountId: null,
      sandboxConfigSource: null,
    });
    expect(mockedGetActiveManagedComposioIdentity).not.toHaveBeenCalled();
    expect(mockedListComposioConnectedAccounts).not.toHaveBeenCalled();
  });

  it('reports connected when identity has a stored connected account id and the sandbox has managed secrets', async () => {
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
    expect(mockedListComposioConnectedAccounts).not.toHaveBeenCalled();
  });

  it('reports connected before provision when the owner identity has a stored account id', async () => {
    const status = await getManagedComposioGoogleCalendarStatus({
      scope,
      instance: null,
      sandboxHasComposioSecrets: false,
    });

    expect(status).toEqual({
      enabled: true,
      status: 'connected',
      connectedAccountId: 'ca_123',
      sandboxConfigSource: null,
    });
    expect(mockedListComposioConnectedAccounts).not.toHaveBeenCalled();
  });

  it('reports disconnected when identity has no stored connected account id', async () => {
    mockManagedIdentity(null);

    const status = await getManagedComposioGoogleCalendarStatus({
      scope,
      instance: null,
      sandboxHasComposioSecrets: false,
    });

    expect(status).toEqual({
      enabled: true,
      status: 'disconnected',
      connectedAccountId: null,
      sandboxConfigSource: null,
    });
    expect(mockedListComposioConnectedAccounts).not.toHaveBeenCalled();
  });

  it('reports disconnected when instance is manual, even with a stored connected account id', async () => {
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
    expect(mockedGetActiveManagedComposioIdentity).not.toHaveBeenCalled();
    expect(mockedListComposioConnectedAccounts).not.toHaveBeenCalled();
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

  it('returns false when the connected account is not in the caller account list', async () => {
    mockedListComposioConnectedAccounts.mockResolvedValue([
      { id: 'ca_other', status: 'ACTIVE' },
    ] as never);

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance,
      scope,
      connectedAccountId: 'ca_123',
    });

    expect(result).toBe(false);
    expect(mockedKiloClawInternalClient).not.toHaveBeenCalled();
    expect(updateSets).toEqual([]);
  });

  it('accepts any Composio account status and patches managed credentials through workerInstanceId routing', async () => {
    selectedRows.push([{ source: 'managed' }]);
    mockedListComposioConnectedAccounts.mockResolvedValue([
      { id: 'ca_123', status: 'INITIATED' },
    ] as never);
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
    expect(updateSets).toEqual([
      { google_calendar_connected_account_id: 'ca_123' },
      { composio_config_source: 'managed' },
    ]);
  });

  it('retries worker patchSecrets on 5xx and succeeds within the retry budget', async () => {
    selectedRows.push([{ source: 'managed' }]);
    const backoffs: number[] = [];
    const patchSecrets = jest
      .fn()
      .mockRejectedValueOnce(new KiloClawApiError(503, 'temporary outage'))
      .mockResolvedValueOnce({});
    mockedKiloClawInternalClient.mockImplementation(
      () => ({ patchSecrets }) as unknown as KiloClawInternalClient
    );

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance,
      scope,
      connectedAccountId: 'ca_123',
      patchSecretsBackoff: async ms => {
        backoffs.push(ms);
      },
    });

    expect(result).toBe(true);
    expect(patchSecrets).toHaveBeenCalledTimes(2);
    expect(backoffs).toEqual([250]);
    expect(updateSets).toEqual([
      { google_calendar_connected_account_id: 'ca_123' },
      { composio_config_source: 'managed' },
    ]);
  });

  it('returns false and writes nothing when worker patchSecrets exhausts retries', async () => {
    selectedRows.push([{ source: 'managed' }]);
    const backoffs: number[] = [];
    const patchSecrets = jest.fn(async () => {
      throw new KiloClawApiError(503, 'temporary outage');
    });
    mockedKiloClawInternalClient.mockImplementation(
      () => ({ patchSecrets }) as unknown as KiloClawInternalClient
    );
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance,
      scope,
      connectedAccountId: 'ca_123',
      patchSecretsBackoff: async ms => {
        backoffs.push(ms);
      },
    });

    expect(result).toBe(false);
    expect(patchSecrets).toHaveBeenCalledTimes(3);
    expect(backoffs).toEqual([250, 750]);
    expect(updateSets).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Managed Composio patchSecrets failed',
      expect.objectContaining({
        operation: 'patchSecrets',
        identityId: 'identity-1',
        instanceId: instance.id,
        status: 503,
        responseExcerpt: 'temporary outage',
        attempt: 3,
      })
    );
    consoleErrorSpy.mockRestore();
  });

  it('returns false and logs when worker patchSecrets returns terminal 4xx', async () => {
    selectedRows.push([{ source: 'managed' }]);
    const backoffs: number[] = [];
    const patchSecrets = jest.fn(async () => {
      throw new KiloClawApiError(400, 'bad contract');
    });
    mockedKiloClawInternalClient.mockImplementation(
      () => ({ patchSecrets }) as unknown as KiloClawInternalClient
    );
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance,
      scope,
      connectedAccountId: 'ca_123',
      patchSecretsBackoff: async ms => {
        backoffs.push(ms);
      },
    });

    expect(result).toBe(false);
    expect(patchSecrets).toHaveBeenCalledTimes(1);
    expect(backoffs).toEqual([]);
    expect(updateSets).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Managed Composio patchSecrets failed',
      expect.objectContaining({
        operation: 'patchSecrets',
        identityId: 'identity-1',
        instanceId: instance.id,
        status: 400,
        responseExcerpt: 'bad contract',
        attempt: 1,
      })
    );
    consoleErrorSpy.mockRestore();
  });

  it('records the connected account without patching secrets before an instance exists', async () => {
    const patchSecrets = jest.fn(async () => ({}));
    mockedKiloClawInternalClient.mockImplementation(
      () => ({ patchSecrets }) as unknown as KiloClawInternalClient
    );

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance: null,
      scope,
      connectedAccountId: 'ca_123',
    });

    expect(result).toBe(true);
    expect(patchSecrets).not.toHaveBeenCalled();
    expect(updateSets[0]).toMatchObject({
      google_calendar_connected_account_id: 'ca_123',
    });
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
        composioUserApiKey: 'uak_manual_credential_123',
        composioOrg: 'manual-org',
        otherSecret: 'kept',
      },
    });

    expect(result).toEqual({
      secrets: {
        composioUserApiKey: 'uak_manual_credential_123',
        composioOrg: 'manual-org',
        otherSecret: 'kept',
      },
      configToMark: { source: 'manual' },
    });
    expect(mockedGetActiveManagedComposioIdentity).not.toHaveBeenCalled();
  });

  it('rejects invalid pre-provision manual Composio credentials', async () => {
    await expect(
      buildComposioProvisionSecrets({
        scope,
        secrets: {
          composioUserApiKey: 'uak_short',
          composioOrg: 'manual-org',
        },
      })
    ).rejects.toThrow('Composio user API keys start with uak_');
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

  it('blocks first provision while a managed Composio connect attempt has no durable marker', async () => {
    mockedGetActiveManagedComposioIdentity.mockResolvedValue({
      row: {
        id: 'identity-1',
        composio_project_id: 'project-1',
        google_calendar_connected_account_id: null,
      },
      agentKey: 'agent-key',
      userApiKey: 'uak_123',
      apiKey: 'api-key',
      org: 'org-1',
      consumerUserId: 'consumer-user-1',
    } as never);

    await expect(buildComposioProvisionSecrets({ scope })).rejects.toThrow(
      'Managed Composio connection is still completing'
    );
  });

  it('allows an explicit Tools skip to provision while a managed connect attempt is incomplete', async () => {
    mockedGetActiveManagedComposioIdentity.mockResolvedValue({
      row: {
        id: 'identity-1',
        composio_project_id: 'project-1',
        google_calendar_connected_account_id: null,
      },
      agentKey: 'agent-key',
      userApiKey: 'uak_123',
      apiKey: 'api-key',
      org: 'org-1',
      consumerUserId: 'consumer-user-1',
    } as never);

    await expect(
      buildComposioProvisionSecrets({ scope, skipIncompleteManagedConnection: true })
    ).resolves.toEqual({ secrets: undefined, configToMark: null });
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
