jest.mock('@/lib/config.server', () => ({
  KILOCLAW_COMPOSIO_MANAGED_ONBOARDING_ENABLED: true,
  COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID: 'auth-config-1',
  COMPOSIO_MANAGED_IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}));

jest.mock('@/lib/kiloclaw/composio-client', () => ({
  createComposioConnectLink: jest.fn(),
  listComposioConnectedAccounts: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/composio-identities', () => ({
  ensureManagedComposioIdentity: jest.fn(),
  getActiveManagedComposioIdentity: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn(),
}));

const selectedConfigRows: Array<{ source: 'managed' | 'manual' } | undefined> = [];

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(async () => {
            const next = selectedConfigRows.shift();
            return next ? [next] : [];
          }),
        })),
      })),
    })),
    insert: jest.fn(),
    delete: jest.fn(),
  },
}));

import { listComposioConnectedAccounts } from '@/lib/kiloclaw/composio-client';
import { getActiveManagedComposioIdentity } from '@/lib/kiloclaw/composio-identities';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import {
  completeManagedComposioGoogleCalendarConnection,
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
};

function mockManagedIdentity() {
  mockedGetActiveManagedComposioIdentity.mockResolvedValue({
    row: { id: 'identity-1' },
    agentKey: 'agent-key',
    userApiKey: 'uak_123',
    apiKey: 'api-key',
    org: 'org-1',
    consumerUserId: 'kiloclaw:user:user-1',
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  selectedConfigRows.length = 0;
  mockManagedIdentity();
  mockedListComposioConnectedAccounts.mockResolvedValue([
    { id: 'ca_123', status: 'ACTIVE' },
  ] as never);
});

describe('getManagedComposioGoogleCalendarStatus', () => {
  it('does not report connected when the Composio account exists but sandbox secrets are missing', async () => {
    selectedConfigRows.push({ source: 'managed' });

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
    selectedConfigRows.push({ source: 'managed' });

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
    selectedConfigRows.push({ source: 'manual' });

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
    selectedConfigRows.push({ source: 'manual' });

    const result = await completeManagedComposioGoogleCalendarConnection({
      userId: 'user-1',
      instance,
      scope,
      connectedAccountId: 'ca_123',
    });

    expect(result).toBe(false);
    expect(mockedKiloClawInternalClient).not.toHaveBeenCalled();
  });
});
