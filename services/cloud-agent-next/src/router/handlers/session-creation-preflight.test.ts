import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';
import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import type { TRPCContext } from '../../types.js';

const {
  db,
  mergeProfileConfigurationMock,
  loadEnvironmentForSessionMock,
  assertKiloModelAvailableMock,
  assertRepositoryAccessMock,
  assertOrganizationMembershipMock,
} = vi.hoisted(() => ({
  db: { mockedDb: true },
  mergeProfileConfigurationMock: vi.fn(),
  loadEnvironmentForSessionMock: vi.fn(),
  assertKiloModelAvailableMock: vi.fn(),
  assertRepositoryAccessMock: vi.fn(),
  assertOrganizationMembershipMock: vi.fn(),
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
    loadEnvironmentForSessionMock.mockResolvedValue({});
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

  it.each(['aud', 'tokenPurpose', 'credentialExchange'])(
    'skips model validation for a bearer carrying %s',
    async claim => {
      await preflightSessionCreation(
        request(),
        { ...context, authToken: jwt.sign({ [claim]: 'kilo-api' }, 'preflight-test-secret') },
        'start'
      );

      expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
    }
  );

  it('validates the model for a user bearer without control-policy claims', async () => {
    await preflightSessionCreation(
      request(),
      { ...context, authToken: jwt.sign({ sub: 'user-123' }, 'preflight-test-secret') },
      'start'
    );

    expect(assertKiloModelAvailableMock).toHaveBeenCalledOnce();
  });

  describe('repository environment resolution', () => {
    const environmentId = '123e4567-e89b-12d3-a456-426614174099';
    const githubRepository = { type: 'github' as const, repo: 'acme/repo' };

    it('loads, authorizes, and merges an explicit environment without an approved origin and no profile lookups', async () => {
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        envVars: { ENV_ONLY: 'from-environment' },
        setupCommands: ['env-setup'],
      });

      const resolved = await preflightSessionCreation(
        request({ repository: githubRepository, environmentId }),
        context,
        'prepareSession'
      );

      expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(db, {
        owner: { type: 'user', id: 'user-123' },
        environmentId,
        repository: { platform: 'github', repoFullName: 'acme/repo' },
      });
      expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
      expect(resolved.profile?.resolved?.envVars).toEqual({ ENV_ONLY: 'from-environment' });
      expect(resolved.profile?.resolved?.setupCommands).toEqual(['env-setup']);
    });

    it('adds no commands or variables when the environment id is absent', async () => {
      const resolved = await preflightSessionCreation(
        request({ repository: githubRepository }),
        context,
        'prepareSession'
      );

      expect(loadEnvironmentForSessionMock).not.toHaveBeenCalled();
      expect(resolved.profile?.resolved?.envVars).toBeUndefined();
      expect(resolved.profile?.resolved?.setupCommands).toBeUndefined();
    });

    it('propagates NOT_FOUND for a foreign owner or a soft-deleted organization without leaking existence', async () => {
      loadEnvironmentForSessionMock.mockRejectedValueOnce(
        new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' })
      );

      await expect(
        preflightSessionCreation(
          request({ repository: githubRepository, environmentId }),
          context,
          'start'
        )
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Environment not found' });
      expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    });

    it('rejects a personal environment used on an organization launch under the organization owner', async () => {
      const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      loadEnvironmentForSessionMock.mockRejectedValueOnce(
        new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' })
      );

      await expect(
        preflightSessionCreation(
          request({
            repository: githubRepository,
            environmentId,
            options: { kilocodeOrganizationId: organizationId },
          }),
          context,
          'start'
        )
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ owner: { type: 'organization', id: organizationId } })
      );
      expect(assertOrganizationMembershipMock).toHaveBeenCalledWith(db, 'user-123', organizationId);
    });

    it.each([
      {
        name: 'github',
        repository: { type: 'github' as const, repo: 'acme/other' },
        identity: { platform: 'github', repoFullName: 'acme/other' },
      },
      {
        name: 'gitlab',
        repository: { type: 'gitlab' as const, url: 'https://gitlab.com/group/project' },
        identity: { platform: 'gitlab', cloneUrl: 'https://gitlab.com/group/project.git' },
      },
      {
        name: 'bitbucket',
        repository: {
          type: 'bitbucket' as const,
          url: 'https://bitbucket.org/team/repo.git',
          workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          repositoryUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        identity: {
          platform: 'bitbucket',
          workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          repositoryUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      },
    ])(
      'maps a $name repository to its canonical identity and propagates a mismatch as BAD_REQUEST',
      async ({ repository, identity }) => {
        loadEnvironmentForSessionMock.mockRejectedValueOnce(
          new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Environment does not belong to this repository',
          })
        );

        await expect(
          preflightSessionCreation(request({ repository, environmentId }), context, 'start')
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'Environment does not belong to this repository',
        });
        expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(
          db,
          expect.objectContaining({ repository: identity })
        );
      }
    );

    it('rejects a generic git repository with an environment id', async () => {
      await expect(
        preflightSessionCreation(
          request({
            repository: { type: 'git', url: 'https://example.com/repo.git' },
            environmentId,
          }),
          context,
          'start'
        )
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(loadEnvironmentForSessionMock).not.toHaveBeenCalled();
    });

    it('rejects an over-limit merged plaintext value with a fixed message and no value', async () => {
      const longValue = 'x'.repeat(300);
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        envVars: { LONG_PLAINTEXT: longValue },
      });

      const error: unknown = await preflightSessionCreation(
        request({ repository: githubRepository, environmentId }),
        context,
        'start'
      ).catch(caught => caught);

      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'resolved configuration exceeds session limits',
      });
      expect((error as Error).message).not.toContain(longValue);
    });

    it('rejects more than 20 concatenated setup commands', async () => {
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        setupCommands: Array.from({ length: 21 }, (_, index) => `command ${index}`),
      });

      await expect(
        preflightSessionCreation(
          request({ repository: githubRepository, environmentId }),
          context,
          'start'
        )
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'resolved configuration exceeds session limits',
      });
    });

    it('passes the environment as the bottom layer when the profile gate is open', async () => {
      const environment = { envVars: { FROM_ENV: 'env' }, setupCommands: ['env-command'] };
      loadEnvironmentForSessionMock.mockResolvedValueOnce(environment);
      mergeProfileConfigurationMock.mockResolvedValueOnce({ envVars: { RESOLVED: 'true' } });

      await preflightSessionCreation(
        request({
          repository: githubRepository,
          environmentId,
          options: { createdOnPlatform: 'cloud-agent-web' },
        }),
        context,
        'prepareSession'
      );

      expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ environment })
      );
    });
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
