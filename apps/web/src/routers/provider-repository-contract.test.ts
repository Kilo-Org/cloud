import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PlatformIntegration, User } from '@kilocode/db/schema';
import type {
  LaunchRepositoryReference,
  Owner,
} from '@kilocode/app-shared/code-review/repository-identity';
import type * as PersonalModule from './cloud-agent-next-router';
import type * as OrganizationModule from './organizations/organization-cloud-agent-next-router';
import type * as ClientModule from '@/lib/cloud-agent-next/cloud-agent-client';
import type * as GitLabModule from '@/lib/integrations/gitlab-service';
import type * as GitLabHelpers from '@/lib/cloud-agent/gitlab-integration-helpers';
import type * as GitHubService from '@/lib/integrations/github-apps-service';
import type * as TokenModule from '@/lib/integrations/platforms/bitbucket/token-service-client';
import type * as OAuthModule from '@/lib/integrations/platforms/bitbucket/oauth-integration';
import type * as WorkerSchemas from '../../../../services/cloud-agent-next/src/router/schemas';

const USER_ID = 'oauth/actor';
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const GITHUB_ID = '22222222-2222-4222-8222-222222222222';
const GITLAB_ID = '33333333-3333-4333-8333-333333333333';
const BITBUCKET_ID = '44444444-4444-4444-8444-444444444444';
const WORKSPACE_UUID = '55555555-5555-4555-8555-555555555555';
const REPOSITORY_UUID = '66666666-6666-4666-8666-666666666666';
const INSTANCE_URL = 'https://gitlab.example.com/Enterprise';
const userOwner = { type: 'user' as const, id: USER_ID };
const orgOwner = { type: 'org' as const, id: ORGANIZATION_ID };
const prepared = {
  cloudAgentSessionId: 'agent_selected',
  kiloSessionId: 'ses_12345678901234567890123456',
};
const oldGitHub = '{"prompt":"Inspect","mode":"code","model":"test/model","githubRepo":"acme/API"}';
const oldGitLab =
  '{"prompt":"Inspect","mode":"code","model":"test/model","gitlabProject":"Group/Sub/API","upstreamBranch":"release/Case"}';

function integration(owner: Owner, platform: 'github' | 'gitlab'): PlatformIntegration {
  return {
    id: platform === 'github' ? GITHUB_ID : GITLAB_ID,
    platform,
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    owned_by_user_id: owner.type === 'user' ? owner.id : null,
    owned_by_organization_id: owner.type === 'org' ? owner.id : null,
    platform_installation_id: 'installation',
    platform_account_login: 'acme',
    github_app_type: 'standard',
    repositories: [
      {
        id: 42,
        name: 'API',
        full_name: platform === 'github' ? 'acme/API' : 'Group/Sub/API',
        private: true,
        default_branch: 'release/Case',
      },
    ],
    repositories_synced_at: '2026-08-29T00:00:00.000Z',
    metadata: platform === 'gitlab' ? { gitlab_instance_url: INSTANCE_URL } : {},
  } as PlatformIntegration;
}
const mockTrpc = initTRPC.context<{ user: User }>().create();
const queries: { sql: string; params: unknown[] }[] = [];
let mockGitLabRows: PlatformIntegration[] = [];
let bitbucketResult: OAuthModule.BitbucketOrganizationRepositoryListResult;
const mockDb = {
  select: () => {
    const query = {
      from: () => query,
      where: (condition: SQL) => {
        queries.push(new PgDialect().sqlToQuery(condition));
        return query;
      },
      limit: async () => mockGitLabRows,
    };
    return query;
  },
};
const mockGitLabBranches =
  jest.fn<
    (
      token: string,
      project: string | number,
      instance: string
    ) => Promise<{ name: string; default: boolean; protected: boolean }[]>
  >();
const mockGitHubBranches = jest.fn<() => Promise<{ name: string; isDefault: boolean }[]>>();
const mockGitLabCredential =
  jest.fn<
    () => Promise<
      | { status: 'available'; token: string; instanceUrl: string }
      | { status: 'temporarily_unavailable' }
    >
  >();

