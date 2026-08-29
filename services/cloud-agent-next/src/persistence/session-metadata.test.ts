import { describe, expect, it, vi } from 'vitest';
import { CloudAgentSession } from './CloudAgentSession.js';
import { prepareInputToSessionCreateRequest } from '../router/handlers/session-prepare.js';
import { startInputToSessionCreateRequest } from '../router/handlers/session-start.js';
import { PrepareSessionInput, StartSessionInput } from '../router/schemas.js';
import { normalizeRepositoryIdentity } from '../session/session-requests.js';

vi.mock('cloudflare:workers', () => ({ DurableObject: class DurableObject {} }));
vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  getSandbox: vi.fn(),
  ContainerProxy: class ContainerProxy {},
}));
vi.mock('@cloudflare/containers', () => ({}));
vi.mock('../../drizzle/migrations', () => ({ default: { journal: {}, migrations: {} } }));

import {
  CurrentSessionMetadataSchema,
  getEffectiveCredentialContainment,
  getSandboxProvider,
  parseSessionMetadata,
  requiresContainmentSandbox,
  serializeSessionMetadata,
  updateProviderRuntime,
  preserveResolvedRepositoryIdentity,
  withResolvedRepositoryIdentity,
} from './session-metadata.js';

function createMetadataSession(beforeTransaction?: () => Promise<void>) {
  const storage = new Map<string, unknown>();
  const session = Object.create(CloudAgentSession.prototype) as CloudAgentSession;
  Object.assign(session, {
    ctx: {
      storage: {
        get: async (key: string) => structuredClone(storage.get(key)),
        put: async (key: string, value: unknown) => {
          storage.set(key, structuredClone(value));
        },
        transaction: async <T>(
          run: (transaction: {
            get: (key: string) => Promise<unknown>;
            put: (key: string, value: unknown) => Promise<void>;
          }) => Promise<T>
        ) => {
          await beforeTransaction?.();
          const pending = structuredClone(storage);
          const result = await run({
            get: async key => structuredClone(pending.get(key)),
            put: async (key, value) => {
              pending.set(key, structuredClone(value));
            },
          });
          for (const [key, value] of pending) storage.set(key, value);
          return result;
        },
      },
    },
    requireSessionId: async () => 'agent_identity',
    hasDeletionIntent: async () => false,
    updateLastActivity: async () => {},
    ensureAlarmScheduled: async () => {},
    getMetadata: async () => {
      const value = storage.get('metadata');
      return value ? parseSessionMetadata(value) : null;
    },
    getSessionMessageQueue: () => ({
      admitAcceptedMessage: async ({ turn }: { turn: { messageId: string } }) => ({
        success: true,
        outcome: 'queued',
        compatibilityDelivery: 'queued',
        messageId: turn.messageId,
      }),
    }),
  });
  return session;
}

