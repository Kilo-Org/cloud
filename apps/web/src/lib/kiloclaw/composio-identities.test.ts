jest.mock('@/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: 'test-encryption-key',
}));

jest.mock('@/lib/encryption', () => ({
  encryptWithSymmetricKey: jest.fn((value: string) => `encrypted:${value}`),
  decryptWithSymmetricKey: jest.fn((value: string) => value.replace(/^encrypted:/, '')),
}));

jest.mock('@/lib/kiloclaw/provision-lock', () => ({
  withKiloclawProvisionContextLock: jest.fn(async (_key: string, work: () => Promise<unknown>) => {
    return await work();
  }),
}));

jest.mock('@/lib/kiloclaw/composio-client', () => ({
  getComposioAgentIdentity: jest.fn(),
  resolveComposioConsumerProject: jest.fn(),
  signupComposioAgentIdentity: jest.fn(),
}));

const selectedRows: unknown[][] = [];
const insertedRows: unknown[][] = [];
const updatedRows: unknown[][] = [];
const updateSets: unknown[] = [];

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(async () => selectedRows.shift() ?? []),
        })),
      })),
    })),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(async () => insertedRows.shift() ?? []),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((values: unknown) => {
        updateSets.push(values);
        return {
          where: jest.fn(() => ({
            returning: jest.fn(async () => updatedRows.shift() ?? []),
          })),
        };
      }),
    })),
  },
}));

import {
  getComposioAgentIdentity,
  resolveComposioConsumerProject,
  signupComposioAgentIdentity,
  type ComposioAgentIdentity,
} from '@/lib/kiloclaw/composio-client';
import { ensureManagedComposioIdentity } from './composio-identities';

const mockedGetComposioAgentIdentity = jest.mocked(getComposioAgentIdentity);
const mockedResolveComposioConsumerProject = jest.mocked(resolveComposioConsumerProject);
const mockedSignupComposioAgentIdentity = jest.mocked(signupComposioAgentIdentity);
const scope = { ownerType: 'user', userId: 'user-1' } as const;

function identityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'identity-1',
    owner_type: 'user',
    user_id: 'user-1',
    organization_id: null,
    status: 'active',
    composio_agent_key_encrypted: 'encrypted:agent-key',
    composio_user_api_key_encrypted: 'encrypted:uak_123',
    composio_api_key_encrypted: null,
    composio_org_id: 'org-1',
    composio_org_name: 'Workspace',
    composio_project_id: 'project-1',
    composio_consumer_user_id: 'consumer-user-1',
    google_calendar_connected_account_id: null,
    composio_agent_email: 'agent@example.com',
    revoked_at: null,
    ...overrides,
  };
}

function upstreamIdentity(): ComposioAgentIdentity {
  return {
    status: 'ready',
    agent_key: 'agent-key',
    slug: 'Workspace',
    email: 'agent@example.com',
    composio: {
      org_id: 'org-1',
      user_api_key: 'uak_123',
    },
  };
}

function resolveProject() {
  mockedResolveComposioConsumerProject.mockResolvedValue({
    project_id: 'project-db-id',
    project_nano_id: 'project-1',
    project_name: 'Consumer Project',
    project_type: 'CONSUMER',
    org_id: 'org-1',
    consumer_user_id: 'consumer-user-1',
  });
}

describe('ensureManagedComposioIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selectedRows.length = 0;
    insertedRows.length = 0;
    updatedRows.length = 0;
    updateSets.length = 0;
  });

  it('returns an active identity without refreshing complete context', async () => {
    selectedRows.push([identityRow()]);

    const identity = await ensureManagedComposioIdentity(scope);

    expect(identity.agentKey).toBe('agent-key');
    expect(identity.userApiKey).toBe('uak_123');
    expect(mockedGetComposioAgentIdentity).not.toHaveBeenCalled();
    expect(mockedSignupComposioAgentIdentity).not.toHaveBeenCalled();
  });

  it('refreshes an active identity with incomplete project context', async () => {
    selectedRows.push([identityRow({ composio_project_id: null })]);
    mockedGetComposioAgentIdentity.mockResolvedValue(upstreamIdentity());
    resolveProject();
    updatedRows.push([identityRow()]);

    const identity = await ensureManagedComposioIdentity(scope);

    expect(identity.row.composio_project_id).toBe('project-1');
    expect(mockedGetComposioAgentIdentity).toHaveBeenCalledWith('agent-key');
    expect(updateSets[0]).toMatchObject({
      composio_project_id: 'project-1',
      composio_consumer_user_id: 'consumer-user-1',
      status: 'active',
    });
  });

  it('reuses a stored pending reservation instead of signing up a second identity', async () => {
    selectedRows.push([identityRow({ status: 'pending', composio_project_id: null })]);
    mockedGetComposioAgentIdentity.mockResolvedValue(upstreamIdentity());
    resolveProject();
    updatedRows.push(
      [identityRow({ status: 'pending', composio_project_id: null })],
      [identityRow()]
    );

    const identity = await ensureManagedComposioIdentity(scope);

    expect(identity.row.status).toBe('active');
    expect(mockedGetComposioAgentIdentity).toHaveBeenCalledWith('agent-key');
    expect(mockedSignupComposioAgentIdentity).not.toHaveBeenCalled();
    expect(updateSets[1]).toMatchObject({
      composio_project_id: 'project-1',
      composio_consumer_user_id: 'consumer-user-1',
      status: 'active',
    });
  });
});
