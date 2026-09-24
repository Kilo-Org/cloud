import { describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE } from '@kilocode/worker-utils/sandbox-allocation';
import { parseSessionMetadata, serializeSessionMetadata } from '../persistence/session-metadata.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { createSandboxTerminalLifecycle, SANDBOX_SESSION_METADATA_KEY } from './terminal-lifecycle.js';
import {
  resolveWarmBaseLaunch,
  warmBaseInstance,
  type WarmBaseContainerFacts,
} from './warm-base-launch.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const WRAPPER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const LEGACY_DIRECTORY = `/workspace/user_1/sessions/${SESSION_ID}`;
const HEX64 = /^[0-9a-f]{64}$/;
const WARM_DIRECTORY = /^\/workspace\/warm\/[0-9a-f]{64}$/;
const GIT_REPOSITORY = { type: 'git', url: 'https://example.test/acme/demo.git' } as const;
const SECRETS = {
  SECRET_TOKEN: {
    encryptedData: 'ZW5jcnlwdGVk',
    encryptedDEK: 'ZGVr',
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  },
} as const;

function metadata(
  options: {
    workspacePath?: string;
    worktreeId?: string;
    provider?: string;
    branchName?: string;
    repository?: SessionMetadata['repository'];
    profile?: SessionMetadata['profile'];
    orgId?: string;
    userId?: string;
    sandboxAllocation?: NonNullable<SessionMetadata['workspace']>['sandboxAllocation'];
  } = {}
): SessionMetadata {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: SESSION_ID,
      userId: options.userId ?? 'user_1',
      ...(options.orgId ? { orgId: options.orgId } : {}),
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: 'kilo_session_1' },
    agent: { mode: 'code', model: 'test-model' },
    ...(options.repository ? { repository: options.repository } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    workspace: {
      sandboxId: SANDBOX_ID,
      sandboxProvider: options.provider ?? 'cloudflare-containers',
      ...(options.sandboxAllocation ? { sandboxAllocation: options.sandboxAllocation } : {}),
      ...(options.branchName ? { branchName: options.branchName } : {}),
      ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
      ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function containerFacts(overrides: Partial<WarmBaseContainerFacts> = {}): WarmBaseContainerFacts {
  return { image: 'img', sessionSnapshotId: null, hasRecord: false, ...overrides };
}

function deps(facts: WarmBaseContainerFacts, record: unknown = null) {
  return {
    readContainerFacts: vi.fn(async () => facts),
    readWarmRecord: vi.fn(async () => record),
    persistWorkspacePath: vi.fn((value: SessionMetadata, workspacePath: string) => ({
      ...value,
      workspace: { ...(value.workspace ?? {}), workspacePath },
    })),
  };
}

async function resolve(
  value: SessionMetadata,
  d: ReturnType<typeof deps>,
  provider: 'cloudflare-containers' | 'cloudflare' = 'cloudflare-containers'
) {
  return resolveWarmBaseLaunch({
    metadata: value,
    provider,
    directory: LEGACY_DIRECTORY,
    ...d,
  });
}

describe('warmBaseInstance', () => {
  it('falls back to the containers launch default instance', () => {
    expect(warmBaseInstance(metadata())).toBe(CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE);
  });
});

describe('resolveWarmBaseLaunch', () => {
  it('adopts the stable path for a brand-new session and consumes the warm record', async () => {
    const record = { id: 'warm_snap', expiresAt: Date.now() + 60_000 };
    const d = deps(containerFacts(), record);

    const result = await resolve(metadata(), d);

    expect(d.persistWorkspacePath).toHaveBeenCalledTimes(1);
    const warmPath = d.persistWorkspacePath.mock.calls[0][1];
    expect(warmPath).toMatch(/^\/workspace\/warm\/[0-9a-f]{64}$/);
    expect(result.directory).toBe(warmPath);
    expect(result.metadata.workspace?.workspacePath).toBe(warmPath);
    expect(result.snapshotId).toBe('warm_snap');
    expect(result.publishDigest).toBeDefined();
    expect(d.readWarmRecord).toHaveBeenCalledTimes(1);
  });

  it('derives the same publish digest for two different branch names', async () => {
    const first = await resolve(metadata({ branchName: 'feature/one' }), deps(containerFacts()));
    const second = await resolve(metadata({ branchName: 'feature/two' }), deps(containerFacts()));

    expect(first.publishDigest).toMatch(HEX64);
    expect(second.publishDigest).toMatch(HEX64);
    expect(second.publishDigest).toBe(first.publishDigest);
  });

  it('derives the same publish digest for working and explicit checkout of one branch', async () => {
    const url = 'https://example.test/acme/demo.git';
    const working = await resolve(
      metadata({ branchName: 'feature/x', repository: { type: 'git', url } }),
      deps(containerFacts())
    );
    const explicit = await resolve(
      metadata({
        branchName: 'feature/x',
        repository: { type: 'git', url, upstreamBranch: 'feature/x' },
      }),
      deps(containerFacts())
    );

    expect(working.publishDigest).toMatch(HEX64);
    expect(explicit.publishDigest).toMatch(HEX64);
    expect(explicit.publishDigest).toBe(working.publishDigest);
  });

  it('returns the persisted directory even when persist resolves to a different path', async () => {
    const pinned = '/workspace/user_1/sessions/pinned';
    const d: ReturnType<typeof deps> = {
      readContainerFacts: vi.fn(async () => containerFacts()),
      readWarmRecord: vi.fn(async () => null),
      persistWorkspacePath: vi.fn((value: SessionMetadata) => ({
        ...value,
        workspace: { ...(value.workspace ?? {}), workspacePath: pinned },
      })),
    };

    const result = await resolve(metadata(), d);

    expect(result.metadata.workspace?.workspacePath).toBe(pinned);
    expect(result.directory).toBe(pinned);
  });

  it('continues at the adopted warm path on a later readiness drain and keeps publication eligibility', async () => {
    const firstDeps = deps(containerFacts(), null);
    const first = await resolve(metadata(), firstDeps);
    expect(firstDeps.persistWorkspacePath).toHaveBeenCalledTimes(1);
    expect(first.snapshotId).toBeUndefined();
    expect(first.publishDigest).toMatch(HEX64);

    const secondDeps = deps(containerFacts({ hasRecord: true }), {
      id: 'other_snap',
      expiresAt: Date.now() + 60_000,
    });
    const second = await resolve(metadata({ workspacePath: first.directory }), secondDeps);

    expect(second.directory).toBe(first.directory);
    expect(second.metadata.workspace?.workspacePath).toBe(first.directory);
    expect(second.publishDigest).toMatch(HEX64);
    expect(second.publishDigest).toBe(first.publishDigest);
    expect(second.snapshotId).toBeUndefined();
    expect(secondDeps.persistWorkspacePath).not.toHaveBeenCalled();
    expect(secondDeps.readWarmRecord).not.toHaveBeenCalled();
  });

  it('pins the legacy directory when preparation history exists and never relocates', async () => {
    const d = deps(containerFacts({ hasRecord: true }), {
      id: 'warm',
      expiresAt: Date.now() + 60_000,
    });

    const result = await resolve(metadata(), d);

    expect(result.directory).toBe(LEGACY_DIRECTORY);
    expect(result.metadata.workspace?.workspacePath).toBe(LEGACY_DIRECTORY);
    expect(result.snapshotId).toBeUndefined();
    expect(result.publishDigest).toBeUndefined();
    expect(d.persistWorkspacePath).toHaveBeenCalledTimes(1);
    expect(d.persistWorkspacePath).toHaveBeenCalledWith(expect.anything(), LEGACY_DIRECTORY);
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('pins the legacy directory while a session snapshot exists', async () => {
    const d = deps(containerFacts({ sessionSnapshotId: 'snap_session' }), {
      id: 'warm',
      expiresAt: Date.now() + 60_000,
    });

    const result = await resolve(metadata(), d);

    expect(result.directory).toBe(LEGACY_DIRECTORY);
    expect(result.metadata.workspace?.workspacePath).toBe(LEGACY_DIRECTORY);
    expect(result.publishDigest).toBeUndefined();
    expect(d.persistWorkspacePath).toHaveBeenCalledWith(expect.anything(), LEGACY_DIRECTORY);
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('pins the legacy directory when container facts are unavailable and a later drain does not relocate', async () => {
    const failing = {
      readContainerFacts: vi.fn(async () => {
        throw new Error('container facts unavailable');
      }),
      readWarmRecord: vi.fn(async () => null),
      persistWorkspacePath: vi.fn((value: SessionMetadata, workspacePath: string) => ({
        ...value,
        workspace: { ...(value.workspace ?? {}), workspacePath },
      })),
    };

    const first = await resolve(metadata(), failing);

    expect(first.directory).toBe(LEGACY_DIRECTORY);
    expect(first.metadata.workspace?.workspacePath).toBe(LEGACY_DIRECTORY);
    expect(first.publishDigest).toBeUndefined();
    expect(failing.persistWorkspacePath).toHaveBeenCalledWith(expect.anything(), LEGACY_DIRECTORY);

    const later = deps(containerFacts());
    const second = await resolve(first.metadata, later);

    expect(second.directory).toBe(LEGACY_DIRECTORY);
    expect(second.metadata.workspace?.workspacePath).toBe(LEGACY_DIRECTORY);
    expect(second.publishDigest).toBeUndefined();
    expect(later.persistWorkspacePath).not.toHaveBeenCalled();
    expect(later.readWarmRecord).not.toHaveBeenCalled();
  });

  it('preserves a diverging resolved path and refuses warm', async () => {
    const d = deps(containerFacts());

    const result = await resolve(metadata({ workspacePath: '/workspace/other' }), d);

    expect(result.directory).toBe('/workspace/other');
    expect(result.metadata.workspace?.workspacePath).toBe('/workspace/other');
    expect(result.publishDigest).toBeUndefined();
    expect(d.persistWorkspacePath).not.toHaveBeenCalled();
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('refuses warm for an adopted path when a session snapshot now exists', async () => {
    const first = await resolve(metadata(), deps(containerFacts()));

    const d = deps(containerFacts({ sessionSnapshotId: 'snap_session' }), {
      id: 'warm_snap',
      expiresAt: Date.now() + 60_000,
    });
    const result = await resolve(metadata({ workspacePath: first.directory }), d);

    expect(result.directory).toBe(first.directory);
    expect(result.publishDigest).toBeUndefined();
    expect(d.persistWorkspacePath).not.toHaveBeenCalled();
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('does not pin or read container state for a worktree-scoped session', async () => {
    const d = deps(containerFacts());

    const result = await resolve(
      metadata({ worktreeId: 'worktree_33333333-3333-4333-8333-333333333333' }),
      d
    );

    expect(result.publishDigest).toBeUndefined();
    expect(d.readContainerFacts).not.toHaveBeenCalled();
    expect(d.persistWorkspacePath).not.toHaveBeenCalled();
  });

  it('does not pin or read container state for another provider', async () => {
    const d = deps(containerFacts());

    const result = await resolve(metadata(), d, 'cloudflare');

    expect(result.publishDigest).toBeUndefined();
    expect(d.readContainerFacts).not.toHaveBeenCalled();
    expect(d.persistWorkspacePath).not.toHaveBeenCalled();
  });
});

describe('resolveWarmBaseLaunch warm-base key', () => {
  it('derives one key for sessions with and without setup commands', async () => {
    const withoutSetup = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { setupCommands: [] } }),
      deps(containerFacts())
    );
    const withSetup = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { setupCommands: ['pnpm install'] } }),
      deps(containerFacts())
    );

    expect(withoutSetup.publishDigest).toMatch(HEX64);
    expect(withSetup.publishDigest).toMatch(HEX64);
    expect(withSetup.publishDigest).toBe(withoutSetup.publishDigest);
    expect(withoutSetup.directory).toMatch(WARM_DIRECTORY);
    expect(withSetup.directory).toBe(withoutSetup.directory);
  });

  it('derives one key across differing environment values', async () => {
    const first = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { envVars: { FOO: 'one' } } }),
      deps(containerFacts())
    );
    const second = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { envVars: { FOO: 'two' } } }),
      deps(containerFacts())
    );

    expect(first.publishDigest).toMatch(HEX64);
    expect(second.publishDigest).toMatch(HEX64);
    expect(second.publishDigest).toBe(first.publishDigest);
  });

  it('consumes and publishes the shared key with encrypted secrets', async () => {
    const record = { id: 'warm_snap', expiresAt: Date.now() + 60_000 };
    const d = deps(containerFacts(), record);

    const result = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { encryptedSecrets: SECRETS } }),
      d
    );

    expect(result.publishDigest).toMatch(HEX64);
    expect(result.snapshotId).toBe('warm_snap');
    expect(result.directory).toMatch(WARM_DIRECTORY);
    expect(result.directory).not.toBe(LEGACY_DIRECTORY);
    expect(d.readWarmRecord).toHaveBeenCalledTimes(1);
    expect(d.readWarmRecord).toHaveBeenCalledWith(result.publishDigest);

    const plain = await resolve(metadata({ repository: GIT_REPOSITORY }), deps(containerFacts()));
    expect(plain.publishDigest).toMatch(HEX64);
    expect(result.publishDigest).toBe(plain.publishDigest);
  });

  it('treats an empty encrypted-secret record as an ordinary session', async () => {
    const d = deps(containerFacts());

    const result = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { encryptedSecrets: {} } }),
      d
    );

    expect(result.publishDigest).toMatch(HEX64);
    expect(result.directory).toMatch(WARM_DIRECTORY);
    expect(d.readWarmRecord).toHaveBeenCalledTimes(1);
  });

  it('continues on a matching warm path with encrypted secrets and no record read', async () => {
    const first = await resolve(metadata({ repository: GIT_REPOSITORY }), deps(containerFacts()));
    expect(first.publishDigest).toMatch(HEX64);
    expect(first.directory).toMatch(WARM_DIRECTORY);

    const d = deps(containerFacts({ hasRecord: true }), {
      id: 'other_snap',
      expiresAt: Date.now() + 60_000,
    });
    const second = await resolve(
      metadata({
        repository: GIT_REPOSITORY,
        workspacePath: first.directory,
        profile: { encryptedSecrets: SECRETS },
      }),
      d
    );

    expect(second.publishDigest).toMatch(HEX64);
    expect(second.directory).toBe(first.directory);
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('changes the key for a different owner, repository, or image', async () => {
    const baseline = await resolve(metadata({ repository: GIT_REPOSITORY }), deps(containerFacts()));
    const otherOwner = await resolve(
      metadata({ repository: GIT_REPOSITORY, orgId: 'org_2' }),
      deps(containerFacts())
    );
    const otherRepository = await resolve(
      metadata({ repository: { type: 'git', url: 'https://example.test/acme/other.git' } }),
      deps(containerFacts())
    );
    const otherImage = await resolve(
      metadata({ repository: GIT_REPOSITORY }),
      deps(containerFacts({ image: 'other-image' }))
    );

    expect(baseline.publishDigest).toMatch(HEX64);
    for (const result of [otherOwner, otherRepository, otherImage]) {
      expect(result.publishDigest).toMatch(HEX64);
      expect(result.publishDigest).not.toBe(baseline.publishDigest);
    }
  });

  it('keys the owner by org rather than user', async () => {
    const first = await resolve(
      metadata({ repository: GIT_REPOSITORY, orgId: 'org_1', userId: 'user_1' }),
      deps(containerFacts())
    );
    const second = await resolve(
      metadata({ repository: GIT_REPOSITORY, orgId: 'org_1', userId: 'user_2' }),
      deps(containerFacts())
    );

    expect(first.publishDigest).toMatch(HEX64);
    expect(second.publishDigest).toMatch(HEX64);
    expect(second.publishDigest).toBe(first.publishDigest);
  });

  it('defaults the instance to standard-4 and distinguishes standard-3', async () => {
    const omitted = await resolve(metadata({ repository: GIT_REPOSITORY }), deps(containerFacts()));
    const standardFour = await resolve(
      metadata({
        repository: GIT_REPOSITORY,
        sandboxAllocation: 'cloudflare-containers-standard-4',
      }),
      deps(containerFacts())
    );
    const standardThree = await resolve(
      metadata({
        repository: GIT_REPOSITORY,
        sandboxAllocation: 'cloudflare-containers-standard-3',
      }),
      deps(containerFacts())
    );

    expect(omitted.publishDigest).toMatch(HEX64);
    expect(standardFour.publishDigest).toMatch(HEX64);
    expect(standardThree.publishDigest).toMatch(HEX64);
    expect(standardFour.publishDigest).toBe(omitted.publishDigest);
    expect(standardThree.publishDigest).not.toBe(omitted.publishDigest);
  });
});

