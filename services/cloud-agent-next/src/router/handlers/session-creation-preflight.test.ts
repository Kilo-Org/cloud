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
  assertEnvironmentRepositoriesAccessMock,
  assertOrganizationMembershipMock,
  parentRuntimeTokenMock,
  balanceMock,
} = vi.hoisted(() => ({
  db: { mockedDb: true },
  mergeProfileConfigurationMock: vi.fn(),
  loadEnvironmentForSessionMock: vi.fn(),
  assertKiloModelAvailableMock: vi.fn(),
  assertRepositoryAccessMock: vi.fn(),
  assertEnvironmentRepositoriesAccessMock: vi.fn(),
  assertOrganizationMembershipMock: vi.fn(),
  parentRuntimeTokenMock: vi.fn(),
  balanceMock: vi.fn(),
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
  assertEnvironmentRepositoriesAccess: assertEnvironmentRepositoriesAccessMock,
}));

vi.mock('./organization-membership.js', () => ({
  assertOrganizationMembership: assertOrganizationMembershipMock,
}));

vi.mock('../../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: () => ({ getCloudAgentSpawnRuntimeToken: parentRuntimeTokenMock }),
}));
vi.mock('../../balance-validation.js', () => ({ validateBalanceOnly: balanceMock }));

import {
  preflightSessionCreation,
  profileResolutionPolicyForSessionCreateOrigin,
} from './session-creation-preflight.js';

