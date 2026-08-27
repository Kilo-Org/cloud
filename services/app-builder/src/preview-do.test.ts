import { beforeEach, describe, expect, it, vi } from 'vitest';

const sandbox = {
  exec: vi.fn(),
  execStream: vi.fn(),
  gitCheckout: vi.fn(),
  startProcess: vi.fn(),
  listProcesses: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('cloudflare:workers', () => ({
  DurableObject: class<Environment> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Environment;

    constructor(ctx: DurableObjectState, env: Environment) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: () => sandbox,
  parseSSEStream: vi.fn(() =>
    (async function* () {
      yield { type: 'complete', exitCode: 0, data: '' };
    })()
  ),
}));

vi.mock('./db-provisioner', () => ({
  DBProvisionResult: { PROVISIONED: 'provisioned', EXISTS: 'exists' },
  createDBProvisioner: () => ({
    provisionIfNeeded: vi.fn(async () => 'exists'),
  }),
}));

import { PreviewDO } from './preview-do';
import type { Env, PreviewPersistedState } from './types';

function createStorage(initialState?: PreviewPersistedState) {
  const values = new Map<string, unknown>();
  if (initialState) values.set('state', initialState);
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    deleteAll: vi.fn(async () => values.clear()),
  };
}

function createPreview(
  storage: ReturnType<typeof createStorage>,
  getTokenForRepo: ReturnType<typeof vi.fn>
) {
  const startup: Promise<unknown>[] = [];
  const waits: Promise<unknown>[] = [];
  const ctx = {
    id: { name: 'app-1' },
    storage,
    blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) => {
      const promise = callback();
      startup.push(promise);
      return promise;
    }),
    waitUntil: vi.fn((promise: Promise<unknown>) => waits.push(promise)),
  } as unknown as DurableObjectState;
  const env = {
    SANDBOX: {},
    GIT_TOKEN_SERVICE: { getTokenForRepo },
    BUILDER_HOSTNAME: 'builder.example.com',
    GIT_JWT_SECRET: 'test-secret',
  } as unknown as Env;
  return { preview: new PreviewDO(ctx, env), startup, waits };
}

const source = {
  githubRepo: 'acme/secondary',
  userId: 'oauth/example-user',
  orgId: '123e4567-e89b-12d3-a456-426614174001',
  expectedPlatformIntegrationId: '123e4567-e89b-12d3-a456-426614174002',
};

beforeEach(() => {
  vi.clearAllMocks();
  sandbox.exec.mockImplementation(async (command: string) =>
    command === 'test -d /workspace/.git'
      ? { exitCode: 1, success: false, stderr: '' }
      : { exitCode: 0, success: true, stderr: '' }
  );
  sandbox.gitCheckout.mockResolvedValue({ success: true });
  sandbox.execStream.mockResolvedValue({});
  sandbox.startProcess.mockResolvedValue(undefined);
  sandbox.listProcesses.mockResolvedValue([]);
  sandbox.destroy.mockResolvedValue(undefined);
});

describe('PreviewDO GitHub source identity', () => {
  it('persists the expected integration and reuses it after restart', async () => {
    const storage = createStorage();
    const firstTokenLookup = vi.fn();
    const first = createPreview(storage, firstTokenLookup);
    await Promise.all(first.startup);
    await first.preview.initWithAppId('app-1');
    await first.preview.setGitHubSource(source);

    const persisted = storage.values.get('state') as PreviewPersistedState;
    expect(persisted.githubSource).toEqual(source);

    const restartedTokenLookup = vi.fn().mockResolvedValue({
      success: true,
      token: 'github-token',
      installationId: 'installation-2',
      accountLogin: 'acme',
      appType: 'lite',
    });
    const restarted = createPreview(storage, restartedTokenLookup);
    await Promise.all(restarted.startup);
    await restarted.preview.triggerBuild();
    await Promise.all(restarted.waits);

    expect(restartedTokenLookup).toHaveBeenCalledWith({
      githubRepo: source.githubRepo,
      userId: source.userId,
      orgId: source.orgId,
      expectedIntegrationId: source.expectedPlatformIntegrationId,
    });
  });

  it('keeps legacy unpinned state readable and lets ambiguous resolution fail closed', async () => {
    const legacyState: PreviewPersistedState = {
      appId: 'app-1',
      lastError: null,
      dbCredentials: null,
      githubSource: {
        githubRepo: source.githubRepo,
        userId: source.userId,
        orgId: source.orgId,
      },
    };
    const storage = createStorage(legacyState);
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    const { preview, startup, waits } = createPreview(storage, getTokenForRepo);
    await Promise.all(startup);
    await preview.triggerBuild();
    await expect(Promise.all(waits)).rejects.toThrow(
      'Failed to get GitHub token: no_installation_found'
    );

    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: source.githubRepo,
      userId: source.userId,
      orgId: source.orgId,
      expectedIntegrationId: undefined,
    });
    expect((storage.values.get('state') as PreviewPersistedState).lastError).toBe(
      'Failed to get GitHub token: no_installation_found'
    );
  });
});
