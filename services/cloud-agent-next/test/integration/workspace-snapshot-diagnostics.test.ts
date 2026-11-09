import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/logger.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  initialAllocationState,
  type AllocationState,
} from '../../src/control-plane/sandbox/allocation.js';
import type { RouteDatabase, RouteRecord } from '../../src/control-plane/sandbox/routes.js';
import { workspaceDiskSnapshots } from '../../src/control-plane/sandbox/sqlite-schema.js';
import {
  captureIdleWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  fenceWorkspaceSnapshot,
  readWorkspaceSnapshot,
  readWorkspaceSnapshotAllocation,
  selectWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_TTL_MS,
  workspaceSnapshotOwner,
  workspaceSnapshotRoutesEligible,
  workspaceSnapshotRestoreSkip,
  writeWorkspaceSnapshotAllocation,
} from '../../src/control-plane/sandbox/workspace-snapshot.js';
import type { NativeCaptureResult } from '../../src/sandbox-containers/native-capture.js';

const IDENTITY = {
  sandboxId: `sbx-${'d'.repeat(48)}`,
  workspaceId: 'worktree_00000000-0000-4000-8000-000000000001' as const,
  directory: '/workspace/app',
  userId: 'user-1',
};
const RUNTIME = JSON.stringify({ mode: 'preinstalled', image: 'all-in-one' });
const OTHER_RUNTIME = JSON.stringify({ mode: 'downloaded', image: 'runtime-free' });
const descriptor = (overrides: Record<string, unknown> = {}) => ({
  ...IDENTITY,
  sourceAllocationId: 'alloc-source',
  snapshotId: 'private-handle',
  baseImage: 'image:1',
  runtimeIdentity: RUNTIME,
  capturedAt: Date.now(),
  ...overrides,
});
const disk = () => ({
  allocationId: 'alloc-1',
  runtimeIdentity: RUNTIME,
  owner: IDENTITY,
  invalidationGeneration: 0,
  idleConnectionId: 'conn-1',
});
const connected = (): AllocationState => ({
  ...initialAllocationState(),
  kind: 'connected',
  allocationId: 'alloc-1',
  connectionId: 'conn-1',
  providerRef: 'ref-1',
  lastActivityAt: Date.now() - 120_000,
});
const route = (): RouteRecord => ({
  sessionId: 'workspace-1',
  spec: {
    sessionId: 'workspace-1',
    kiloSessionId: 'ses-1',
    directory: IDENTITY.directory,
    attemptId: 'attempt-1',
  },
  grant: null,
  credentialSource: {
    userId: IDENTITY.userId,
    kiloSessionId: 'ses-1',
    kiloToken: 'not-a-real-token',
    workspaceId: IDENTITY.workspaceId,
    scopeId: IDENTITY.workspaceId,
  },
  environment: null,
  state: 'ready',
  attemptId: 'attempt-1',
  attemptDeadlineAt: 0,
  reason: null,
});
const stored = (): NativeCaptureResult => ({
  status: 'stored',
  snapshotId: 'captured-private-handle',
  baseImage: 'image:1',
  capturedAt: 1_000,
  durationMs: 5,
});

async function withDatabase(operation: (db: RouteDatabase) => Promise<void> | void) {
  const namespace = (
    env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> }
  ).SANDBOX_CONTROL;
  await runInDurableObject(
    namespace.getByName(`sbx-${crypto.randomUUID().replaceAll('-', '')}${'d'.repeat(16)}`),
    async instance => {
      await instance.getAllocationState();
      await operation(instance['db']);
    }
  );
}

function saveDescriptor(db: RouteDatabase, data: unknown) {
  db.insert(workspaceDiskSnapshots)
    .values({ workspace_id: IDENTITY.workspaceId, data })
    .onConflictDoUpdate({ target: workspaceDiskSnapshots.workspace_id, set: { data } })
    .run();
}

