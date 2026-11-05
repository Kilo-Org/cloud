import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeCaptureResult } from '../../sandbox-containers/native-capture.js';
import { logControlDiagnostic } from '../../sandbox-control/diagnostics.js';
import { initialAllocationState, type AllocationState } from './allocation.js';
import type { RouteRecord } from './routes.js';
import {
  SESSION_SNAPSHOT_ALLOCATION_KEY,
  SESSION_SNAPSHOT_KEY,
  captureIdleSessionSnapshot,
  readSessionSnapshotAllocation,
  selectSessionSnapshot,
} from './session-snapshot.js';

vi.mock('../../sandbox-control/diagnostics.js', () => ({ logControlDiagnostic: vi.fn() }));

const diagnostic = vi.mocked(logControlDiagnostic);
const NOW = Date.now();
const IDENTITY = {
  sandboxId: 'sbx-1',
  sessionId: 'workspace_1',
  kiloSessionId: 'ses_1',
  userId: 'user-1',
};
const RUNTIME = JSON.stringify({ mode: 'preinstalled', image: 'all-in-one' });
const OTHER_RUNTIME = JSON.stringify({ mode: 'downloaded', image: 'runtime-free' });

class FakeKv {
  readonly values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  put(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

type Storage = Parameters<typeof selectSessionSnapshot>[0];
const storage = (kv: FakeKv): Storage => kv as unknown as Storage;

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    ...IDENTITY,
    sourceAllocationId: 'alloc-captured',
    snapshotId: 'snap-1',
    baseImage: 'image:1',
    runtimeIdentity: RUNTIME,
    capturedAt: 1,
    ...overrides,
  };
}

function allocation(overrides: Record<string, unknown> = {}) {
  return {
    allocationId: 'alloc-1',
    runtimeIdentity: RUNTIME,
    owner: IDENTITY,
    contaminated: false,
    invalidationGeneration: 0,
    idleConnectionId: 'conn-1',
    ...overrides,
  };
}

function route(overrides: Partial<RouteRecord> = {}): RouteRecord {
  return {
    sessionId: 'workspace_1',
    spec: {
      sessionId: 'workspace_1',
      kiloSessionId: 'ses_1',
      directory: '/workspace/app',
      attemptId: 'attempt-1',
    },
    grant: null,
    credentialSource: { userId: 'user-1', kiloSessionId: 'ses_1', kiloToken: 'token' },
    environment: null,
    state: 'ready',
    attemptId: 'attempt-1',
    attemptDeadlineAt: 0,
    reason: null,
    ...overrides,
  };
}

function connectedState(overrides: Partial<AllocationState> = {}): AllocationState {
  return {
    ...initialAllocationState(),
    kind: 'connected',
    allocationId: 'alloc-1',
    connectionId: 'conn-1',
    providerRef: 'ref-1',
    lastActivityAt: NOW - 120_000,
    ...overrides,
  };
}

const stored = (): NativeCaptureResult => ({
  status: 'stored',
  snapshotId: 'snap-captured',
  baseImage: 'image:captured',
  capturedAt: 1_000,
  durationMs: 5,
});

const failed = (
  reason: Extract<NativeCaptureResult, { status: 'failed' }>['reason']
): NativeCaptureResult => ({ status: 'failed', reason });

type CaptureOptions = {
  state?: AllocationState;
  readState?: () => AllocationState;
  routes?: RouteRecord[];
  capable?: boolean;
  capture?: (ref: string, captureId: string) => Promise<NativeCaptureResult>;
};

function captureInput(kv: FakeKv, options: CaptureOptions = {}) {
  const state = options.state ?? connectedState();
  const routes = options.routes ?? [route()];
  const capture = vi.fn(options.capture ?? (async () => stored()));
  const input: Parameters<typeof captureIdleSessionSnapshot>[0] = {
    storage: storage(kv),
    sandboxId: 'sbx-1',
    provider: { capture },
    idleMs: 60_000,
    read: async () => ({
      state: options.readState?.() ?? state,
      routes,
      capable: options.capable ?? true,
    }),
    enqueue: async operation => operation(),
    eligible: () => true,
  };
  return { input, capture };
}

const captureLogs = (phase: string) =>
  diagnostic.mock.calls
    .filter(([event, fields]) => event === 'session_snapshot_capture' && fields.phase === phase)
    .map(([, fields]) => fields);

const lookupLog = () =>
  diagnostic.mock.calls.find(([event]) => event === 'session_snapshot_lookup')?.[1];