describe('resolveWarmBaseLaunch guards with encrypted secrets', () => {
  it('refuses warm when preparation history exists', async () => {
    const d = deps(containerFacts({ hasRecord: true }), {
      id: 'warm',
      expiresAt: Date.now() + 60_000,
    });
    const result = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { encryptedSecrets: SECRETS } }),
      d
    );

    expect(result.publishDigest).toBeUndefined();
    expect(result.directory).toBe(LEGACY_DIRECTORY);
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('refuses warm while a session snapshot exists', async () => {
    const d = deps(containerFacts({ sessionSnapshotId: 'snap_session' }), {
      id: 'warm',
      expiresAt: Date.now() + 60_000,
    });
    const result = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { encryptedSecrets: SECRETS } }),
      d
    );

    expect(result.publishDigest).toBeUndefined();
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('refuses warm when container facts are unavailable', async () => {
    const d = {
      readContainerFacts: vi.fn(async () => {
        throw new Error('container facts unavailable');
      }),
      readWarmRecord: vi.fn(async () => null),
      persistWorkspacePath: vi.fn((value: SessionMetadata, workspacePath: string) => ({
        ...value,
        workspace: { ...(value.workspace ?? {}), workspacePath },
      })),
    };
    const result = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { encryptedSecrets: SECRETS } }),
      d
    );

    expect(result.publishDigest).toBeUndefined();
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('refuses warm for a diverging resolved path', async () => {
    const d = deps(containerFacts());
    const result = await resolve(
      metadata({
        repository: GIT_REPOSITORY,
        workspacePath: '/workspace/other',
        profile: { encryptedSecrets: SECRETS },
      }),
      d
    );

    expect(result.publishDigest).toBeUndefined();
    expect(result.directory).toBe('/workspace/other');
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('does not consult container state for a worktree-scoped session', async () => {
    const d = deps(containerFacts());
    const result = await resolve(
      metadata({
        repository: GIT_REPOSITORY,
        worktreeId: 'worktree_33333333-3333-4333-8333-333333333333',
        profile: { encryptedSecrets: SECRETS },
      }),
      d
    );

    expect(result.publishDigest).toBeUndefined();
    expect(d.readContainerFacts).not.toHaveBeenCalled();
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });

  it('does not consult container state for another provider', async () => {
    const d = deps(containerFacts());
    const result = await resolve(
      metadata({ repository: GIT_REPOSITORY, profile: { encryptedSecrets: SECRETS } }),
      d,
      'cloudflare'
    );

    expect(result.publishDigest).toBeUndefined();
    expect(d.readContainerFacts).not.toHaveBeenCalled();
    expect(d.readWarmRecord).not.toHaveBeenCalled();
  });
});

