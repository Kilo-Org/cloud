import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';

import { t } from '../auth.js';
import type { TRPCContext } from '../../types.js';
import { createSessionStartHandlers } from './session-start.js';

function environmentLoad(layer: Record<string, unknown>, sandboxAllocation: string | null = null) {
  return { layer, sandboxAllocation };
}

const {
  mergeProfileConfigurationMock,
  loadEnvironmentForSessionMock,
  assertKiloModelAvailableMock,
  assertRepositoryAccessMock,
  assertOrganizationMembershipMock,
  startNewSessionMock,
} = vi.hoisted(() => ({
  mergeProfileConfigurationMock: vi.fn().mockResolvedValue({}),
  loadEnvironmentForSessionMock: vi.fn().mockResolvedValue(null),
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
    loadEnvironmentForSessionMock.mockResolvedValue(null);
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

  it('carries the repository environment and its allocation to the grouped create request', async () => {
    const layer = { envVars: { ENV_ONLY: 'from-environment' }, setupCommands: ['env-setup'] };
    loadEnvironmentForSessionMock.mockResolvedValueOnce(
      environmentLoad(layer, 'cloudflare-containers-standard-4')
    );
    mergeProfileConfigurationMock.mockResolvedValueOnce(layer);
    const caller = router.createCaller(createContext());

    await caller.start({
      message: { prompt: 'Use environment' },
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: { type: 'github', repo: 'acme/repo' },
      options: { createdOnPlatform: 'cloud-agent-web' },
    });

    expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(
      { mockedDb: true },
      {
        owner: { type: 'user', id: 'test-user-123' },
        repository: { platform: 'github', repoFullName: 'acme/repo' },
      }
    );
    expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
      { mockedDb: true },
      expect.objectContaining({ environment: layer })
    );
    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentSandboxAllocation: 'cloudflare-containers-standard-4',
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

  it('does not look up an environment for a start without an approved origin', async () => {
    const caller = router.createCaller(createContext());

    await caller.start({
      message: { prompt: 'No environment' },
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: { type: 'github', repo: 'acme/repo' },
    });

    expect(loadEnvironmentForSessionMock).not.toHaveBeenCalled();
    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ environmentSandboxAllocation: expect.anything() }),
      expect.any(Object),
      { billingOrigin: 'cloud-agent' }
    );
  });
});
