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
vi.mock('../../drizzle/migrations', () => ({ default: { journal: {}, migrations: {} } }));
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

const { isSameRegistrationRepository } = await import('../persistence/CloudAgentSession.js');

const GITHUB_REPOSITORY = {
  type: 'github' as const,
  repo: 'acme/widgets',
  pullRequestNumber: 17,
};

describe('session registration repository metadata', () => {
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

  it('rejects a replay submission for a different pull request', () => {
    const metadata = {
      repository: { ...GITHUB_REPOSITORY, githubAccessPurpose: 'workflow' },
    } as unknown as Parameters<typeof isSameRegistrationRepository>[0];

    const input = (pullRequestNumber: number) =>
      ({
        repository: { ...GITHUB_REPOSITORY, pullRequestNumber },
      }) as unknown as Parameters<typeof isSameRegistrationRepository>[1];

    expect(isSameRegistrationRepository(metadata, input(17))).toBe(true);
    expect(isSameRegistrationRepository(metadata, input(18))).toBe(false);
  });
});