describe('adapters to Durable Object persistence', () => {
  const pin = '123e4567-e89b-12d3-a456-426614174022';
  const providers = [
    { type: 'github' as const, repo: 'group/repo', githubIntegrationId: pin },
    {
      type: 'gitlab' as const,
      url: 'https://gitlab.example.com/gitlab/group/sub/repo.git',
      gitlabIntegrationId: pin,
    },
    {
      type: 'bitbucket' as const,
      url: 'https://bitbucket.org/group/repo.git',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      bitbucketIntegrationId: pin,
    },
  ];
  it.each(
    providers.flatMap(repository => ['prepare', 'start'].map(adapter => ({ adapter, repository })))
  )(
    'persists $adapter $repository.type pins and rejects changed admission',
    async ({ adapter, repository }) => {
      const branch = 'release/selected';
      const request =
        adapter === 'start'
          ? startInputToSessionCreateRequest(
              StartSessionInput.parse({
                message: { prompt: 'Test' },
                agent: { mode: 'code', model: 'claude-3' },
                repository: { ...repository, branch },
              })
            )
          : prepareInputToSessionCreateRequest(
              PrepareSessionInput.parse({
                prompt: 'Test',
                mode: 'code',
                model: 'claude-3',
                upstreamBranch: branch,
                githubToken: 'must-not-persist',
                gitToken: 'must-not-persist',
                ...(repository.type === 'github'
                  ? {
                      githubRepo: repository.repo,
                      githubIntegrationId: repository.githubIntegrationId,
                    }
                  : repository.type === 'gitlab'
                    ? {
                        platform: 'gitlab',
                        gitUrl: repository.url,
                        gitlabIntegrationId: repository.gitlabIntegrationId,
                      }
                    : {
                        platform: 'bitbucket',
                        gitUrl: repository.url,
                        bitbucketIntegrationId: repository.bitbucketIntegrationId,
                        bitbucketWorkspaceUuid: repository.workspaceUuid,
                        bitbucketRepositoryUuid: repository.repositoryUuid,
                      }),
              })
            );
      const resolvedIdentity = {
        kind: 'resolved' as const,
        integrationId: pin,
        integrationOwner: { type: 'org' as const, id: 'org-1' },
        instanceUrl:
          repository.type === 'github'
            ? 'https://github.com'
            : repository.type === 'gitlab'
              ? 'https://gitlab.example.com/gitlab'
              : 'https://bitbucket.org',
      };
      const session = createMetadataSession();
      const command = {
        identity: { sessionId: 'agent_identity', userId: 'oauth/user', orgId: 'org-1' },
        auth: {},
        agent: request.agent,
        repository: { ...request.repository, resolvedIdentity },
        message: {
          initialTurn: {
            type: 'prompt' as const,
            messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
            prompt: 'Test',
          },
        },
      };
      expect(await session.createSessionWithInitialAdmission(command)).toMatchObject({
        success: true,
      });
      const metadata = await session.getMetadata();
      expect(metadata?.repository).toMatchObject({
        ...repository,
        upstreamBranch: branch,
        resolvedIdentity,
      });
      expect(JSON.stringify(metadata)).not.toContain('must-not-persist');
      expect(await session.createSessionWithInitialAdmission(command)).toMatchObject({
        success: true,
      });
      expect(
        await session.createSessionWithInitialAdmission({
          ...command,
          repository: { ...command.repository, branch: 'release/different' },
        })
      ).toMatchObject({ success: false, code: 'BAD_REQUEST' });
      const changedPin =
        repository.type === 'github'
          ? { githubIntegrationId: '123e4567-e89b-12d3-a456-426614174099' }
          : repository.type === 'gitlab'
            ? { gitlabIntegrationId: '123e4567-e89b-12d3-a456-426614174099' }
            : { bitbucketIntegrationId: '123e4567-e89b-12d3-a456-426614174099' };
      expect(
        await session.createSessionWithInitialAdmission({
          ...command,
          repository: { ...command.repository, ...changedPin },
        })
      ).toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect(
        await session.createSessionWithInitialAdmission({
          ...command,
          repository: {
            ...command.repository,
            resolvedIdentity: { ...resolvedIdentity, integrationId: 'another-integration' },
          },
        })
      ).toMatchObject({ success: false, code: 'BAD_REQUEST' });
      if (!metadata?.repository) throw new Error('Expected persisted repository');
      const { resolvedIdentity: _resolved, ...legacyRepository } = metadata.repository;
      await session.updateMetadata({ ...metadata, repository: legacyRepository });
      expect(normalizeRepositoryIdentity((await session.getMetadata())?.repository ?? {})).toEqual(
        resolvedIdentity
      );
      const cloneSession = createMetadataSession();
      const clone = { cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' };
      const { message: _initialMessage, ...registration } = command;
      expect(await cloneSession.registerSession({ ...registration, clone })).toEqual({
        success: true,
      });
      const clonedMetadata = await cloneSession.getMetadata();
      expect(clonedMetadata).toMatchObject({ clone, repository: metadata.repository });
      expect(clonedMetadata).not.toHaveProperty('initialMessage');
    }
  );
});

const callbackTarget = {
  url: 'https://example.com/callback',
  headers: { 'X-Test': '1' },
};

const profile = {
  envVars: { NODE_ENV: 'test' },
  setupCommands: ['pnpm install'],
  runtimeAgents: [
    {
      slug: 'reviewer',
      name: 'Reviewer',
      config: { mode: 'primary' as const, model: 'kilo/gpt-5' },
    },
  ],
};

describe('late resolution on legacy admission', () => {
  it('replays the original request after resolution without changing its caller pin', async () => {
    const session = createMetadataSession();
    const command = {
      identity: { sessionId: 'agent_identity', userId: 'oauth/user' },
      auth: {},
      agent: { mode: 'code', model: 'claude-3' },
      repository: { type: 'github' as const, repo: 'group/repo', branch: 'release/selected' },
      message: {
        initialTurn: {
          type: 'prompt' as const,
          messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          prompt: 'Test',
        },
      },
    };
    await session.createSessionWithInitialAdmission(command);
    const metadata = await session.getMetadata();
    if (!metadata) throw new Error('Expected registration');
    const resolvedIdentity = {
      kind: 'resolved' as const,
      integrationId: '123e4567-e89b-12d3-a456-426614174022',
      integrationOwner: { type: 'user' as const, id: 'oauth/user' },
      instanceUrl: 'https://github.com',
    };
    await session.updateMetadata(withResolvedRepositoryIdentity(metadata, resolvedIdentity));
    expect(await session.createSessionWithInitialAdmission(command)).toMatchObject({
      success: true,
    });
    expect((await session.getMetadata())?.repository).toMatchObject({
      repo: 'group/repo',
      upstreamBranch: 'release/selected',
      resolvedIdentity,
    });
    expect((await session.getMetadata())?.repository).not.toHaveProperty('githubIntegrationId');
  });
});

describe('durable repository resolution', () => {
  const resolvedIdentity = {
    kind: 'resolved' as const,
    integrationId: '123e4567-e89b-12d3-a456-426614174022',
    integrationOwner: { type: 'user' as const, id: 'oauth/user' },
    instanceUrl: 'https://gitlab.example.com/gitlab',
  };
  const base = {
    metadataSchemaVersion: 2 as const,
    identity: { sessionId: 'agent_identity', userId: 'oauth/user', orgId: 'billing-org' },
    auth: {},
    lifecycle: { version: 1, timestamp: 1 },
  };

  it.each([
    {
      type: 'github' as const,
      repo: 'group/repo',
      githubIntegrationId: resolvedIdentity.integrationId,
    },
    {
      type: 'gitlab' as const,
      url: 'https://gitlab.example.com/gitlab/group/sub/repo.git',
      gitlabIntegrationId: resolvedIdentity.integrationId,
    },
    {
      type: 'bitbucket' as const,
      url: 'https://bitbucket.org/group/repo.git',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      bitbucketIntegrationId: resolvedIdentity.integrationId,
    },
  ])('round-trips the $type resolution independently of session ownership', repository => {
    const metadata = parseSessionMetadata({
      ...base,
      repository: { ...repository, upstreamBranch: 'release/selected' },
    });
    const pinned = withResolvedRepositoryIdentity(metadata, resolvedIdentity);
    expect(parseSessionMetadata(serializeSessionMetadata(pinned)).repository).toEqual({
      ...repository,
      upstreamBranch: 'release/selected',
      resolvedIdentity,
    });
    expect(pinned.identity.orgId).toBe('billing-org');
    expect(
      preserveResolvedRepositoryIdentity(pinned, metadata).repository?.resolvedIdentity
    ).toEqual(resolvedIdentity);
  });

  it.each([
    { integrationId: '123e4567-e89b-12d3-a456-426614174099' },
    { integrationOwner: { type: 'org' as const, id: 'another-owner' } },
    { instanceUrl: 'https://other.example.com/gitlab' },
  ])('rejects resolved identity replacement %j', change => {
    const metadata = withResolvedRepositoryIdentity(
      parseSessionMetadata({
        ...base,
        repository: { type: 'gitlab', url: 'https://gitlab.example.com/gitlab/group/sub/repo.git' },
      }),
      resolvedIdentity
    );
    expect(() =>
      withResolvedRepositoryIdentity(metadata, { ...resolvedIdentity, ...change })
    ).toThrow('Repository identity cannot change');
  });

  it('rejects a resolved integration that differs from the caller pin', () => {
    const metadata = parseSessionMetadata({
      ...base,
      repository: {
        type: 'gitlab',
        url: 'https://gitlab.example.com/gitlab/group/sub/repo.git',
        gitlabIntegrationId: '123e4567-e89b-12d3-a456-426614174099',
      },
    });
    expect(() => withResolvedRepositoryIdentity(metadata, resolvedIdentity)).toThrow(
      'Repository identity cannot change'
    );
  });
});

describe('Durable Object repository identity merge', () => {
  const resolvedIdentity = {
    kind: 'resolved' as const,
    integrationId: '123e4567-e89b-12d3-a456-426614174022',
    integrationOwner: { type: 'user' as const, id: 'oauth/user' },
    instanceUrl: 'https://github.com',
  };
  const snapshot = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_identity', userId: 'oauth/user', orgId: 'billing-org' },
    auth: { kilocodeToken: 'old-auth' },
    repository: { type: 'github', repo: 'group/repo', upstreamBranch: 'release/selected' },
    callback: { target: { url: 'https://example.com/old' } },
    lifecycle: { version: 1, timestamp: 1 },
  });

  it('merges into concurrent metadata and preserves it on a stale same-identity retry', async () => {
    const newer = parseSessionMetadata({
      ...snapshot,
      auth: { kilocodeToken: 'current-auth', kiloSessionId: 'current-session' },
      repository: { ...snapshot.repository, upstreamBranch: 'release/current' },
      callback: { target: { url: 'https://example.com/current' } },
      workspace: { branchName: 'workspace/current', workspacePath: '/workspace/current' },
      lifecycle: { version: 2, timestamp: 1, preparedAt: 2, initiatedAt: 3 },
    });
    let concurrent = true;
    const session = createMetadataSession(async () => {
      if (concurrent) {
        concurrent = false;
        await session.updateMetadata(newer);
      }
    });
    await session.updateMetadata(snapshot);
    await session.updateResolvedRepositoryIdentity(snapshot, resolvedIdentity);
    expect(await session.getMetadata()).toEqual({
      ...newer,
      repository: { ...newer.repository, resolvedIdentity },
    });

    await session.updateUpstreamBranch('release/after-prepare');
    await session.recordKiloServerActivity();
    const current = await session.getMetadata();
    await session.updateResolvedRepositoryIdentity(snapshot, resolvedIdentity);
    expect(await session.getMetadata()).toEqual(current);
    expect(current?.repository?.upstreamBranch).toBe('release/after-prepare');
    expect(current?.lifecycle.preparedAt).toBe(2);
    expect(current?.workspace?.branchName).toBe('workspace/current');
  });

  it.each([
    { label: 'repository', change: { repository: { type: 'github', repo: 'group/other' } } },
    {
      label: 'provider',
      change: { repository: { type: 'gitlab', url: 'https://gitlab.com/group/repo.git' } },
    },
    { label: 'missing repository', change: { repository: undefined } },
    { label: 'user', change: { identity: { ...snapshot.identity, userId: 'other-user' } } },
    { label: 'organization', change: { identity: { ...snapshot.identity, orgId: 'other-org' } } },
    {
      label: 'pin',
      change: {
        repository: { ...snapshot.repository, githubIntegrationId: resolvedIdentity.integrationId },
      },
    },
    {
      label: 'integration',
      change: {
        repository: {
          ...snapshot.repository,
          resolvedIdentity: { ...resolvedIdentity, integrationId: 'another-integration' },
        },
      },
    },
    {
      label: 'resolved owner',
      change: {
        repository: {
          ...snapshot.repository,
          resolvedIdentity: {
            ...resolvedIdentity,
            integrationOwner: { type: 'org', id: 'billing-org' },
          },
        },
      },
    },
    {
      label: 'instance',
      change: {
        repository: {
          ...snapshot.repository,
          resolvedIdentity: { ...resolvedIdentity, instanceUrl: 'https://other.example.com' },
        },
      },
    },
  ])(
    'rejects a changed $label between lookup and merge without altering current metadata',
    async ({ change }) => {
      const session = createMetadataSession();
      const current = parseSessionMetadata({ ...snapshot, ...change });
      await session.updateMetadata(current);
      await expect(
        session.updateResolvedRepositoryIdentity(snapshot, resolvedIdentity)
      ).rejects.toThrow('Repository identity cannot change');
      expect(await session.getMetadata()).toEqual(current);
    }
  );

  it.each([
    {
      repository: { type: 'gitlab', url: 'https://gitlab.example.com/gitlab/group/repo.git' },
      change: { url: 'https://gitlab.example.com/gitlab/group/other.git' },
    },
    {
      repository: { type: 'gitlab', url: 'https://gitlab.example.com/gitlab/group/repo.git' },
      change: { gitlabIntegrationId: resolvedIdentity.integrationId },
    },
    ...[
      { url: 'https://bitbucket.org/group/other.git' },
      { workspaceUuid: '123e4567-e89b-12d3-a456-426614174099' },
      { repositoryUuid: '123e4567-e89b-12d3-a456-426614174099' },
      { bitbucketIntegrationId: resolvedIdentity.integrationId },
    ].map(change => ({
      repository: {
        type: 'bitbucket',
        url: 'https://bitbucket.org/group/repo.git',
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      },
      change,
    })),
  ])(
    'rejects changed provider resource fields before the first resolution: $change',
    async ({ repository, change }) => {
      const session = createMetadataSession();
      const expected = parseSessionMetadata({ ...snapshot, repository });
      const current = parseSessionMetadata({
        ...expected,
        repository: { ...repository, ...change },
      });
      await session.updateMetadata(current);
      await expect(
        session.updateResolvedRepositoryIdentity(expected, resolvedIdentity)
      ).rejects.toThrow('Repository identity cannot change');
      expect(await session.getMetadata()).toEqual(current);
    }
  );

  it('keeps a caller pin and rejects a different resolved integration on replay', async () => {
    const session = createMetadataSession();
    const pinned = parseSessionMetadata({
      ...snapshot,
      repository: { ...snapshot.repository, githubIntegrationId: resolvedIdentity.integrationId },
    });
    await session.updateMetadata(pinned);
    await session.updateResolvedRepositoryIdentity(pinned, resolvedIdentity);
    const stored = await session.getMetadata();
    await expect(
      session.updateResolvedRepositoryIdentity(pinned, {
        ...resolvedIdentity,
        integrationId: 'another-integration',
      })
    ).rejects.toThrow('Repository identity cannot change');
    expect(await session.getMetadata()).toEqual(stored);
  });
});

