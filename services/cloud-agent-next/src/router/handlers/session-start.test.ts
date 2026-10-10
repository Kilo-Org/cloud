import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';

import { t } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionStartHandlers } from './session-start.js';

const {
  mergeProfileConfigurationMock,
  loadEnvironmentForSessionMock,
  assertKiloModelAvailableMock,
  assertRepositoryAccessMock,
  assertOrganizationMembershipMock,
  startNewSessionMock,
} = vi.hoisted(() => ({
  mergeProfileConfigurationMock: vi.fn().mockResolvedValue({}),
  loadEnvironmentForSessionMock: vi.fn().mockResolvedValue({}),
  assertKiloModelAvailableMock: vi.fn().mockResolvedValue(undefined),
  assertRepositoryAccessMock: vi.fn().mockResolvedValue(undefined),
  assertOrganizationMembershipMock: vi.fn().mockResolvedValue(undefined),
  startNewSessionMock: vi.fn().mockResolvedValue({
    cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
    kiloSessionId: 'cli-session-abc123',
    admission: {
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      compatibilityDelivery: 'queued',
    },
  }),
}));

vi.mock('@kilocode/cloud-agent-profile', async importActual => {
  const actual = await importActual<typeof CloudAgentProfile>();
  return {
    ...actual,
    mergeProfileConfiguration: mergeProfileConfigurationMock,
    loadEnvironmentForSession: loadEnvironmentForSessionMock,
  };
});

vi.mock('../../db/pg.js', () => ({
  getPgDb: vi.fn(() => ({ mockedDb: true })),
}));

vi.mock('../../model-validation.js', () => ({
  assertKiloModelAvailable: assertKiloModelAvailableMock,
}));

vi.mock('../../session/validate-repository-access.js', () => ({
  assertRepositoryAccessBeforeSessionCreation: assertRepositoryAccessMock,
}));

vi.mock('./organization-membership.js', () => ({
  assertOrganizationMembership: assertOrganizationMembershipMock,
}));

vi.mock('../../session/session-registration.js', () => ({
  startNewSession: startNewSessionMock,
}));

const handlers = createSessionStartHandlers();
const router = t.router({ start: handlers.start });

function createContext(): TRPCContext {
  return {
    userId: 'test-user-123',
    authToken: 'test-auth-token',
    request: { headers: new Headers() } as Request,
    env: {
      HYPERDRIVE: { connectionString: 'postgres://handler-test' },
    } as unknown as TRPCContext['env'],
  } as TRPCContext;
}

describe('startSession environment propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mergeProfileConfigurationMock.mockResolvedValue({});
    loadEnvironmentForSessionMock.mockResolvedValue({});
    assertRepositoryAccessMock.mockResolvedValue(undefined);
    assertOrganizationMembershipMock.mockResolvedValue(undefined);
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
    startNewSessionMock.mockResolvedValue({
      cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      admission: {
        success: true,
        outcome: 'queued',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        compatibilityDelivery: 'queued',
      },
    });
  });

  it('retains environmentId and its merged configuration through to the grouped create request', async () => {
    const environmentId = '123e4567-e89b-12d3-a456-426614174099';
    loadEnvironmentForSessionMock.mockResolvedValueOnce({
      envVars: { ENV_ONLY: 'from-environment' },
      setupCommands: ['env-setup'],
    });
    const caller = router.createCaller(createContext());

    await caller.start({
      message: { prompt: 'Use environment' },
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: { type: 'github', repo: 'acme/repo' },
      environmentId,
    });

    expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(
      { mockedDb: true },
      expect.objectContaining({ environmentId })
    );
    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId,
        profile: expect.objectContaining({
          resolved: expect.objectContaining({
            envVars: { ENV_ONLY: 'from-environment' },
            setupCommands: ['env-setup'],
          }),
        }),
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      { billingOrigin: 'cloud-agent' }
    );
  });

  it('omits environmentId when the client does not select one', async () => {
    const caller = router.createCaller(createContext());

    await caller.start({
      message: { prompt: 'No environment' },
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: { type: 'github', repo: 'acme/repo' },
    });

    expect(loadEnvironmentForSessionMock).not.toHaveBeenCalled();
    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: undefined }),
      expect.any(Object),
      { billingOrigin: 'cloud-agent' }
    );
  });
});