function environmentLoad(
  layer: Record<string, unknown>,
  environmentId: string,
  sandboxAllocation: string | null = null
) {
  return {
    layer,
    sandboxAllocation,
    reference: {
      environmentId,
      owner: { type: 'user' as const, id: 'user-123' },
      configurationRevision: 3,
      repository: { platform: 'github' as const, repoFullName: 'acme/repo' },
    },
  };
}

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
    loadEnvironmentForSessionMock.mockResolvedValue({ status: 'none' });
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
    assertRepositoryAccessMock.mockResolvedValue(undefined);
    assertEnvironmentRepositoriesAccessMock.mockResolvedValue(undefined);
    assertOrganizationMembershipMock.mockResolvedValue(undefined);
    parentRuntimeTokenMock.mockResolvedValue('trusted-parent-model-token');
    balanceMock.mockResolvedValue({ success: true });
  });

  it('checks current parent authority and billing using trusted runtime credentials, not the scoped bearer', async () => {
    const authority = {
      version: 1 as const,
      ownerId: context.userId,
      parentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const creation = request({
      parentCloudAgentSessionId: authority.parentSessionId,
      options: { createdOnPlatform: 'cloud-agent' },
    });
    const scopedContext = {
      ...context,
      authToken: jwt.sign({ aud: 'cloud-agent-next' }, 'fixture'),
      cloudAgentAuthority: authority,
    };
    const resolved = await preflightSessionCreation(creation, scopedContext, 'prepareSession');
    expect(parentRuntimeTokenMock).toHaveBeenCalledWith(authority);
    expect(balanceMock).toHaveBeenCalledWith('trusted-parent-model-token', undefined, context.env);
    expect(assertRepositoryAccessMock).toHaveBeenCalled();
    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
    expect(resolved.parentCloudAgentSessionId).toBe(authority.parentSessionId);
    expect(resolved.allowSubagentSessions).not.toBe(true);
    balanceMock.mockClear();
    const freeContext = {
      ...scopedContext,
      env: { ...context.env, INTERNAL_API_SECRET: 'fixture-internal-secret' },
      request: new Request('https://fixture.invalid/trpc/prepareSession', {
        headers: {
          'x-internal-api-key': 'fixture-internal-secret',
          'x-skip-balance-check': 'true',
        },
      }),
    };
    await preflightSessionCreation(creation, freeContext, 'prepareSession');
    expect(balanceMock).not.toHaveBeenCalled();
    await preflightSessionCreation(
      creation,
      {
        ...freeContext,
        request: new Request('https://fixture.invalid/trpc/prepareSession', {
          headers: { 'x-internal-api-key': 'forged', 'x-skip-balance-check': 'true' },
        }),
      },
      'prepareSession'
    );
    expect(balanceMock).toHaveBeenCalledOnce();
    parentRuntimeTokenMock.mockRejectedValueOnce(new Error('parent revoked'));
    assertRepositoryAccessMock.mockClear();
    await expect(
      preflightSessionCreation(creation, scopedContext, 'prepareSession')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(assertRepositoryAccessMock).not.toHaveBeenCalled();
  });

  it('does not bypass existing billing or accept mismatched lineage', async () => {
    const authority = {
      version: 1 as const,
      ownerId: context.userId,
      parentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const scopedContext = { ...context, cloudAgentAuthority: authority };
    const creation = request({ parentCloudAgentSessionId: authority.parentSessionId });
    balanceMock.mockResolvedValueOnce({
      success: false,
      status: 402,
      message: 'Insufficient credits',
    });
    await expect(
      preflightSessionCreation(creation, scopedContext, 'prepareSession')
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    for (const parentCloudAgentSessionId of ['workspace_other', undefined]) {
      await expect(
        preflightSessionCreation(
          request({ parentCloudAgentSessionId }),
          scopedContext,
          'prepareSession'
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
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

  it.each(['cloud-agent-web', 'slack', 'github', 'linear', 'discord'])(
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
    const webOptions = { createdOnPlatform: 'cloud-agent-web' };

    it('resolves the repository environment on an approved origin and merges it under the profile layers', async () => {
      const layer = { envVars: { FROM_ENV: 'env' }, setupCommands: ['env-command'] };
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        status: 'match',
        environment: environmentLoad(layer, environmentId, 'cloudflare-containers-standard-4'),
      });
      mergeProfileConfigurationMock.mockResolvedValueOnce({
        envVars: { FROM_ENV: 'env' },
        setupCommands: ['env-command'],
      });

      const resolved = await preflightSessionCreation(
        request({ repository: githubRepository, options: webOptions }),
        context,
        'prepareSession'
      );

      expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(db, {
        owner: { type: 'user', id: 'user-123' },
        repository: { platform: 'github', repoFullName: 'acme/repo' },
      });
      expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ environment: layer })
      );
      expect(resolved.profile?.resolved?.setupCommands).toEqual(['env-command']);
      expect(resolved.environment).toEqual(environmentLoad({}, environmentId).reference);
      expect(resolved.environmentSandboxAllocation).toBe('cloudflare-containers-standard-4');
    });

    it('omits the allocation when the environment has none', async () => {
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        status: 'match',
        environment: environmentLoad({}, environmentId),
      });

      const resolved = await preflightSessionCreation(
        request({ repository: githubRepository, options: webOptions }),
        context,
        'prepareSession'
      );

      expect(loadEnvironmentForSessionMock).toHaveBeenCalledOnce();
      expect(resolved.environment?.environmentId).toBe(environmentId);
      expect(resolved).not.toHaveProperty('environmentSandboxAllocation');
    });

    it.each([
      { name: 'no origin', options: undefined },
      { name: 'code review', options: { createdOnPlatform: 'code-review' } },
      { name: 'security agent', options: { createdOnPlatform: 'security-agent' } },
    ])(
      'does not apply an environment for $name, even with an explicit profile',
      async ({ options }) => {
        const resolved = await preflightSessionCreation(
          request({
            repository: githubRepository,
            profile: { id: '123e4567-e89b-12d3-a456-426614174011' },
            ...(options ? { options } : {}),
          }),
          context,
          'start'
        );

        expect(loadEnvironmentForSessionMock).not.toHaveBeenCalled();
        expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
          db,
          expect.objectContaining({ environment: undefined })
        );
        expect(resolved.environment).toBeUndefined();
      }
    );

    it('drops a client-supplied environment reference and allocation', async () => {
      const resolved = await preflightSessionCreation(
        request({
          repository: githubRepository,
          options: webOptions,
          environment: environmentLoad({}, environmentId).reference,
          environmentSandboxAllocation: 'vercel-large',
        }),
        context,
        'prepareSession'
      );

      expect(resolved.environment).toBeUndefined();
      expect(resolved.environmentSandboxAllocation).toBeUndefined();
    });

    it('runs without an environment when the repository has none', async () => {
      const resolved = await preflightSessionCreation(
        request({ repository: githubRepository, options: webOptions }),
        context,
        'prepareSession'
      );

      expect(loadEnvironmentForSessionMock).toHaveBeenCalledOnce();
      expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ environment: undefined })
      );
      expect(resolved.environment).toBeUndefined();
    });

    describe('several environments contain the repository', () => {
      const conflict = {
        status: 'conflict' as const,
        environments: [
          { id: '123e4567-e89b-12d3-a456-426614174001', name: 'Frontend' },
          { id: '123e4567-e89b-12d3-a456-426614174002', name: 'Full stack' },
        ],
      };

      it('fails a start that requires a choice, and names the environments', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(conflict);

        const error = await preflightSessionCreation(
          request({
            repository: githubRepository,
            options: webOptions,
            requireEnvironmentChoice: true,
          }),
          context,
          'prepareSession'
        ).catch((caught: unknown) => caught);

        expect(error).toMatchObject({ code: 'CONFLICT' });
        expect((error as Error).message).toContain(
          '"Frontend" (123e4567-e89b-12d3-a456-426614174001)'
        );
        expect((error as Error).message).toContain(
          '"Full stack" (123e4567-e89b-12d3-a456-426614174002)'
        );
        expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
      });

      it.each([
        { name: 'a browser web start', options: { ...webOptions, clientProvenance: 'browser' } },
        { name: 'a mobile web start', options: { ...webOptions, clientProvenance: 'mobile' } },
        { name: 'a web start without provenance', options: webOptions },
      ] as const)('resolves no environment for $name without the marker', async ({ options }) => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(conflict);

        const resolved = await preflightSessionCreation(
          request({ repository: githubRepository, options }),
          context,
          'prepareSession'
        );

        expect(resolved.environment).toBeUndefined();
        expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
          db,
          expect.objectContaining({ environment: undefined })
        );
      });

      it.each(['slack', 'github', 'linear', 'discord', 'webhook', 'scheduled'])(
        'fails a start that requires a choice for the automatic origin %s',
        async origin => {
          loadEnvironmentForSessionMock.mockResolvedValueOnce(conflict);

          await expect(
            preflightSessionCreation(
              request({
                repository: githubRepository,
                options: { createdOnPlatform: origin },
                requireEnvironmentChoice: true,
              }),
              context,
              'prepareSession'
            )
          ).rejects.toMatchObject({ code: 'CONFLICT' });
          expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
        }
      );

      it('resolves the selected environment, with no conflict, when an id is sent', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce({
          status: 'match',
          environment: environmentLoad({ envVars: { A: '1' } }, environmentId),
        });

        const resolved = await preflightSessionCreation(
          request({
            repository: githubRepository,
            options: webOptions,
            requestedEnvironment: { id: environmentId },
            requireEnvironmentChoice: true,
          }),
          context,
          'prepareSession'
        );

        expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(
          db,
          expect.objectContaining({ environmentId })
        );
        expect(resolved.environment).toMatchObject({ environmentId });
      });

      it.each(['slack', 'github', 'linear', 'discord', 'webhook', 'scheduled'])(
        'resolves no environment for the automatic origin %s',
        async origin => {
          loadEnvironmentForSessionMock.mockResolvedValueOnce(conflict);

          const resolved = await preflightSessionCreation(
            request({ repository: githubRepository, options: { createdOnPlatform: origin } }),
            context,
            'prepareSession'
          );

          expect(resolved.environment).toBeUndefined();
          expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ environment: undefined })
          );
        }
      );
    });

    it('fails with a specific error when the requested environment is not found', async () => {
      loadEnvironmentForSessionMock.mockResolvedValueOnce({ status: 'requested-not-found' });

      await expect(
        preflightSessionCreation(
          request({
            repository: githubRepository,
            options: webOptions,
            requestedEnvironment: { id: environmentId },
          }),
          context,
          'prepareSession'
        )
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'The selected environment was not found',
      });
    });

    it('fails with a specific error when the requested environment lacks the repository', async () => {
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        status: 'requested-without-repository',
      });

      await expect(
        preflightSessionCreation(
          request({
            repository: githubRepository,
            options: webOptions,
            requestedEnvironment: { id: environmentId },
          }),
          context,
          'prepareSession'
        )
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'The selected environment does not contain this repository',
      });
    });

    describe('additional repositories of the selected environment', () => {
      const repositoryOf = (repoFullName: string) => ({
        identity: { platform: 'github' as const, repoFullName },
        repoFullName,
        leaf: repoFullName.split('/')[1],
      });
      const v2Match = {
        status: 'match' as const,
        environment: {
          layer: {},
          sandboxAllocation: null,
          reference: {
            environmentId,
            owner: { type: 'user' as const, id: 'user-123' },
            configurationRevision: 3,
            repositories: [repositoryOf('acme/repo'), repositoryOf('acme/api')],
          },
        },
      };
      const preflight = (requestedEnvironment: SessionCreateRequest['requestedEnvironment']) =>
        preflightSessionCreation(
          request({ repository: githubRepository, options: webOptions, requestedEnvironment }),
          context,
          'prepareSession'
        );

      it('accepts a member that is not the launch repository and keeps the selection', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(v2Match);
        const requestedEnvironment = {
          id: environmentId,
          repositories: [{ repoFullName: 'Acme/API', branch: 'feature/api' }],
        };

        const resolved = await preflight(requestedEnvironment);

        expect(resolved.requestedEnvironment).toEqual(requestedEnvironment);
        expect(resolved.environment?.repositories?.map(entry => entry.repoFullName)).toEqual([
          'acme/repo',
          'acme/api',
        ]);
      });

      it('authorizes the members of the resolved environment against the launch repository', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(v2Match);

        await preflight(undefined);

        expect(assertEnvironmentRepositoriesAccessMock).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'user-123',
            repository: { type: 'github', repo: 'acme/repo' },
            environment: expect.objectContaining({
              repositories: [
                expect.objectContaining({ repoFullName: 'acme/repo' }),
                expect.objectContaining({ repoFullName: 'acme/api' }),
              ],
            }),
          })
        );
      });

      it('fails the start before the endpoint check when a member is not authorized', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(v2Match);
        const endpointValidator = vi.fn();
        assertEnvironmentRepositoriesAccessMock.mockRejectedValueOnce(
          new TRPCError({ code: 'BAD_REQUEST', message: 'Repository acme/api: not installed' })
        );

        await expect(
          preflightSessionCreation(
            request({ repository: githubRepository, options: webOptions }),
            context,
            'start',
            endpointValidator
          )
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('acme/api'),
        });

        expect(endpointValidator).not.toHaveBeenCalled();
        expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
      });

      it('rejects a repository that is not a member and names it', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(v2Match);

        await expect(
          preflight({ id: environmentId, repositories: [{ repoFullName: 'acme/other' }] })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('acme/other'),
        });
      });

      it('rejects the launch repository and names it', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(v2Match);

        await expect(
          preflight({ id: environmentId, repositories: [{ repoFullName: 'acme/repo' }] })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('acme/repo'),
        });
      });

      it('rejects a repository that is listed twice and names it', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(v2Match);

        await expect(
          preflight({
            id: environmentId,
            repositories: [{ repoFullName: 'acme/api' }, { repoFullName: 'ACME/api' }],
          })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('ACME/api'),
        });
      });

      it('rejects an entry for a V1 environment and names the repository', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce({
          status: 'match',
          environment: environmentLoad({}, environmentId),
        });

        await expect(
          preflight({ id: environmentId, repositories: [{ repoFullName: 'acme/api' }] })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('acme/api'),
        });
      });

      it('rejects an entry when no environment resolved and names the repository', async () => {
        await expect(
          preflight({ id: environmentId, repositories: [{ repoFullName: 'acme/api' }] })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining('acme/api'),
        });
      });

      it('accepts a selection with no additional repositories for either environment kind', async () => {
        loadEnvironmentForSessionMock.mockResolvedValueOnce(v2Match);
        await expect(preflight({ id: environmentId })).resolves.toMatchObject({
          environment: { environmentId },
        });
        loadEnvironmentForSessionMock.mockResolvedValueOnce({
          status: 'match',
          environment: environmentLoad({}, environmentId),
        });
        await expect(preflight({ id: environmentId, repositories: [] })).resolves.toMatchObject({
          environment: { environmentId },
        });
      });
    });

    it('looks up an organization launch under the organization owner', async () => {
      const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

      await preflightSessionCreation(
        request({
          repository: githubRepository,
          options: { ...webOptions, kilocodeOrganizationId: organizationId },
        }),
        context,
        'start'
      );

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
        name: 'self-hosted gitlab',
        repository: {
          type: 'gitlab' as const,
          url: 'https://GitLab.Example.com/group/sub/project.git',
        },
        identity: {
          platform: 'gitlab',
          cloneUrl: 'https://gitlab.example.com/group/sub/project.git',
        },
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
      'looks up a $name repository by its canonical identity',
      async ({ repository, identity }) => {
        await preflightSessionCreation(
          request({ repository, options: webOptions }),
          context,
          'start'
        );

        expect(loadEnvironmentForSessionMock).toHaveBeenCalledWith(
          db,
          expect.objectContaining({ repository: identity })
        );
      }
    );

    it.each([
      {
        name: 'a generic git repository',
        repository: { type: 'git' as const, url: 'https://example.com/repo.git' },
      },
      { name: 'an invalid GitLab URL', repository: { type: 'gitlab' as const, url: 'not a url' } },
    ])('starts $name without an environment', async ({ repository }) => {
      const resolved = await preflightSessionCreation(
        request({ repository, options: webOptions }),
        context,
        'start'
      );

      expect(loadEnvironmentForSessionMock).not.toHaveBeenCalled();
      expect(resolved).not.toHaveProperty('environmentSandboxAllocation');
      expect(resolved.environment).toBeUndefined();
    });

    it('rejects an over-limit merged plaintext value with a fixed message and no value', async () => {
      const longValue = 'x'.repeat(300);
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        status: 'match',
        environment: environmentLoad({ envVars: { LONG_PLAINTEXT: longValue } }, environmentId),
      });
      mergeProfileConfigurationMock.mockResolvedValueOnce({
        envVars: { LONG_PLAINTEXT: longValue },
      });

      const error: unknown = await preflightSessionCreation(
        request({ repository: githubRepository, options: webOptions }),
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
      const setupCommands = Array.from({ length: 21 }, (_, index) => `command ${index}`);
      loadEnvironmentForSessionMock.mockResolvedValueOnce({
        status: 'match',
        environment: environmentLoad({ setupCommands }, environmentId),
      });
      mergeProfileConfigurationMock.mockResolvedValueOnce({ setupCommands });

      await expect(
        preflightSessionCreation(
          request({ repository: githubRepository, options: webOptions }),
          context,
          'start'
        )
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'resolved configuration exceeds session limits',
      });
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