describe('session metadata boundary', () => {
  it('maps legacy managed SCM containment to GitHub and Kilo only', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId: 'agent_legacy_containment', userId: 'user_containment' },
      auth: {},
      workspace: { managedScmContainment: true },
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(getEffectiveCredentialContainment(metadata)).toEqual({
      github: true,
      gitlab: false,
      kilocode: true,
    });
    expect(requiresContainmentSandbox(metadata)).toBe(true);
  });

  it('prefers an explicit grouped policy over legacy containment metadata', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId: 'agent_migrated_containment', userId: 'user_containment' },
      auth: {},
      workspace: {
        credentialContainment: { github: false, gitlab: false, kilocode: false },
        managedScmContainment: true,
      },
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(getEffectiveCredentialContainment(metadata)).toEqual({
      github: false,
      gitlab: false,
      kilocode: false,
    });
    expect(requiresContainmentSandbox(metadata)).toBe(false);
  });

  it('defaults missing credential containment to uncontained', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId: 'agent_no_containment', userId: 'user_containment' },
      auth: {},
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(getEffectiveCredentialContainment(metadata)).toEqual({
      github: false,
      gitlab: false,
      kilocode: false,
    });
    expect(requiresContainmentSandbox(metadata)).toBe(false);
  });

  it('parses and serializes current grouped metadata with canonical attachments', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_123',
        userId: 'user_123',
        orgId: 'org_123',
        botId: 'bot_123',
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: {
        kiloSessionId: 'cli_123',
        kilocodeToken: 'kilo-token',
      },
      repository: {
        type: 'github' as const,
        repo: 'acme/repo',
        token: 'github-token',
        githubIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
        githubInstallationId: '987',
        githubAppType: 'standard' as const,
        upstreamBranch: 'main',
      },
      initialMessage: {
        id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        prompt: 'Build the thing',
        attachments: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
        },
      },
      agent: {
        mode: 'reviewer',
        model: 'kilo/gpt-5',
        variant: 'thinking',
        appendSystemPrompt: 'Extra context',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: false,
        gateThreshold: 'warning' as const,
      },
      profile,
      callback: { target: callbackTarget },
      workspace: {
        sandboxId: 'usr-b4593afcaf2e9e1dfb1611150b786cfe8aeba3c77352a3df' as const,
        sandboxRoute: {
          kind: 'shared' as const,
          routeKey: 'usr-000000000000000000000000000000000000000000000000' as const,
          suffix: 'shared-slot-v1' as const,
        },
        sandboxProvider: 'cloudflare' as const,
        workspacePath: '/workspace',
        sessionHome: '/home/kilo',
        branchName: 'session/agent_123',
        shallow: true,
      },
      lifecycle: {
        version: 1234,
        timestamp: 1234,
        preparedAt: 1235,
        initiatedAt: 1236,
        kiloServerLastActivity: 1237,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
    expect(CurrentSessionMetadataSchema.parse(current)).toEqual(current);
  });

  it('keeps existing GitHub metadata valid when the integration id is omitted', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: { sessionId: 'agent_legacy_github', userId: 'user_legacy_github' },
      auth: {},
      repository: { type: 'github' as const, repo: 'acme/repo' },
      lifecycle: { version: 1, timestamp: 1 },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
    expect(parseSessionMetadata(current).repository).not.toHaveProperty('githubIntegrationId');
  });

  it('parses and serializes clone source metadata', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: { sessionId: 'agent_clone', userId: 'user_clone' },
      auth: {},
      clone: {
        cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      lifecycle: { version: 1, timestamp: 1 },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
    expect(CurrentSessionMetadataSchema.parse(current)).toEqual(current);
  });

  it('keeps metadata without clone as an empty-session bootstrap', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: { sessionId: 'agent_no_clone', userId: 'user_no_clone' },
      auth: {},
      lifecycle: { version: 1, timestamp: 1 },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(parseSessionMetadata(current)).not.toHaveProperty('clone');
  });

  it('rejects shared route metadata without a compatible assigned sandbox', () => {
    const base = {
      metadataSchemaVersion: 2 as const,
      identity: { sessionId: 'agent_invalid_route', userId: 'user_invalid_route' },
      auth: {},
      lifecycle: { version: 1, timestamp: 1 },
    };
    const route = {
      kind: 'shared' as const,
      routeKey: 'usr-000000000000000000000000000000000000000000000000' as const,
    };

    expect(() =>
      serializeSessionMetadata({ ...base, workspace: { sandboxRoute: route } })
    ).toThrow();
    expect(() =>
      serializeSessionMetadata({
        ...base,
        workspace: {
          sandboxId: 'usr-111111111111111111111111111111111111111111111111',
          sandboxRoute: route,
        },
      })
    ).toThrow();
  });

  it('accepts legacy current metadata without an explicit sandbox provider as Cloudflare', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_legacy_provider',
        userId: 'user_legacy_provider',
      },
      auth: {},
      workspace: {
        sandboxId: 'ses-abcdef' as const,
      },
      lifecycle: {
        version: 1,
        timestamp: 1,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(getSandboxProvider(parseSessionMetadata(current))).toBe('cloudflare');
  });

  it('round-trips isolated Standard allocation metadata as Cloudflare', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_isolated_standard',
        userId: 'user_isolated_standard',
      },
      auth: {},
      workspace: {
        sandboxId: 'istd-abcdef' as const,
        sandboxAllocation: 'isolated-standard' as const,
      },
      lifecycle: {
        version: 1,
        timestamp: 1,
      },
    };

    const parsed = parseSessionMetadata(current);
    expect(parsed).toEqual(current);
    expect(getSandboxProvider(parsed)).toBe('cloudflare');
    expect(parseSessionMetadata(serializeSessionMetadata(parsed))).toEqual(current);
  });

  it('accepts Vercel metadata only for an isolated non-devcontainer sandbox', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_vercel_provider',
        userId: 'user_vercel_provider',
      },
      auth: {},
      workspace: {
        sandboxId: 'ses-abcdef' as const,
        sandboxProvider: 'vercel' as const,
      },
      lifecycle: {
        version: 1,
        timestamp: 1,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(getSandboxProvider(parseSessionMetadata(current))).toBe('vercel');
  });

  it('persists one immutable Vercel session locator and mutable wrapper lease', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId: 'agent_vercel_runtime', userId: 'user_vercel_runtime' },
      auth: {},
      workspace: {
        sandboxId: 'ses-abcdef',
        sandboxProvider: 'vercel',
      },
      lifecycle: { version: 1, timestamp: 1 },
    });

    const runtimeLocator = {
      provider: 'vercel' as const,
      sessionId: 'session-1',
      projectId: 'project-1',
      snapshotId: 'snapshot-1',
      runtimeBuildId: 'build-1',
      runtime: 'node24' as const,
    };
    const located = updateProviderRuntime(metadata, runtimeLocator);
    const launched = updateProviderRuntime(located, {
      ...runtimeLocator,
      wrapper: {
        launchId: 'launch-1',
        commandId: 'command-1',
        instanceId: 'instance-1',
        instanceGeneration: 2,
      },
    });

    expect(serializeSessionMetadata(launched).workspace?.providerRuntime).toEqual({
      ...runtimeLocator,
      wrapper: {
        launchId: 'launch-1',
        commandId: 'command-1',
        instanceId: 'instance-1',
        instanceGeneration: 2,
      },
    });
    expect(updateProviderRuntime(launched, runtimeLocator).workspace?.providerRuntime).toEqual(
      runtimeLocator
    );
    expect(() =>
      updateProviderRuntime(located, { ...runtimeLocator, sessionId: 'session-2' })
    ).toThrow('Vercel session ID is immutable');
    expect(() =>
      updateProviderRuntime(located, { ...runtimeLocator, runtimeBuildId: 'build-2' })
    ).toThrow('Vercel runtimeBuildId is immutable');
  });

  it('rejects provider runtime mismatches and devcontainers', () => {
    const base = {
      metadataSchemaVersion: 2,
      identity: { sessionId: 'agent_runtime_mismatch', userId: 'user_runtime_mismatch' },
      auth: {},
      lifecycle: { version: 1, timestamp: 1 },
    };

    expect(() =>
      parseSessionMetadata({
        ...base,
        workspace: {
          sandboxId: 'ses-abcdef',
          sandboxProvider: 'cloudflare',
          providerRuntime: { provider: 'vercel', sessionId: 'session-1' },
        },
      })
    ).toThrow('Invalid current session metadata');
    expect(() =>
      parseSessionMetadata({
        ...base,
        workspace: {
          sandboxId: 'ses-abcdef',
          sandboxProvider: 'vercel',
          providerRuntime: { provider: 'vercel', sessionId: 'session-1' },
          devcontainerRequested: true,
        },
      })
    ).toThrow('Invalid current session metadata');
  });

  it('rejects Vercel metadata pinned to a shared sandbox identity', () => {
    expect(() =>
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent_vercel_shared', userId: 'user_vercel_shared' },
        auth: {},
        workspace: { sandboxId: 'org-abcdef', sandboxProvider: 'vercel' },
        lifecycle: { version: 1, timestamp: 1 },
      })
    ).toThrow('Invalid current session metadata');
  });

  it('rejects Vercel metadata requesting a devcontainer runtime', () => {
    expect(() =>
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent_vercel_dind', userId: 'user_vercel_dind' },
        auth: {},
        workspace: {
          sandboxId: 'ses-abcdef',
          sandboxProvider: 'vercel',
          devcontainerRequested: true,
        },
        lifecycle: { version: 1, timestamp: 1 },
      })
    ).toThrow('Invalid current session metadata');
  });

  it('rejects Vercel metadata carrying an already prepared devcontainer', () => {
    expect(() =>
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent_vercel_prepared_dind', userId: 'user_vercel_dind' },
        auth: {},
        workspace: { sandboxId: 'ses-abcdef', sandboxProvider: 'vercel' },
        devcontainer: {
          workspacePath: '/workspace/user/sessions/agent_vercel_prepared_dind',
          innerWorkspaceFolder: '/workspaces/repo',
          wrapperPort: 4173,
          configPath: '.devcontainer/devcontainer.json',
        },
        lifecycle: { version: 1, timestamp: 1 },
      })
    ).toThrow('Invalid current session metadata');
  });

  it('parses and serializes current grouped DIND workspace metadata', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_dind',
        userId: 'user_dind',
      },
      auth: {},
      workspace: {
        sandboxId: 'dind-abcdef' as const,
      },
      lifecycle: {
        version: 1,
        timestamp: 1,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
  });

  it('parses and serializes current grouped initial command metadata', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_command',
        userId: 'user_command',
      },
      auth: {
        kiloSessionId: 'cli_command',
      },
      initialMessage: {
        id: 'msg_018f1e2d3c4bCmdMetaAbCdEfG',
        prompt: '/compact --aggressive',
        turn: {
          type: 'command' as const,
          command: 'compact',
          arguments: '--aggressive',
        },
      },
      lifecycle: {
        version: 1,
        timestamp: 1,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
  });

  it('maps legacy flat metadata into grouped current metadata', () => {
    const legacy = {
      version: 1234,
      timestamp: 1234,
      sessionId: 'agent_123',
      userId: 'user_123',
      orgId: 'org_123',
      botId: 'bot_123',
      createdOnPlatform: 'cloud-agent-web',
      kiloSessionId: 'cli_123',
      kilocodeToken: 'kilo-token',
      githubRepo: 'acme/repo',
      githubToken: 'github-token',
      githubInstallationId: '987',
      githubAppType: 'standard' as const,
      upstreamBranch: 'main',
      prompt: 'Build the thing',
      initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      mode: 'reviewer',
      model: 'kilo/gpt-5',
      variant: 'thinking',
      appendSystemPrompt: 'Extra context',
      autoCommit: true,
      condenseOnComplete: false,
      gateThreshold: 'warning' as const,
      callbackTarget,
      workspacePath: '/workspace',
      sessionHome: '/home/kilo',
      branchName: 'session/agent_123',
      sandboxId: 'usr-abcdef',
      shallow: true,
      preparedAt: 1235,
      initiatedAt: 1236,
      kiloServerLastActivity: 1237,
      profile,
    };

    expect(parseSessionMetadata(legacy)).toEqual({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'agent_123',
        userId: 'user_123',
        orgId: 'org_123',
        botId: 'bot_123',
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: {
        kiloSessionId: 'cli_123',
        kilocodeToken: 'kilo-token',
      },
      repository: {
        type: 'github',
        repo: 'acme/repo',
        githubInstallationId: '987',
        githubAppType: 'standard',
        upstreamBranch: 'main',
      },
      initialMessage: {
        id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        prompt: 'Build the thing',
      },
      agent: {
        mode: 'reviewer',
        model: 'kilo/gpt-5',
        variant: 'thinking',
        appendSystemPrompt: 'Extra context',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: false,
        gateThreshold: 'warning',
      },
      profile,
      callback: { target: callbackTarget },
      workspace: {
        sandboxId: 'usr-abcdef',
        workspacePath: '/workspace',
        sessionHome: '/home/kilo',
        branchName: 'session/agent_123',
        shallow: true,
      },
      lifecycle: {
        version: 1234,
        timestamp: 1234,
        preparedAt: 1235,
        initiatedAt: 1236,
        kiloServerLastActivity: 1237,
      },
    });
  });

  it('ignores unknown fields in current grouped metadata', () => {
    expect(
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        unknownRootField: 'from-newer-writer',
        identity: { sessionId: 'agent_grouped_legacy', userId: 'user_123' },
        auth: {},
        initialMessage: {
          id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          prompt: 'old image turn',
          images: {
            path: '123e4567-e89b-12d3-a456-426614174000',
            files: ['123e4567-e89b-12d3-a456-426614174001.png'],
          },
          turn: {
            type: 'prompt',
            prompt: 'old image turn',
            images: {
              path: '123e4567-e89b-12d3-a456-426614174000',
              files: ['123e4567-e89b-12d3-a456-426614174001.png'],
            },
          },
        },
        lifecycle: { version: 1, timestamp: 1 },
      })
    ).toEqual({
      metadataSchemaVersion: 2,
      identity: { sessionId: 'agent_grouped_legacy', userId: 'user_123' },
      auth: {},
      initialMessage: {
        id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        prompt: 'old image turn',
        turn: { type: 'prompt', prompt: 'old image turn' },
      },
      lifecycle: { version: 1, timestamp: 1 },
    });
  });

  it('maps legacy DIND devcontainer metadata into grouped current metadata', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_legacy_dind',
      userId: 'user_legacy_dind',
      sandboxId: 'dind-abcdef',
      devcontainer: {
        workspacePath: '/workspace/user/sessions/agent_legacy_dind',
        innerWorkspaceFolder: '/workspaces/repo',
        wrapperPort: 4173,
        configPath: '.devcontainer/devcontainer.json',
      },
    });

    expect(metadata.workspace?.sandboxId).toBe('dind-abcdef');
    expect(getSandboxProvider(metadata)).toBe('cloudflare');
    expect(metadata.devcontainer).toEqual({
      workspacePath: '/workspace/user/sessions/agent_legacy_dind',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    });
    expect(serializeSessionMetadata(metadata)).toEqual(metadata);
  });

  it('maps legacy gitlab metadata into grouped repository metadata', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_gitlab',
      userId: 'user_123',
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'gitlab-token',
      platform: 'gitlab' as const,
      gitlabTokenManaged: true,
      mode: 'code',
      model: 'kilo/gpt-5',
    });

    expect(metadata.repository).toEqual({
      type: 'gitlab',
      url: 'https://gitlab.com/acme/repo.git',
      platform: 'gitlab',
      gitlabTokenManaged: true,
    });
  });

  it('parses review-origin GitLab metadata using generic repository context', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_gitlab_review',
        userId: 'user_123',
        createdOnPlatform: 'code-review',
      },
      auth: {},
      repository: {
        type: 'gitlab' as const,
        url: 'https://gitlab.com/acme/repo.git',
        platform: 'gitlab' as const,
      },
      lifecycle: { version: 1, timestamp: 1 },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
  });

  it('serializes captured current branches with shell-safe Git punctuation', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_current_branch',
        userId: 'user_123',
      },
      auth: {},
      repository: {
        type: 'github' as const,
        repo: 'acme/repo',
        upstreamBranch: 'feature/alex+metadata@v2,fix=1#manual',
      },
      lifecycle: { version: 1, timestamp: 1 },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
  });

  it('normalizes current GitHub repository metadata written without a type', () => {
    expect(
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent_current_github_repo', userId: 'user_123' },
        auth: {},
        repository: {
          repo: 'Kilo-Org/cloud',
          platform: 'github',
          upstreamBranch: 'refs/pull/4273/head',
        },
        lifecycle: { version: 1, timestamp: 1 },
      }).repository
    ).toEqual({
      type: 'github',
      repo: 'Kilo-Org/cloud',
      platform: 'github',
      upstreamBranch: 'refs/pull/4273/head',
    });
  });

  it('normalizes current git URL repository metadata written without a type', () => {
    expect(
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent_current_git_url', userId: 'user_123' },
        auth: {},
        repository: {
          url: 'https://github.com/Kilo-Org/cloud.git',
          platform: 'github',
          upstreamBranch: 'chore/local-testing-code-reviews',
        },
        lifecycle: { version: 1, timestamp: 1 },
      }).repository
    ).toEqual({
      type: 'git',
      url: 'https://github.com/Kilo-Org/cloud.git',
      platform: 'github',
      upstreamBranch: 'chore/local-testing-code-reviews',
    });
  });

  it('drops a current repository with an unknown type so the reaper can still read metadata', () => {
    expect(
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent_empty_local_repo', userId: 'user_123' },
        auth: {},
        repository: { type: 'empty-local' },
        lifecycle: { version: 1, timestamp: 1, kiloServerLastActivity: 5 },
      }).repository
    ).toBeUndefined();
  });

  it('drops current repository metadata without enough repository identity', () => {
    expect(
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'agent_invalid_repository', userId: 'user_123' },
        auth: {},
        repository: { upstreamBranch: 'main' },
        lifecycle: { version: 1, timestamp: 1 },
      }).repository
    ).toBeUndefined();
  });

  it('persists Bitbucket identity and managed status without a token', () => {
    const metadata = parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId: 'agent_bitbucket', userId: 'user_123' },
      auth: {},
      repository: {
        type: 'bitbucket',
        url: 'https://bitbucket.org/acme/repo.git',
        platform: 'bitbucket',
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
        bitbucketIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
        bitbucketTokenManaged: true,
        token: 'must-not-persist',
      },
      lifecycle: { version: 1, timestamp: 1 },
    });

    expect(metadata.repository).toEqual({
      type: 'bitbucket',
      url: 'https://bitbucket.org/acme/repo.git',
      platform: 'bitbucket',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      bitbucketIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
      bitbucketTokenManaged: true,
    });
    expect(JSON.stringify(serializeSessionMetadata(metadata))).not.toContain('must-not-persist');
  });

  it('persists Bitbucket code-review sessions with generic repository and callback metadata only', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_bitbucket_review',
        userId: 'user_123',
        orgId: '123e4567-e89b-12d3-a456-426614174099',
        createdOnPlatform: 'code-review',
      },
      auth: {},
      repository: {
        type: 'bitbucket' as const,
        url: 'https://bitbucket.org/acme/repo.git',
        platform: 'bitbucket' as const,
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
        codeReview: {
          integrationId: '123e4567-e89b-12d3-a456-426614174022',
          pullRequestId: 42,
          expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
          reviewId: '123e4567-e89b-12d3-a456-426614174023',
        },
      },
      callback: {
        target: {
          url: 'https://kilo.example/api/internal/code-review-status/123e4567-e89b-12d3-a456-426614174023',
        },
      },
      lifecycle: { version: 1, timestamp: 1 },
    };

    const metadata = parseSessionMetadata(current);
    expect(metadata.repository).toEqual({
      type: 'bitbucket',
      url: 'https://bitbucket.org/acme/repo.git',
      platform: 'bitbucket',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    });
    expect(metadata.callback).toEqual(current.callback);
    expect(JSON.stringify(serializeSessionMetadata(metadata))).not.toContain('codeReview');
  });

  it('preserves legacy generic git tokens in grouped repository metadata', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_git',
      userId: 'user_123',
      gitUrl: 'https://git.example.com/acme/repo.git',
      gitToken: 'generic-git-token',
      mode: 'code',
      model: 'kilo/gpt-5',
    });

    expect(metadata.repository).toEqual({
      type: 'git',
      url: 'https://git.example.com/acme/repo.git',
      token: 'generic-git-token',
    });
  });

  it('falls back to legacy flat profile fields only inside the parser boundary', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_profile',
      userId: 'user_123',
      envVars: { A: 'B' },
      setupCommands: ['echo ok'],
      mode: 'code',
      model: 'kilo/gpt-5',
    });

    expect(metadata.profile).toEqual({
      envVars: { A: 'B' },
      setupCommands: ['echo ok'],
    });
  });

  it('does not parse invalid current metadata as legacy', () => {
    expect(() =>
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        version: 1,
        timestamp: 1,
        sessionId: 'agent_flat',
        userId: 'user_123',
      })
    ).toThrow('Invalid current session metadata');
  });
});
