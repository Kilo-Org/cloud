import { describe, expect, it, vi } from 'vitest';
import { buildSessionMetadataFromRegistration } from './session-registration-metadata.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  getSandbox: vi.fn(),
  ContainerProxy: class ContainerProxy {},
}));

vi.mock('@cloudflare/containers', () => ({}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../logger.js', () => {
  const logger = {
    setTags: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return {
    logger,
    withLogTags: async (_tags: unknown, fn: () => Promise<void>) => fn(),
    WithLogTags: () => (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) =>
      descriptor,
  };
});

vi.mock('drizzle-orm/durable-sqlite', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate: vi.fn() }));
vi.mock('./queries/index.js', () => ({
  createExecutionQueries: vi.fn(() => ({})),
  createEventQueries: vi.fn(() => ({})),
  createLeaseQueries: vi.fn(() => ({})),
}));
vi.mock('../websocket/stream.js', () => ({
  createStreamHandler: vi.fn(),
  getConnectedStreamClientCount: vi.fn(() => 0),
}));
vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ api_token_pepper: null, blocked_reason: null }] }),
      }),
    }),
  }),
}));

const GITHUB_REPOSITORY = {
  type: 'github' as const,
  repo: 'acme/widgets',
  pullRequestNumber: 17,
};

describe('session registration repository metadata', () => {
  it('stores opt-in and server-authoritative child lineage outside the profile bundle', async () => {
    for (const scope of [
      { allowSubagentSessions: true },
      { parentCloudAgentSessionId: 'workspace_parent' },
      { allowSubagentSessions: true, parentCloudAgentSessionId: 'workspace_parent' },
    ]) {
      const result = await buildSessionMetadataFromRegistration({
        identity: { sessionId: 'workspace_child', userId: 'user_fixture' },
        auth: {},
        agent: { mode: 'code', model: 'kilo/test-model' },
        repository: GITHUB_REPOSITORY,
        ...scope,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.metadata.allowSubagentSessions).toBe(scope.allowSubagentSessions ?? false);
      expect(result.metadata.parentCloudAgentSessionId).toBe(scope.parentCloudAgentSessionId);
      expect(result.metadata.profile).toBeUndefined();
    }
  });

  it('persists the GitHub pull request number from the registration input', async () => {
    const result = await buildSessionMetadataFromRegistration({
      identity: { sessionId: 'agent_test', userId: 'user_test' },
      auth: {},
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: GITHUB_REPOSITORY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.repository).toMatchObject({
      type: 'github',
      repo: 'acme/widgets',
      pullRequestNumber: 17,
    });
  });
});

describe('session registration environment metadata', () => {
  const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
  const memberOf = (repoFullName: string) => ({
    identity: { platform: 'github' as const, repoFullName },
    repoFullName,
    leaf: repoFullName.split('/')[1],
  });
  const V2_SCOPE = {
    environmentId: ENVIRONMENT_ID,
    owner: { type: 'user' as const, id: 'user_fixture' },
    configurationRevision: 2,
    repositories: [memberOf('acme/widgets'), memberOf('acme/api'), memberOf('acme/docs')],
  };
  const V1_SCOPE = {
    environmentId: ENVIRONMENT_ID,
    owner: { type: 'user' as const, id: 'user_fixture' },
    configurationRevision: 2,
    repository: { platform: 'github' as const, repoFullName: 'acme/widgets' },
  };
  const build = async (overrides: Record<string, unknown>) => {
    const result = await buildSessionMetadataFromRegistration({
      identity: { sessionId: 'agent_test', userId: 'user_fixture' },
      auth: {},
      agent: { mode: 'code', model: 'kilo/test-model' },
      ...overrides,
    });
    if (!result.ok) throw new Error(result.error);
    return result.metadata;
  };

  it('uses one generated branch for the branch name, the generated field and unrequested members', async () => {
    const metadata = await build({
      repository: { type: 'github', repo: 'acme/widgets' },
      environment: V2_SCOPE,
      requestedEnvironmentRepositories: [{ repoFullName: 'acme/api', branch: 'feature/api' }],
    });

    const generated = metadata.workspace?.generatedBranchName;
    expect(generated).toMatch(/^kilo\/.+/);
    expect(metadata.workspace?.branchName).toBe(generated);
    expect(
      metadata.environment?.repositories?.map(entry => [entry.repoFullName, entry.branch])
    ).toEqual([
      ['acme/widgets', generated],
      ['acme/api', 'feature/api'],
      ['acme/docs', generated],
    ]);
  });

  it('keeps the upstream branch as the branch name and the launch branch, and the generated branch for the rest', async () => {
    const metadata = await build({
      repository: { type: 'github', repo: 'acme/widgets', branch: 'release/1' },
      environment: V2_SCOPE,
    });

    const generated = metadata.workspace?.generatedBranchName;
    expect(metadata.workspace?.branchName).toBe('release/1');
    expect(generated).toMatch(/^kilo\/.+/);
    expect(
      metadata.environment?.repositories?.map(entry => [entry.repoFullName, entry.branch])
    ).toEqual([
      ['acme/widgets', 'release/1'],
      ['acme/api', generated],
      ['acme/docs', generated],
    ]);
  });

  it('stores the V1 reference as it is and no generated field', async () => {
    const metadata = await build({
      repository: { type: 'github', repo: 'acme/widgets' },
      environment: V1_SCOPE,
    });

    expect(metadata.environment).toEqual(V1_SCOPE);
    expect(metadata.workspace).not.toHaveProperty('generatedBranchName');
  });

  it('stores no generated field without an environment', async () => {
    const metadata = await build({ repository: { type: 'github', repo: 'acme/widgets' } });

    expect(metadata.environment).toBeUndefined();
    expect(metadata.workspace).not.toHaveProperty('generatedBranchName');
  });

  it('rejects a V2 environment on a repository that has no environment identity', async () => {
    const result = await buildSessionMetadataFromRegistration({
      identity: { sessionId: 'agent_test', userId: 'user_fixture' },
      auth: {},
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: { type: 'git', url: 'https://example.com/repo.git' },
      environment: V2_SCOPE,
    });

    expect(result).toMatchObject({ ok: false });
  });
});