beforeEach(() => {
  diagnostic.mockClear();
});

describe('selectSessionSnapshot diagnostics', () => {
  it('reports no_snapshot and writes nothing', () => {
    const kv = new FakeKv();
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME, true)).toBeNull();
    expect(lookupLog()).toMatchObject({
      reason: 'no_snapshot',
      sandboxId: 'sbx-1',
      sessionId: 'workspace_1',
    });
    expect(kv.values.size).toBe(0);
  });

  it('reports invalid_descriptor and leaves the stored value unchanged', () => {
    const kv = new FakeKv();
    const value = { sandboxId: 'sbx-1' };
    kv.put(SESSION_SNAPSHOT_KEY, value);
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME, true)).toBeNull();
    expect(lookupLog()).toMatchObject({ reason: 'invalid_descriptor' });
    expect(kv.values.get(SESSION_SNAPSHOT_KEY)).toBe(value);
  });

  it('reports identity_mismatch with both identities', () => {
    const kv = new FakeKv();
    const value = descriptor({ sessionId: 'workspace_2' });
    kv.put(SESSION_SNAPSHOT_KEY, value);
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME, true)).toBeNull();
    expect(lookupLog()).toMatchObject({
      reason: 'identity_mismatch',
      identityMatch: false,
      sandboxId: 'sbx-1',
      sessionId: 'workspace_1',
      capturedSessionId: 'workspace_2',
    });
    expect(kv.values.get(SESSION_SNAPSHOT_KEY)).toBe(value);
  });

  it('reports runtime_mismatch with both runtime summaries', () => {
    const kv = new FakeKv();
    const value = descriptor({ runtimeIdentity: OTHER_RUNTIME });
    kv.put(SESSION_SNAPSHOT_KEY, value);
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME, true)).toBeNull();
    expect(lookupLog()).toMatchObject({
      reason: 'runtime_mismatch',
      identityMatch: true,
      runtimeMatch: false,
      expectedMode: 'preinstalled',
      expectedImage: 'all-in-one',
      capturedMode: 'downloaded',
      capturedImage: 'runtime-free',
    });
  });

  it('reports selected and returns the descriptor unchanged', () => {
    const kv = new FakeKv();
    const value = descriptor();
    kv.put(SESSION_SNAPSHOT_KEY, value);
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME, true)).toEqual(value);
    expect(lookupLog()).toMatchObject({
      reason: 'selected',
      identityMatch: true,
      runtimeMatch: true,
      sourceAllocationId: 'alloc-captured',
    });
    expect(kv.values.get(SESSION_SNAPSHOT_KEY)).toBe(value);
  });

  it('does not report invalidation lookups as restore selections', () => {
    const kv = new FakeKv();
    const value = descriptor();
    kv.put(SESSION_SNAPSHOT_KEY, value);
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME)).toEqual(value);
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME)).toEqual(value);
    kv.delete(SESSION_SNAPSHOT_KEY);
    expect(selectSessionSnapshot(storage(kv), IDENTITY, RUNTIME)).toBeNull();
    expect(diagnostic).not.toHaveBeenCalled();
  });
});