jest.mock('@/lib/trpc/init', () => ({
  createTRPCRouter: mockTrpc.router,
  baseProcedure: mockTrpc.procedure,
}));
jest.mock('@/routers/organizations/utils', () => {
  const procedure = mockTrpc.procedure
    .input(z.object({ organizationId: z.uuid() }))
    .use(({ input, next }) => {
      if (input.organizationId !== ORGANIZATION_ID)
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have access to this organization',
        });
      return next();
    });
  return { organizationMemberProcedure: procedure, organizationMemberMutationProcedure: procedure };
});
jest.mock('@/lib/drizzle', () => ({ db: mockDb }));
jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal',
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.test',
}));
jest.mock('@/lib/dotenvx', () => ({ getEnvVariable: () => 'https://worker.test' }));
jest.mock('@/lib/tokens', () => ({ generateCloudAgentToken: () => 'test-token' }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/cloud-agent-next/balance-check-eligibility', () => ({
  computeCloudAgentNextBalanceCheckEligibility: async () => ({
    isFree: false,
    hasUserByokAvailable: false,
  }),
}));
jest.mock('@/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabledOrDevelopment: async () => false,
}));
jest.mock('@/lib/user/balance', () => ({}));
jest.mock('@/lib/organizations/organization-usage', () => ({}));
jest.mock('@/lib/organizations/effective-model-access.server', () => ({}));
jest.mock('@/lib/r2/cloud-agent-attachments', () => ({}));
jest.mock('@/lib/r2/cloud-agent-pending-uploads', () => ({}));
jest.mock('@/lib/cloud-agent/session-ownership', () => ({}));
jest.mock('@/lib/cloud-agent/stream-ticket', () => ({}));
jest.mock('@/lib/cloud-agent/order-repositories', () => ({
  orderRepositoriesByUsage: async ({ repositories }: { repositories: unknown[] }) => repositories,
}));
jest.mock('@/lib/agent-config/db/agent-configs', () => ({}));
jest.mock('@/lib/utils.server', () => ({ logExceptInTest: jest.fn() }));
jest.mock('@/lib/integrations/platforms/gitlab/credential-encryption', () => ({}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: mockGitLabCredential,
}));
jest.mock('@/components/cloud-agent/demo-config', () => ({
  DEMO_SOURCE_OWNER: 'demo',
  DEMO_SOURCE_REPO_NAME: 'demo',
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: async (owner: Owner) => integration(owner, 'github'),
  getPrimaryGitHubIntegrationForOrganization: async (id: string) =>
    integration({ type: 'org', id }, 'github'),
  getIntegrationsByOrganization: async (id: string) => [integration({ type: 'org', id }, 'github')],
  getGitHubIntegrationById: async (owner: Owner, id: string) =>
    id === GITHUB_ID ? integration(owner, 'github') : null,
  updateRepositoriesForIntegration: async () => undefined,
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubBranches: mockGitHubBranches,
}));
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabBranches: mockGitLabBranches,
}));
jest.mock('@/lib/cloud-agent/bitbucket-integration-helpers', () => ({
  BitbucketOrganizationRepositoryListResultSchema: jest.requireActual<typeof OAuthModule>(
    '@/lib/integrations/platforms/bitbucket/oauth-integration'
  ).BitbucketOrganizationRepositoryListResultSchema,
  fetchBitbucketRepositoriesForOrganization: async () => bitbucketResult,
}));
jest.mock('@/lib/integrations/platforms/bitbucket/interactive-client', () => ({
  BitbucketInteractiveClientError: class extends Error {},
  createBitbucketInteractiveClient: () => ({
    execute: async () => ({
      status: 200,
      data: { values: [{ name: 'release/Case' }] },
      metadata: {
        actorUserId: USER_ID,
        organizationId: ORGANIZATION_ID,
        integrationId: BITBUCKET_ID,
      },
    }),
  }),
}));
jest.mock('next/server', () => ({ after: jest.fn() }));
jest.mock(
  '@/lib/integrations/platforms/bitbucket/workspace-access-token-organization-authorization',
  () => ({})
);

let personal: ReturnType<typeof PersonalModule.cloudAgentNextRouter.createCaller>;
let organization: ReturnType<
  typeof OrganizationModule.organizationCloudAgentNextRouter.createCaller
