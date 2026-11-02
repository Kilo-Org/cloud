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

  it('persists the GitHub user authorization decision from the registration input', async () => {
    const result = await buildSessionMetadataFromRegistration({
      identity: { sessionId: 'agent_test', userId: 'user_test', orgId: 'org_test' },
      auth: {},
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: { ...GITHUB_REPOSITORY, allowUserAuthorization: true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.repository).toMatchObject({
      type: 'github',
      repo: 'acme/widgets',
      allowUserAuthorization: true,
    });
  });

  it('persists stacked base fields and the parent worktree, and appends the stack instruction', async () => {
    const baseSha = 'a'.repeat(40);
    const result = await buildSessionMetadataFromRegistration({
      identity: { sessionId: 'workspace_child', userId: 'user_fixture' },
      auth: {},
      agent: { mode: 'code', model: 'kilo/test-model', appendSystemPrompt: 'Be concise.' },
      repository: { ...GITHUB_REPOSITORY, baseBranch: 'feat/parent', baseSha },
      parentWorktreeId: 'worktree_12345678-1234-4123-8123-123456789012',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.repository).toMatchObject({
      type: 'github',
      baseBranch: 'feat/parent',
      baseSha,
    });
    expect(result.metadata.workspace?.parentWorktreeId).toBe(
      'worktree_12345678-1234-4123-8123-123456789012'
    );
    expect(result.metadata.agent?.appendSystemPrompt).toContain('Be concise.');
    expect(result.metadata.agent?.appendSystemPrompt).toContain('--base feat/parent');
    expect(result.metadata.agent?.appendSystemPrompt).toContain(
      'Do not rebase or push branches other than'
    );
    expect(result.metadata.agent?.appendSystemPrompt).toContain(
      result.metadata.workspace?.branchName
    );
  });

  it('does not write stacked fields or the stack instruction for a fork/clone create', async () => {
    const result = await buildSessionMetadataFromRegistration({
      identity: { sessionId: 'workspace_fork', userId: 'user_fixture' },
      auth: {},
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: GITHUB_REPOSITORY,
      clone: {
        cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.repository).not.toHaveProperty('baseBranch');
    expect(result.metadata.repository).not.toHaveProperty('baseSha');
    expect(result.metadata.workspace?.parentWorktreeId).toBeUndefined();
    expect(result.metadata.agent?.appendSystemPrompt).toBeUndefined();
  });
});