describe('captureIdleSessionSnapshot diagnostics', () => {
  const skipCases: Array<{
    reason: string;
    disk?: Record<string, unknown>;
    options: CaptureOptions;
  }> = [
    { reason: 'not_connected', options: { state: connectedState({ kind: 'stopped' }) } },
    {
      reason: 'allocation_mismatch',
      options: { state: connectedState({ allocationId: 'alloc-other' }) },
    },
    { reason: 'not_idle', options: { state: connectedState({ lastActivityAt: NOW }) } },
    { reason: 'contaminated', disk: allocation({ contaminated: true }), options: {} },
    { reason: 'not_capable', options: { capable: false } },
    { reason: 'route_not_ready', options: { routes: [route({ state: 'preparing' })] } },
  ];

  it.each(skipCases)(
    'logs $reason when the idle attempt is rejected',
    async ({ reason, disk = allocation(), options }) => {
      const kv = new FakeKv();
      kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, disk);
      const { input, capture } = captureInput(kv, options);
      await captureIdleSessionSnapshot(input);
      expect(capture).not.toHaveBeenCalled();
      expect(captureLogs('skipped')).toEqual([expect.objectContaining({ reason })]);
      expect(
        diagnostic.mock.calls.find(
          ([event, fields]) => event === 'session_snapshot_capture' && fields.phase === 'skipped'
        )?.[3]
      ).toEqual({ coalesceIdentity: 'session_snapshot_skip:sbx-1' });
      expect(kv.values.has(SESSION_SNAPSHOT_KEY)).toBe(false);
      expect(kv.values.get(SESSION_SNAPSHOT_ALLOCATION_KEY)).toBe(disk);
    }
  );

  it('logs the provider failure, records the attempt, and attempts once per idle period', async () => {
    const kv = new FakeKv();
    kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, allocation());
    const { input, capture } = captureInput(kv, {
      capture: async () => failed('snapshot_failed'),
    });
    await captureIdleSessionSnapshot(input);
    await captureIdleSessionSnapshot(input);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(captureLogs('provider_result')).toEqual([
      expect.objectContaining({ status: 'failed', reason: 'snapshot_failed' }),
    ]);
    expect(captureLogs('skipped')).toEqual([
      expect.objectContaining({ reason: 'already_attempted' }),
    ]);
    expect(captureLogs('stored')).toEqual([]);
    expect(kv.values.has(SESSION_SNAPSHOT_KEY)).toBe(false);
    expect(readSessionSnapshotAllocation(storage(kv))?.attemptedIdleAt).toBe(NOW - 120_000);
  });

  it('logs stored only after the descriptor is persisted', async () => {
    const kv = new FakeKv();
    kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, allocation());
    const put = vi.spyOn(kv, 'put');
    const { input, capture } = captureInput(kv);
    await captureIdleSessionSnapshot(input);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(kv.values.get(SESSION_SNAPSHOT_KEY)).toMatchObject({
      ...IDENTITY,
      sourceAllocationId: 'alloc-1',
      snapshotId: 'snap-captured',
      baseImage: 'image:captured',
      runtimeIdentity: RUNTIME,
      capturedAt: 1_000,
    });
    expect(captureLogs('provider_result')).toEqual([expect.objectContaining({ status: 'stored' })]);
    expect(captureLogs('discarded')).toEqual([]);
    expect(captureLogs('stored')).toEqual([
      expect.objectContaining({ allocationId: 'alloc-1', sessionId: 'workspace_1' }),
    ]);
    const storedIndex = diagnostic.mock.calls.findIndex(
      ([event, fields]) => event === 'session_snapshot_capture' && fields.phase === 'stored'
    );
    const storedOrder = diagnostic.mock.invocationCallOrder[storedIndex];
    const descriptorPutIndex = put.mock.calls.findIndex(([key]) => key === SESSION_SNAPSHOT_KEY);
    expect(storedOrder).toBeGreaterThan(put.mock.invocationCallOrder[descriptorPutIndex]);
    const serialized = JSON.stringify(diagnostic.mock.calls);
    expect(serialized).not.toContain('snap-captured');
    expect(serialized).not.toContain('image:captured');
  });

  it('discards the captured descriptor when activity changes during capture', async () => {
    const kv = new FakeKv();
    kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, allocation());
    let state = connectedState();
    const initialActivity = state.lastActivityAt ?? 0;
    const { input } = captureInput(kv, {
      state,
      readState: () => state,
      capture: async () => {
        state = { ...state, lastActivityAt: initialActivity + 1 };
        return stored();
      },
    });
    await captureIdleSessionSnapshot(input);
    expect(kv.values.has(SESSION_SNAPSHOT_KEY)).toBe(false);
    expect(captureLogs('discarded')).toEqual([
      expect.objectContaining({
        reason: 'activity_changed',
        expectedActivityAt: initialActivity,
        currentActivityAt: initialActivity + 1,
      }),
    ]);
  });

  it('discards the captured descriptor when the invalidation generation changes', async () => {
    const kv = new FakeKv();
    kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, allocation());
    const { input } = captureInput(kv, {
      capture: async () => {
        const disk = readSessionSnapshotAllocation(storage(kv));
        if (disk === undefined) throw new Error('Missing snapshot allocation');
        kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, {
          ...disk,
          invalidationGeneration: disk.invalidationGeneration + 1,
        });
        return stored();
      },
    });
    await captureIdleSessionSnapshot(input);
    expect(kv.values.has(SESSION_SNAPSHOT_KEY)).toBe(false);
    expect(captureLogs('discarded')).toEqual([
      expect.objectContaining({
        reason: 'generation_changed',
        expectedGeneration: 0,
        currentGeneration: 1,
      }),
    ]);
  });
});