>;
let client: typeof ClientModule;
let gitlab: typeof GitLabModule;
let gitlabHelpers: typeof GitLabHelpers;
let githubService: typeof GitHubService;
let token: typeof TokenModule;
let workerSchemas: typeof WorkerSchemas;
const sent: Record<string, unknown>[] = [];
const originalFetch = global.fetch;
beforeAll(async () => {
  const context = { user: { id: USER_ID, is_admin: false } as User };
  personal = (await import('./cloud-agent-next-router')).cloudAgentNextRouter.createCaller(context);
  organization = (
    await import('./organizations/organization-cloud-agent-next-router')
  ).organizationCloudAgentNextRouter.createCaller(context);
  client = await import('@/lib/cloud-agent-next/cloud-agent-client');
  gitlab = await import('@/lib/integrations/gitlab-service');
  gitlabHelpers = await import('@/lib/cloud-agent/gitlab-integration-helpers');
  githubService = await import('@/lib/integrations/github-apps-service');
  token = await import('@/lib/integrations/platforms/bitbucket/token-service-client');
  workerSchemas = await import('../../../../services/cloud-agent-next/src/router/schemas');
});
beforeEach(() => {
  sent.length = 0;
  queries.length = 0;
  mockGitLabRows = [integration(userOwner, 'gitlab')];
  mockGitLabCredential.mockResolvedValue({
    status: 'available',
    token: 'provider-test',
    instanceUrl: INSTANCE_URL,
  });
  mockGitLabBranches.mockResolvedValue([{ name: 'release/Case', default: true, protected: false }]);
  mockGitHubBranches.mockResolvedValue([{ name: 'release/Case', isDefault: true }]);
  bitbucketResult = {
    status: 'available',
    repositories: [
      token.withBitbucketRepositoryIdentity(
        {
          id: REPOSITORY_UUID,
          workspaceUuid: WORKSPACE_UUID,
          name: 'API',
          fullName: 'acme/API',
          private: true,
          defaultBranch: 'release/Case',
        },
        orgOwner,
        BITBUCKET_ID
      ),
    ],
    syncedAt: '2026-08-29T00:00:00.000Z',
  };
  global.fetch = jest.fn<typeof fetch>(async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a serialized prepare input');
    sent.push(JSON.parse(init.body));
    return Response.json({ result: { data: prepared } });
  });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function reference(provider: 'github' | 'gitlab', owner: Owner): LaunchRepositoryReference {
  return {
    repository: {
      provider,
      repositoryId: '42',
      instanceUrl: provider === 'github' ? 'https://github.com' : INSTANCE_URL,
      fullName: provider === 'github' ? 'acme/API' : 'Group/Sub/API',
      defaultBranch: 'release/Case',
    },
    authorization: {
      kind: 'ownerIntegration',
      owner,
      integrationId: provider === 'github' ? GITHUB_ID : GITLAB_ID,
    },
  };
}

describe('external caller compatibility matrix', () => {
  const callers = [
    ['NewSessionPanel', oldGitHub],
    ['CloudAgentProvider', oldGitLab],
    ['extension agents-new-session', oldGitLab],
    ['createExtensionAgentSessionManager', oldGitHub],
    ['review-ID fork route', oldGitHub],
    ['review-Markdown fork route', oldGitLab],
    ['old installed mobile clients', oldGitHub],
  ] as const;
  it.each(callers)(
    'accepts the serialized old %s input through both prepare procedures',
    async (_name, serialized) => {
      const input = JSON.parse(serialized);
      await expect(personal.prepareSession(input)).resolves.toEqual(prepared);
      mockGitLabRows = [integration(orgOwner, 'gitlab')];
      await expect(
        organization.prepareSession({ ...input, organizationId: ORGANIZATION_ID })
      ).resolves.toEqual(prepared);
      expect(sent).toHaveLength(2);
      for (const request of sent) {
        expect(request).toMatchObject({
          prompt: 'Inspect',
          model: 'test/model',
          mode: 'code',
          createdOnPlatform: 'cloud-agent-web',
        });
        expect(request).not.toHaveProperty('gitlabIntegrationId');
        expect(request).not.toHaveProperty('bitbucketIntegrationId');
        if (serialized === oldGitLab)
          expect(request).toMatchObject({
            gitUrl: 'https://gitlab.example.com/Enterprise/Group/Sub/API.git',
            upstreamBranch: 'release/Case',
            platform: 'gitlab',
          });
        else {
          expect(request).toMatchObject({ githubRepo: 'acme/API', platform: 'github' });
          expect(request).not.toHaveProperty('upstreamBranch');
        }
      }
      expect(sent[0]).not.toHaveProperty('kilocodeOrganizationId');
      expect(sent[1].kilocodeOrganizationId).toBe(ORGANIZATION_ID);
    }
  );

  it.each([
    [
      'spawn-cloud-agent-session',
      '{"prompt":"Inspect","mode":"code","model":"test/model","githubRepo":"acme/API","createdOnPlatform":"slack","callbackTarget":{"url":"https://app.test/callback"}}',
    ],
    [
      'App Builder',
      '{"prompt":"Build","mode":"build","model":"test/model","gitUrl":"https://builder.test/project.git","upstreamBranch":"main","autoCommit":true,"setupCommands":["bun install"],"createdOnPlatform":"app-builder"}',
    ],
    [
      'startSecurityAnalysis',
      '{"prompt":"Analyze","mode":"code","model":"test/model","githubRepo":"acme/API","createdOnPlatform":"security-agent","callbackTarget":{"url":"https://app.test/api/internal/security-analysis-callback/finding"}}',
    ],
    [
      'runSessionToCompletion',
      '{"prompt":"Inspect","mode":"code","model":"test/model","gitUrl":"https://gitlab.example.com/Enterprise/Group/Sub/API.git","platform":"gitlab","upstreamBranch":"release/Case"}',
    ],
    ['CloudAgentNextClient', oldGitHub],
  ] as const)(
    'retains the old %s payload in the web client transport',
    async (_name, serialized) => {
      const input = JSON.parse(serialized);
      await expect(
        new client.CloudAgentNextClient('test-token').prepareSession(input)
      ).resolves.toEqual(prepared);
      expect(sent).toEqual([input]);
      expect(workerSchemas.PrepareSessionInput.parse(sent[0])).toMatchObject(input);
    }
  );

  it.each(['NewDeploymentDialog', 'RepoProfileBindingsDialog', 'ProfilesListDialog'])(
    'preserves old discovery fields consumed by %s',
    async () => {
      const github = await personal.listGitHubRepositories({ forceRefresh: false });
      const gitlabResult = await personal.listGitLabRepositories({ forceRefresh: false });
      expect(github.repositories[0]).toMatchObject({
        id: 42,
        name: 'API',
        fullName: 'acme/API',
        private: true,
      });
      expect(gitlabResult.repositories[0]).toMatchObject({
        id: 42,
        name: 'API',
        fullName: 'Group/Sub/API',
        private: true,
      });
      expect(github.repositories[0].repositoryReference?.authorization).toEqual({
        kind: 'ownerIntegration',
        owner: userOwner,
        integrationId: GITHUB_ID,
      });
      expect(gitlabResult.repositories[0].repositoryReference?.repository).toMatchObject({
        instanceUrl: INSTANCE_URL,
        defaultBranch: 'release/Case',
      });
    }
  );

  it('keeps the old deployment branch helper input and output', async () => {
    mockGitLabRows = [integration(orgOwner, 'github')];
    await expect(githubService.listBranches(orgOwner, GITHUB_ID, 'acme/API')).resolves.toEqual({
      branches: [{ name: 'release/Case', isDefault: true }],
    });
  });

  it.each([
    { type: 'github', repo: 'acme/API', branch: 'release/Case' },
    {
      type: 'gitlab',
      url: 'https://gitlab.example.com/Enterprise/Group/Sub/API.git',
      branch: 'release/Case',
    },
    {
      type: 'bitbucket',
      url: 'https://bitbucket.org/acme/API.git',
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
      branch: 'release/Case',
    },
  ])('keeps serialized old grouped Worker $type inputs without requiring pins', repository => {
    const input = JSON.parse(
      JSON.stringify({
        message: { prompt: 'Inspect' },
        agent: { mode: 'code', model: 'test/model' },
        repository,
      })
    );
    expect(workerSchemas.StartSessionInput.parse(input)).toEqual(input);
  });

  it('retains old clone-only payloads without a synthetic prompt', async () => {
    const input = JSON.parse(
      '{"githubRepo":"acme/API","mode":"code","model":"test/model","cloneFromKiloSessionId":"ses_12345678901234567890123456","autoInitiate":true,"operationKey":"77777777-7777-4777-8777-777777777777"}'
    );
    await personal.prepareSession(input);
    expect(sent[0]).toMatchObject({
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      operationKey: '77777777-7777-4777-8777-777777777777',
      autoInitiate: true,
    });
    expect(sent[0]).not.toHaveProperty('prompt');
  });
});

describe('provider pins and exact prepare branch', () => {
  it('accepts a serialized old organization Bitbucket payload without an integration pin', async () => {
    const input = JSON.parse(
      '{"organizationId":"11111111-1111-4111-8111-111111111111","prompt":"Inspect","mode":"code","model":"test/model","bitbucketRepo":{"fullName":"acme/API","workspaceUuid":"55555555-5555-4555-8555-555555555555","repositoryUuid":"66666666-6666-4666-8666-666666666666"}}'
    );
    await organization.prepareSession(input);
    expect(sent[0]).toMatchObject({
      gitUrl: 'https://bitbucket.org/acme/API.git',
      platform: 'bitbucket',
      bitbucketWorkspaceUuid: WORKSPACE_UUID,
      bitbucketRepositoryUuid: REPOSITORY_UUID,
    });
    expect(sent[0]).not.toHaveProperty('bitbucketIntegrationId');
  });

  it.each([
    { githubRepo: 'acme/API', gitlabIntegrationId: GITLAB_ID },
    { githubRepo: 'acme/API', gitlabInstanceUrl: INSTANCE_URL },
    { githubRepo: 'acme/API', bitbucketIntegrationId: BITBUCKET_ID },
    { gitlabProject: 'Group/Sub/API', githubIntegrationId: GITHUB_ID },
  ])('rejects cross-provider pins: %j', async repository => {
    await expect(
      personal.prepareSession({
        prompt: 'Inspect',
        mode: 'code',
        model: 'test/model',
        ...repository,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sent).toEqual([]);
  });

  it.each([
    'https://user:password@gitlab.example.com/Enterprise',
    'https://gitlab.example.com/Enterprise?token=secret',
    'https://gitlab.example.com/Enterprise#other',
  ])('rejects an invalid instance pin as a non-retryable input: %s', async instanceUrl => {
    await expect(
      personal.prepareSession({
        prompt: 'Inspect',
        mode: 'code',
        model: 'test/model',
        gitlabProject: 'Group/Sub/API',
        gitlabIntegrationId: GITLAB_ID,
        gitlabInstanceUrl: instanceUrl,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sent).toEqual([]);
  });

  it('retains legacy clone-host lookup behavior while denying a pinned suspended integration', async () => {
    mockGitLabRows = [{ ...integration(userOwner, 'gitlab'), integration_status: 'suspended' }];
    await expect(gitlabHelpers.getGitLabInstanceUrlForUser(USER_ID)).resolves.toBe(INSTANCE_URL);
    await expect(
      gitlabHelpers.getGitLabInstanceUrlForUser(USER_ID, GITLAB_ID)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it.each(['personal', 'organization'] as const)(
    'forwards the GitHub pin and exact branch through %s prepare',
    async scope => {
      const input = {
        prompt: 'Inspect',
        model: 'test/model',
        mode: 'code',
        githubRepo: 'acme/API',
        githubIntegrationId: GITHUB_ID,
        upstreamBranch: 'feature/Case-sensitive',
      };
      await (scope === 'personal'
        ? personal.prepareSession(input)
        : organization.prepareSession({ ...input, organizationId: ORGANIZATION_ID }));
      expect(sent[0]).toMatchObject({
        githubRepo: 'acme/API',
        githubIntegrationId: GITHUB_ID,
        upstreamBranch: 'feature/Case-sensitive',
      });
    }
  );
  it.each(['personal', 'organization'] as const)(
    'forwards the GitLab pin, authorized host, and exact branch through %s prepare',
    async scope => {
      mockGitLabRows = [integration(scope === 'personal' ? userOwner : orgOwner, 'gitlab')];
      const input = {
        prompt: 'Inspect',
        model: 'test/model',
        mode: 'code',
        gitlabProject: 'Group/Sub/API',
        gitlabIntegrationId: GITLAB_ID,
        gitlabInstanceUrl: INSTANCE_URL,
        upstreamBranch: 'feature/Case-sensitive',
      };
      await (scope === 'personal'
        ? personal.prepareSession(input)
        : organization.prepareSession({ ...input, organizationId: ORGANIZATION_ID }));
      expect(workerSchemas.PrepareSessionInput.parse(sent[0])).toMatchObject({
        gitUrl: 'https://gitlab.example.com/Enterprise/Group/Sub/API.git',
        gitlabIntegrationId: GITLAB_ID,
        upstreamBranch: 'feature/Case-sensitive',
        platform: 'gitlab',
      });
      // The Worker derives the instance from gitUrl, not an unsupported flat pin.
      expect(sent[0]).not.toHaveProperty('gitlabInstanceUrl');
      expect(queries[0].params).toEqual([
        scope === 'personal' ? USER_ID : ORGANIZATION_ID,
        'gitlab',
        GITLAB_ID,
      ]);
      expect(queries[0].sql).toContain(
        scope === 'personal' ? '"owned_by_organization_id" is null' : '"owned_by_user_id" is null'
      );
    }
  );
  it('forwards the Bitbucket pin and branch through organization prepare', async () => {
    await organization.prepareSession({
      organizationId: ORGANIZATION_ID,
      prompt: 'Inspect',
      mode: 'code',
      model: 'test/model',
      bitbucketRepo: {
        fullName: 'acme/API',
        workspaceUuid: WORKSPACE_UUID,
        repositoryUuid: REPOSITORY_UUID,
      },
      bitbucketIntegrationId: BITBUCKET_ID,
      upstreamBranch: 'feature/Case-sensitive',
    });
    expect(sent[0]).toMatchObject({
      gitUrl: 'https://bitbucket.org/acme/API.git',
      platform: 'bitbucket',
      bitbucketIntegrationId: BITBUCKET_ID,
      bitbucketWorkspaceUuid: WORKSPACE_UUID,
      bitbucketRepositoryUuid: REPOSITORY_UUID,
      upstreamBranch: 'feature/Case-sensitive',
    });
  });
  it('rejects Personal Bitbucket discovery and prepare without a Worker request', async () => {
    await expect(personal.listBitbucketRepositories()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      personal.prepareSession({
        prompt: 'Inspect',
        mode: 'code',
        model: 'test/model',
        bitbucketRepo: {
          fullName: 'acme/API',
          workspaceUuid: WORKSPACE_UUID,
          repositoryUuid: REPOSITORY_UUID,
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sent).toEqual([]);
  });
  it.each(['personal', 'organization'] as const)(
    'does not substitute a default when strict checkout rejects a %s branch',
    async scope => {
      global.fetch = jest.fn<typeof fetch>(async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected JSON');
        sent.push(JSON.parse(init.body));
        return Response.json(
          {
            error: {
              message: 'Upstream branch not found',
              code: -32004,
              data: { code: 'NOT_FOUND', httpStatus: 404 },
            },
          },
          { status: 404 }
        );
      });
      const input = {
        prompt: 'Inspect',
        mode: 'code',
        model: 'test/model',
        githubRepo: 'acme/API',
        upstreamBranch: 'missing/strict',
      };
      await expect(
        scope === 'personal'
          ? personal.prepareSession(input)
          : organization.prepareSession({ ...input, organizationId: ORGANIZATION_ID })
      ).rejects.toThrow('Upstream branch not found');
      expect(sent).toHaveLength(1);
      expect(sent[0].upstreamBranch).toBe('missing/strict');
    }
  );
  it('retains retryable web-client error metadata', async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            message: 'Provider unavailable',
            code: -32603,
            data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 },
          },
        },
        { status: 503 }
      )
    );
    await expect(
      new client.CloudAgentNextClient('test-token').prepareSession(JSON.parse(oldGitHub))
    ).rejects.toMatchObject({
      message: 'Provider unavailable',
      data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 },
    });
  });
  it('rejects a stale GitLab pin instead of sending an unpinned prepare', async () => {
    mockGitLabRows = [];
    await expect(
      personal.prepareSession({
        prompt: 'Inspect',
        mode: 'code',
        model: 'test/model',
        gitlabProject: 'Group/Sub/API',
        gitlabIntegrationId: GITLAB_ID,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(sent).toEqual([]);
  });
  it('rejects an ambiguous legacy GitLab lookup', async () => {
    mockGitLabRows = [
      integration(userOwner, 'gitlab'),
      {
        ...integration(userOwner, 'gitlab'),
        id: GITHUB_ID,
        metadata: { gitlab_instance_url: 'https://other.example.com' },
      },
    ];
    await expect(gitlabHelpers.getGitLabInstanceUrlForUser(USER_ID)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
  it('retains an unambiguous absent-selector clone host', async () => {
    await expect(gitlabHelpers.getGitLabInstanceUrlForUser(USER_ID)).resolves.toBe(INSTANCE_URL);
    expect(queries[0].params).toEqual([USER_ID, 'gitlab']);
  });
});

describe('mobile-exposed branch consumer boundaries', () => {
  it.each(['github', 'gitlab'] as const)(
    'exposes exact %s branches in both owner contexts',
    async provider => {
      if (provider === 'gitlab')
        mockGitLabBranches.mockImplementation(async (_token, projectId, instanceUrl) => {
          if (projectId !== '42' || instanceUrl !== INSTANCE_URL)
            throw new Error('Wrong GitLab project identity');
          return [
            { name: 'feature/Case', default: false, protected: false },
            { name: 'release/Case', default: true, protected: true },
          ];
        });
      const personalResult = await personal.listRepositoryBranches(reference(provider, userOwner));
      mockGitLabRows = [integration(orgOwner, 'gitlab')];
      const organizationResult = await organization.listRepositoryBranches({
        ...reference(provider, orgOwner),
        organizationId: ORGANIZATION_ID,
      });
      expect(personalResult).toEqual(organizationResult);
      expect(personalResult).toMatchObject({ defaultBranch: 'release/Case', nextCursor: null });
    }
  );
  it('returns zero GitLab branches distinctly from a failure or guessed default', async () => {
    mockGitLabBranches.mockResolvedValue([]);
    await expect(personal.listRepositoryBranches(reference('gitlab', userOwner))).resolves.toEqual({
      branches: [],
      defaultBranch: null,
      nextCursor: null,
    });
  });
  it('preserves a retryable GitLab credential failure', async () => {
    mockGitLabCredential.mockResolvedValue({ status: 'temporarily_unavailable' });
    await expect(
      personal.listRepositoryBranches(reference('gitlab', userOwner))
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('preserves a GitLab branch page failure rather than returning an empty success', async () => {
    mockGitLabBranches.mockRejectedValue(new Error('GitLab page 2 failed'));
    await expect(personal.listRepositoryBranches(reference('gitlab', userOwner))).rejects.toThrow(
      'GitLab page 2 failed'
    );
  });
  it.each(['owner', 'repository', 'instance'] as const)(
    'rejects a changed GitLab %s without same-name substitution',
    async changed => {
      const input = reference('gitlab', userOwner);
      if (changed === 'owner') input.authorization.owner = orgOwner;
      if (changed === 'repository') input.repository.repositoryId = '999';
      if (changed === 'instance') input.repository.instanceUrl = 'https://other.example.com';
      await expect(personal.listRepositoryBranches(input)).rejects.toMatchObject({
        code:
          changed === 'owner'
            ? 'FORBIDDEN'
            : changed === 'repository'
              ? 'NOT_FOUND'
              : 'PRECONDITION_FAILED',
      });
    }
  );
  it('keeps the old GitLab branch service result shape', async () => {
    await expect(
      gitlab.listGitLabBranches(userOwner, GITLAB_ID, { userId: USER_ID }, 'Group/Sub/API')
    ).resolves.toEqual({ branches: [{ name: 'release/Case', isDefault: true }] });
  });
  it('uses the selected Bitbucket cache default, not the client default', async () => {
    if (bitbucketResult.status !== 'available') throw new Error('Expected available fixture');
    const selected = bitbucketResult.repositories[0].repositoryReference!;
    await expect(
      organization.listRepositoryBranches({
        ...selected,
        repository: { ...selected.repository, defaultBranch: 'guessed/main' },
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toEqual({
      branches: [{ name: 'release/Case', isDefault: true }],
      defaultBranch: 'release/Case',
      nextCursor: null,
    });
  });
  it('rejects an old Bitbucket pin after replacement produces the same repository name', async () => {
    if (bitbucketResult.status !== 'available') throw new Error('Expected available fixture');
    const selected = bitbucketResult.repositories[0].repositoryReference!;
    await expect(
      organization.listRepositoryBranches({
        ...selected,
        authorization: { ...selected.authorization, integrationId: GITHUB_ID },
        organizationId: ORGANIZATION_ID,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not invent integration identity for an old Bitbucket producer', async () => {
    if (bitbucketResult.status !== 'available') throw new Error('Expected available fixture');
    const selected = bitbucketResult.repositories[0].repositoryReference!;
    bitbucketResult.repositories = [
      {
        id: REPOSITORY_UUID,
        workspaceUuid: WORKSPACE_UUID,
        name: 'API',
        fullName: 'acme/API',
        private: true,
      },
    ];
    await expect(
      organization.listRepositoryBranches({ ...selected, organizationId: ORGANIZATION_ID })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
