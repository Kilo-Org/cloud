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

function metadata(
  options: { workspacePath?: string; worktreeId?: string; provider?: string } = {}
): SessionMetadata {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: SESSION_ID, userId: 'user_1', createdOnPlatform: 'cloud-agent-web' },
    auth: { kiloSessionId: 'kilo_session_1' },
    agent: { mode: 'code', model: 'test-model' },
    workspace: {
      sandboxId: SANDBOX_ID,
      sandboxProvider: options.provider ?? 'cloudflare-containers',
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
    expect(first.publishDigest).toBeDefined();

    const secondDeps = deps(containerFacts({ hasRecord: true }), {
      id: 'other_snap',
      expiresAt: Date.now() + 60_000,
    });
    const second = await resolve(metadata({ workspacePath: first.directory }), secondDeps);

    expect(second.directory).toBe(first.directory);
    expect(second.metadata.workspace?.workspacePath).toBe(first.directory);
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
