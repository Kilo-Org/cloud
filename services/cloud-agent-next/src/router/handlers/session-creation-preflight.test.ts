import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import type { TRPCContext } from '../../types.js';

const {
  db,
  mergeProfileConfigurationMock,
  assertKiloModelAvailableMock,
  assertRepositoryAccessMock,
  assertOrganizationMembershipMock,
} = vi.hoisted(() => ({
  db: { mockedDb: true },
  mergeProfileConfigurationMock: vi.fn(),
  assertKiloModelAvailableMock: vi.fn(),
  assertRepositoryAccessMock: vi.fn(),
  assertOrganizationMembershipMock: vi.fn(),
}));

vi.mock('@kilocode/cloud-agent-profile', async importActual => {
  const actual = await importActual<typeof CloudAgentProfile>();
  return {
    ...actual,
    mergeProfileConfiguration: mergeProfileConfigurationMock,
  };
});

vi.mock('../../db/pg.js', () => ({
  getPgDb: vi.fn(() => db),
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

import {
  preflightSessionCreation,
  profileResolutionPolicyForSessionCreateOrigin,
} from './session-creation-preflight.js';

const context = {
  env: {
    HYPERDRIVE: { connectionString: 'postgres://preflight-test' },
  } as TRPCContext['env'],
  userId: 'user-123',
  authToken: 'test-auth-token',
};

function request(overrides: Partial<SessionCreateRequest> = {}): SessionCreateRequest {
  return {
    initialTurn: { type: 'prompt', id: 'message-123', prompt: 'Test prompt' },
    agent: { mode: 'code', model: 'kilo/test-model' },
    repository: { type: 'github', repo: 'acme/repo' },
    ...overrides,
  };
}

describe('session creation preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mergeProfileConfigurationMock.mockResolvedValue({});
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
    assertRepositoryAccessMock.mockResolvedValue(undefined);
    assertOrganizationMembershipMock.mockResolvedValue(undefined);
  });

  it('owns the ordered admission path and returns profile-resolved configuration', async () => {
    const steps: string[] = [];
    const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const runtimeAgent = {
      slug: 'reviewer',
      name: 'Reviewer',
      config: { prompt: 'Review the diff', mode: 'subagent' },
    };
    assertOrganizationMembershipMock.mockImplementationOnce(async () => {
      steps.push('organization');
    });
    assertRepositoryAccessMock.mockImplementationOnce(async () => {
      steps.push('repository');
    });
    mergeProfileConfigurationMock.mockImplementationOnce(async () => {
      steps.push('profile');
      return { envVars: { RESOLVED: 'true' }, agents: [runtimeAgent] };
    });
    assertKiloModelAvailableMock.mockImplementationOnce(async () => {
      steps.push('model');
    });
    const endpointValidator = vi.fn(() => {
      steps.push('endpoint');
    });
    const input = request({
      agent: { mode: 'reviewer', model: 'kilo/test-model' },
      profile: { id: '123e4567-e89b-12d3-a456-426614174011' },
      options: {
        kilocodeOrganizationId: organizationId,
        createdOnPlatform: 'cloud-agent-web',
      },
    });

    const resolved = await preflightSessionCreation(
      input,
      context,
      'prepareSession',
      endpointValidator
    );

    expect(steps).toEqual(['organization', 'repository', 'profile', 'endpoint', 'model']);
    expect(assertOrganizationMembershipMock).toHaveBeenCalledWith(db, 'user-123', organizationId);
    expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        profileId: '123e4567-e89b-12d3-a456-426614174011',
        owner: { type: 'organization', id: organizationId },
        userId: 'user-123',
        repoFullName: 'acme/repo',
        platform: 'github',
      })
    );
    expect(endpointValidator).toHaveBeenCalledWith(resolved);
    expect(resolved).toEqual({
      ...input,
      profile: {
        ...input.profile,
        resolved: {
          envVars: { RESOLVED: 'true' },
          setupCommands: undefined,
          encryptedSecrets: undefined,
          mcpServers: undefined,
          runtimeSkills: undefined,
          runtimeAgents: [runtimeAgent],
          kiloCommands: undefined,
        },
      },
    });
    expect(assertKiloModelAvailableMock).toHaveBeenCalledWith({
      env: context.env,
      submittedModel: 'kilo/test-model',
      originalToken: 'test-auth-token',
      originalOrganizationId: organizationId,
      createdOnPlatform: 'cloud-agent-web',
      procedure: 'prepareSession',
    });
  });

  it('stops at rejected organization authorization', async () => {
    assertOrganizationMembershipMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Membership rejected' })
    );

    await expect(
      preflightSessionCreation(
        request({
          options: { kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
        }),
        context,
        'start'
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(assertRepositoryAccessMock).not.toHaveBeenCalled();
    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it('stops at rejected repository authorization', async () => {
    const endpointValidator = vi.fn();
    assertRepositoryAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Repository rejected' })
    );

    await expect(
      preflightSessionCreation(request(), context, 'start', endpointValidator)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(endpointValidator).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it.each(['cloud-agent-web', 'slack', 'github', 'linear', 'discord', 'app-builder'])(
    'resolves implicit profiles for approved %s creation',
    async createdOnPlatform => {
      await preflightSessionCreation(
        request({ options: { createdOnPlatform } }),
        context,
        'prepareSession'
      );

      expect(mergeProfileConfigurationMock).toHaveBeenCalledOnce();
    }
  );

  it.each([undefined, '', 'unknown', 'code-review'])(
    'does not resolve implicit profiles for non-approved origin %s',
    async createdOnPlatform => {
      await preflightSessionCreation(
        request({ options: { createdOnPlatform } }),
        context,
        'prepareSession'
      );

      expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    }
  );

  it('resolves an explicit profile for a non-approved origin', async () => {
    await preflightSessionCreation(
      request({
        profile: { id: '123e4567-e89b-12d3-a456-426614174011' },
        options: { createdOnPlatform: 'code-review' },
      }),
      context,
      'prepareSession'
    );

    expect(mergeProfileConfigurationMock).toHaveBeenCalledOnce();
  });

  it('accepts a built-in mode without resolved runtime agents', async () => {
    await expect(
      preflightSessionCreation(
        request({ agent: { mode: 'code', model: 'kilo/test-model' } }),
        context,
        'start'
      )
    ).resolves.toBeDefined();
  });

  it('accepts a custom mode from the resolved profile', async () => {
    mergeProfileConfigurationMock.mockResolvedValueOnce({
      agents: [
        {
          slug: 'reviewer',
          name: 'Reviewer',
          config: { prompt: 'Review the diff', mode: 'subagent' },
        },
      ],
    });

    await expect(
      preflightSessionCreation(
        request({
          agent: { mode: 'reviewer', model: 'kilo/test-model' },
          options: { createdOnPlatform: 'cloud-agent-web' },
        }),
        context,
        'start'
      )
    ).resolves.toBeDefined();
  });

  it('rejects a missing custom mode before endpoint or model validation', async () => {
    const endpointValidator = vi.fn();

    await expect(
      preflightSessionCreation(
        request({ agent: { mode: 'missing-agent', model: 'kilo/test-model' } }),
        context,
        'start',
        endpointValidator
      )
    ).rejects.toThrow('does not match any runtimeAgents');

    expect(endpointValidator).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'command',
      initialTurn: {
        type: 'command' as const,
        id: 'message-command',
        command: 'compact',
        arguments: '--aggressive',
      },
    },
    { name: 'clone-only', initialTurn: undefined },
  ])('skips model validation for a $name request', async ({ initialTurn }) => {
    await preflightSessionCreation(request({ initialTurn }), context, 'prepareSession');

    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });
});

describe('profile resolution policy', () => {
  it.each([
    { origin: 'cloud-agent-web', expected: 'include-web-defaults' },
    { origin: 'webhook', expected: 'include-web-defaults' },
    { origin: 'scheduled', expected: 'include-web-defaults' },
    { origin: undefined, expected: 'explicit-profile-only' },
    { origin: 'unknown', expected: 'explicit-profile-only' },
  ])('selects $expected for origin $origin', ({ origin, expected }) => {
    expect(profileResolutionPolicyForSessionCreateOrigin(origin)).toEqual({
      defaultProfileResolution: expected,
    });
  });
});