function captureInput(db: RouteDatabase) {
  let state = connected();
  let routes = [route()];
  let capable = true;
  const capture = vi.fn(async (): Promise<NativeCaptureResult> => stored());
  const input: Parameters<typeof captureIdleWorkspaceSnapshot>[0] = {
    db,
    sandboxId: IDENTITY.sandboxId,
    provider: { capture, currentImage: async () => 'image:1' },
    idleMs: 60_000,
    read: async () => ({ state, routes, capable }),
    enqueue: async operation => operation(),
    eligible: () => true,
  };
  return {
    input,
    capture,
    state: () => state,
    setState: (value: AllocationState) => {
      state = value;
    },
    setRoutes: (value: RouteRecord[]) => {
      routes = value;
    },
    setCapable: (value: boolean) => {
      capable = value;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
  await reset();
});

describe('workspace snapshot diagnostics with durable SQLite', () => {
  it.each([
    { change: undefined, reason: 'missing' },
    { change: { sandboxId: IDENTITY.sandboxId }, reason: 'invalid_descriptor' },
    { change: descriptor({ directory: '/workspace/another' }), reason: 'ownership_mismatch' },
    { change: descriptor({ runtimeIdentity: OTHER_RUNTIME }), reason: 'runtime_mismatch' },
    {
      change: descriptor({ capturedAt: Date.now() - WORKSPACE_SNAPSHOT_TTL_MS - 1 }),
      reason: 'expired',
    },
    { change: descriptor({ baseImage: 'old-image' }), reason: 'image_mismatch' },
    { change: descriptor(), reason: 'selected' },
  ])('reports $reason without changing the descriptor', async ({ change, reason }) =>
    withDatabase(db => {
      if (change !== undefined) saveDescriptor(db, change);
      const before = db.select().from(workspaceDiskSnapshots).all();
      const fields = vi.spyOn(logger, 'withFields');
      const selected = selectWorkspaceSnapshot(
        db,
        IDENTITY,
        RUNTIME,
        'image:1',
        'workspace-requester'
      );
      expect(selected !== null).toBe(reason === 'selected');
      expect(db.select().from(workspaceDiskSnapshots).all()).toEqual(before);
      const lookup = fields.mock.calls
        .map(([value]) => value)
        .find(value => value.diagnosticEvent === 'workspace_snapshot_selection');
      expect(lookup).toMatchObject({
        reason,
        sandboxId: IDENTITY.sandboxId,
        workspaceId: IDENTITY.workspaceId,
        sessionId: 'workspace-requester',
      });
      if (reason === 'runtime_mismatch')
        expect(lookup).toMatchObject({
          expectedMode: 'preinstalled',
          capturedMode: 'downloaded',
          expectedImage: 'all-in-one',
          capturedImage: 'runtime-free',
        });
      expect(JSON.stringify(fields.mock.calls)).not.toContain('private-handle');
    })
  );

  it('fences a generation without deleting the descriptor or its payload', () =>
    withDatabase(db => {
      writeWorkspaceSnapshotAllocation(db, disk());
      saveDescriptor(db, descriptor());
      const before = readWorkspaceSnapshot(db, IDENTITY.workspaceId);
      const fields = vi.spyOn(logger, 'withFields');
      fenceWorkspaceSnapshot(db, 'prompt', 'workspace-1');
      expect(readWorkspaceSnapshot(db, IDENTITY.workspaceId)).toEqual(before);
      const fenced = readWorkspaceSnapshotAllocation(db);
      expect(fenced?.invalidationGeneration).toBe(1);
      expect(fenced?.idleConnectionId).toBeUndefined();
      expect(fields.mock.calls.map(([value]) => value)).toContainEqual(
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_fenced',
          reason: 'prompt',
          previousGeneration: 0,
          generation: 1,
        })
      );
      expect(JSON.stringify(fields.mock.calls)).not.toContain('private-handle');
    }));

  it.each([
    'not_connected',
    'allocation_mismatch',
    'not_idle',
    'not_capable',
    'no_routes',
    'route_not_ready',
  ])('reports the actual %s capture gate', async reason =>
    withDatabase(async db => {
      writeWorkspaceSnapshotAllocation(db, disk());
      const test = captureInput(db);
      if (reason === 'not_connected') test.setState({ ...test.state(), kind: 'stopped' });
      if (reason === 'allocation_mismatch')
        test.setState({ ...test.state(), allocationId: 'other' });
      if (reason === 'not_idle') test.setState({ ...test.state(), lastActivityAt: Date.now() });
      if (reason === 'not_capable') test.setCapable(false);
      if (reason === 'no_routes') test.setRoutes([]);
      if (reason === 'route_not_ready') test.setRoutes([{ ...route(), state: 'preparing' }]);
      const fields = vi.spyOn(logger, 'withFields');
      await captureIdleWorkspaceSnapshot(test.input);
      expect(test.capture).not.toHaveBeenCalled();
      expect(fields.mock.calls.map(([value]) => value)).toContainEqual(
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_capture',
          phase: 'skipped',
          reason,
        })
      );
      expect(readWorkspaceSnapshot(db, IDENTITY.workspaceId)).toBeNull();
    })
  );

  it('reports provider failure and records one attempt per idle period', async () =>
    withDatabase(async db => {
      writeWorkspaceSnapshotAllocation(db, disk());
      const test = captureInput(db);
      test.capture.mockImplementation(async () => ({
        status: 'failed',
        reason: 'snapshot_failed',
      }));
      const fields = vi.spyOn(logger, 'withFields');
      await captureIdleWorkspaceSnapshot(test.input);
      await captureIdleWorkspaceSnapshot(test.input);
      expect(test.capture).toHaveBeenCalledTimes(1);
      expect(readWorkspaceSnapshotAllocation(db)?.attemptedIdleAt).toBe(
        test.state().lastActivityAt
      );
      expect(fields.mock.calls.map(([value]) => value)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            diagnosticEvent: 'workspace_snapshot_capture',
            phase: 'provider_result',
            status: 'failed',
            reason: 'snapshot_failed',
          }),
          expect.objectContaining({
            diagnosticEvent: 'workspace_snapshot_capture',
            phase: 'skipped',
            reason: 'already_attempted',
          }),
        ])
      );
      expect(readWorkspaceSnapshot(db, IDENTITY.workspaceId)).toBeNull();
    }));

  it('reports publication only after the descriptor is durable and never logs handles', async () =>
    withDatabase(async db => {
      writeWorkspaceSnapshotAllocation(db, disk());
      const test = captureInput(db);
      const withFields = logger.withFields.bind(logger);
      let published = false;
      vi.spyOn(logger, 'withFields').mockImplementation(fields => {
        if (fields.diagnosticEvent === 'workspace_snapshot_captured') {
          published = true;
          expect(readWorkspaceSnapshot(db, IDENTITY.workspaceId)?.snapshotId).toBe(
            'captured-private-handle'
          );
        }
        return withFields(fields);
      });
      await captureIdleWorkspaceSnapshot(test.input);
      expect(published).toBe(true);
      const log = vi.mocked(logger.withFields);
      expect(JSON.stringify(log.mock.calls)).not.toContain('captured-private-handle');
      log.mockClear();
      deleteWorkspaceSnapshot(db, IDENTITY.workspaceId, 'release');
      expect(
        log.mock.calls.some(([value]) => value.diagnosticEvent === 'workspace_snapshot_selection')
      ).toBe(false);
    }));

  it.each(['activity', 'generation'] as const)(
    'reports both sides of a changed %s fence',
    async mutation =>
      withDatabase(async db => {
        writeWorkspaceSnapshotAllocation(db, disk());
        const test = captureInput(db);
        const previousActivity = test.state().lastActivityAt;
        test.capture.mockImplementation(async () => {
          if (mutation === 'activity')
            test.setState({ ...test.state(), lastActivityAt: (previousActivity ?? 0) + 1 });
          else writeWorkspaceSnapshotAllocation(db, { ...disk(), invalidationGeneration: 1 });
          return stored();
        });
        const fields = vi.spyOn(logger, 'withFields');
        await captureIdleWorkspaceSnapshot(test.input);
        expect(readWorkspaceSnapshot(db, IDENTITY.workspaceId)).toBeNull();
        expect(fields.mock.calls.map(([value]) => value)).toContainEqual(
          expect.objectContaining({
            diagnosticEvent: 'workspace_snapshot_capture_skipped',
            reason: mutation === 'activity' ? 'activity_changed' : 'workspace_mutated',
            expectedActivityAt: previousActivity,
            currentActivityAt:
              mutation === 'activity' ? (previousActivity ?? 0) + 1 : previousActivity,
            expectedGeneration: 0,
            currentGeneration: mutation === 'generation' ? 1 : 0,
          })
        );
      })
  );

  it('still captures when a failed sibling route row persists', async () =>
    withDatabase(async db => {
      writeWorkspaceSnapshotAllocation(db, disk());
      const test = captureInput(db);
      test.setRoutes([{ ...route(), sessionId: 'workspace-0', state: 'failed' }, route()]);
      await captureIdleWorkspaceSnapshot(test.input);
      expect(test.capture).toHaveBeenCalledTimes(1);
      expect(readWorkspaceSnapshot(db, IDENTITY.workspaceId)?.snapshotId).toBe(
        'captured-private-handle'
      );
    }));

  it('selects the owner from live routes and restores past a failed sibling', async () =>
    withDatabase(db => {
      saveDescriptor(db, descriptor());
      const failed = { ...route(), sessionId: 'workspace-0', state: 'failed' } as const;
      const preparing = { ...route(), sessionId: 'workspace-2', state: 'preparing' } as const;
      const routes = [failed, preparing] as RouteRecord[];
      const eligible = () => true;
      expect(workspaceSnapshotOwner(IDENTITY.sandboxId, routes)).toEqual(IDENTITY);
      expect(workspaceSnapshotRestoreSkip(db, IDENTITY, routes, eligible)).toBeUndefined();
      expect(workspaceSnapshotRestoreSkip(db, IDENTITY, [failed], eligible)).toBe('no_routes');
    }));

  it('does not let an ineligible failed sibling fail the restore eligibility gate', async () =>
    withDatabase(db => {
      saveDescriptor(db, descriptor());
      const failed = {
        ...route(),
        sessionId: 'workspace-0',
        state: 'failed',
        credentialSource: null,
      } as const;
      const preparing = { ...route(), sessionId: 'workspace-2', state: 'preparing' } as const;
      const routes = [failed, preparing] as RouteRecord[];
      const eligible = (candidate: RouteRecord) => candidate.credentialSource !== null;
      expect(workspaceSnapshotRoutesEligible(routes, eligible)).toBe(true);
      expect(
        workspaceSnapshotRoutesEligible(
          [failed, { ...preparing, credentialSource: null }],
          eligible
        )
      ).toBe(false);
      expect(workspaceSnapshotOwner(IDENTITY.sandboxId, routes)).toEqual(IDENTITY);
      expect(workspaceSnapshotRestoreSkip(db, IDENTITY, routes, eligible)).toBeUndefined();
    }));
});