describe('resolveWarmBaseLaunch recording', () => {
  it('records the resolver output at the returned directory', async () => {
    const values = new Map<string, unknown>();
    const storage = {
      kv: {
        get: <T = unknown>(key: string): T | undefined => values.get(key) as T | undefined,
        put: <T>(key: string, value: T): void => {
          values.set(key, value);
        },
        delete: (key: string): boolean => values.delete(key),
        list: <T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]> =>
          [...values.entries()]
            .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
            .map(([key, value]) => [key, value as T]),
      },
      transactionSync: <T>(callback: () => T): T => callback(),
    } as DurableObjectStorage;
    const initial = metadata();
    storage.kv.put(SANDBOX_SESSION_METADATA_KEY, serializeSessionMetadata(initial));
    const lifecycle = createSandboxTerminalLifecycle({
      state: { storage },
      getSessionId: () => SESSION_ID,
      getControl: () => ({}) as never,
      getDirectory: value => value.workspace?.workspacePath ?? LEGACY_DIRECTORY,
      closeTerminalBridge: () => {},
      closeAllBridges: () => {},
      closeRuntimeBridges: () => {},
    });

    const d = deps(containerFacts(), { id: 'warm_snap', expiresAt: Date.now() + 60_000 });
    const result = await resolve(initial, d);
    storage.kv.put(
      SANDBOX_SESSION_METADATA_KEY,
      serializeSessionMetadata({
        ...initial,
        workspace: { ...initial.workspace, workspacePath: result.directory },
      })
    );

    expect(result.directory).toContain('/workspace/warm/');
    expect(result.metadata.workspace?.workspacePath).toBe(result.directory);
    expect(
      lifecycle.recordAttachment({
        metadata: result.metadata,
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: WRAPPER_INSTANCE_ID,
        epoch: lifecycle.captureEpoch() ?? -1,
      })
    ).toBe(true);
    expect(lifecycle.getAttachedWrapperInstanceId()).toBe(WRAPPER_INSTANCE_ID);
  });
});
