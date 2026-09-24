import { afterEach, describe, expect, it, vi } from 'vitest';

const { DurableObjectMock } = vi.hoisted(() => ({
  DurableObjectMock: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('cloudflare:workers', () => ({ DurableObject: DurableObjectMock }));
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));

import {
  CONTROL_WRAPPER_LOG_PATH,
  CONTROL_WRAPPER_PATH,
} from '../sandbox-control/container-paths.js';
import {
  ContainersAllocationConflictError,
  SandboxContainers,
  type ContainerInstanceSize,
  type ContainersObservation,
} from './SandboxContainers.js';
import type { Env } from '../types.js';

// The fake proves coordinator ordering only. It does not prove that the platform snapshot survives
// destroy(), that a restored filesystem contains user files, or that exec behaves as assumed.
const RECORD_KEY = 'containers:record:v1';
const REF_A = 'ref-a';
const REF_B = 'ref-b';

type StoredRecord = {
  state: 'idle' | 'launching' | 'running' | 'stopping';
  allocationRef: string | null;
  stopOpId: string | null;
  lastSnapshot: { id: string; sourceAllocation: string } | null;
  snapshotOutcome?: 'ready' | 'failed' | 'skipped';
  warmRestorePending?: true;
  instance?: ContainerInstanceSize;
  billingConfigured?: true;
};

const idleRecord: StoredRecord = {
  state: 'idle',
  allocationRef: null,
  stopOpId: null,
  lastSnapshot: null,
};

type ExecBehavior = {
  exitCode?: number;
  exitError?: Error;
  stdout?: string;
  stderr?: string;
  outputError?: Error;
};

function makeExecProcess(behavior: ExecBehavior = {}): ExecProcess {
  const exitCode = behavior.exitError
    ? Promise.resolve().then((): number => {
        throw behavior.exitError;
      })
    : Promise.resolve(behavior.exitCode ?? 0);
  return {
    exitCode,
    output: async () => {
      if (behavior.outputError) throw behavior.outputError;
      return {
        stdout: new TextEncoder().encode(behavior.stdout ?? '').buffer,
        stderr: new TextEncoder().encode(behavior.stderr ?? '').buffer,
        exitCode: behavior.exitCode ?? 0,
      };
    },
  } as unknown as ExecProcess;
}

type StartBehavior = 'ok' | 'reject' | 'effect-then-reject';
type DestroyBehavior = 'ok' | 'reject' | 'deferred' | 'hang';
type SnapshotBehavior = { kind: 'resolve'; id: string } | { kind: 'reject' } | { kind: 'deferred' };

type DeferredSnapshot = { resolve: (id: string) => void; reject: (error: Error) => void };

class FakeContainer {
  running = false;
  images: Record<string, string> = { app: 'registry.example/kilo/app:test' };
  startCalls: ContainerStartupOptions[] = [];
  execCalls: { cmd: string[]; options?: ContainerExecOptions }[] = [];
  snapshotCalls = 0;
  destroyCalls = 0;
  monitorCalls = 0;
  leaseCalls: number[] = [];
  runningAtDestroy: boolean[] = [];

  startBehavior: StartBehavior = 'ok';
  destroyBehavior: DestroyBehavior = 'ok';
  snapshotBehavior: SnapshotBehavior = { kind: 'resolve', id: 'snap-1' };
  deferredSnapshots: DeferredSnapshot[] = [];
  deferredDestroy: { resolve: () => void; reject: (error: Error) => void } | null = null;
  execHandler: (cmd: string[]) => ExecProcess = () => makeExecProcess({ exitCode: 0 });

  start(options?: ContainerStartupOptions): void {
    this.startCalls.push(options as ContainerStartupOptions);
    if (this.startBehavior === 'reject') throw new Error('container start failed');
    this.running = true;
    if (this.startBehavior === 'effect-then-reject') {
      throw new Error('container start failed after taking effect');
    }
  }

  async exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    this.execCalls.push({ cmd, options });
    return this.execHandler(cmd);
  }

  async snapshotContainer(_options: ContainerSnapshotOptions): Promise<ContainerSnapshot> {
    this.snapshotCalls += 1;
    if (this.snapshotBehavior.kind === 'reject') throw new Error('container snapshot failed');
    if (this.snapshotBehavior.kind === 'deferred') {
      return await new Promise<ContainerSnapshot>((resolve, reject) => {
        this.deferredSnapshots.push({
          resolve: id => resolve({ id, size: 1 }),
          reject,
        });
      });
    }
    return { id: this.snapshotBehavior.id, size: 1 };
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.runningAtDestroy.push(this.running);
    if (this.destroyBehavior === 'reject') throw new Error('container destroy failed');
    if (this.destroyBehavior === 'deferred') {
      await new Promise<void>((resolve, reject) => {
        this.deferredDestroy = { resolve, reject };
      });
    }
    if (this.destroyBehavior === 'hang') {
      await new Promise<void>(() => {});
    }
    this.running = false;
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.leaseCalls.push(Number(ms));
  }

  async monitor(): Promise<void> {
    this.monitorCalls += 1;
  }
}

function setup(
  options: { record?: StoredRecord | null; attachContainer?: boolean; env?: Env } = {}
) {
  const container = new FakeContainer();
  let alarm: number | undefined;
  const pendingTasks: Promise<unknown>[] = [];
  const storage = {
    map: new Map<string, unknown>(),
    async get<T>(key: string): Promise<T | undefined> {
      return storage.map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      storage.map.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return storage.map.delete(key);
    },
    async setAlarm(scheduledTime: number): Promise<void> {
      alarm = scheduledTime;
    },
    async getAlarm(): Promise<number | null> {
      return alarm ?? null;
    },
    async deleteAlarm(): Promise<void> {
      alarm = undefined;
    },
  };
  if (options.record !== null) storage.map.set(RECORD_KEY, options.record ?? idleRecord);
  const ctx = {
    storage,
    id: { toString: () => 'do-id' },
    container: options.attachContainer === false ? undefined : container,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    waitUntil: (promise: Promise<unknown>) => {
      pendingTasks.push(promise);
    },
  } as unknown as DurableObjectState;
  const instance = new SandboxContainers(ctx, options.env ?? ({} as Env));
  const readRecord = () => storage.map.get(RECORD_KEY) as StoredRecord;
  return { storage, container, instance, readRecord, pendingTasks, getAlarm: () => alarm };
}

function launch(
  instance: SandboxContainers,
  allocationRef: string,
  env: Record<string, string> = {},
  warmSnapshotId?: string
) {
  return instance.launchWrapper({
    allocationRef,
    env,
    instance: 'standard-2',
    ...(warmSnapshotId === undefined ? {} : { warmSnapshotId }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SandboxContainers launch', () => {
  it('starts once with the image, execs the wrapper, persists running, and no-ops a same-ref repeat', async () => {
    const { instance, container, readRecord } = setup();

    const result = await launch(instance, REF_A, { FOO: 'bar' });

    expect(result).toEqual({ started: true });
    expect(container.startCalls).toEqual([
      { image: 'registry.example/kilo/app:test', instance: 'standard-2', enableInternet: true },
    ]);
    expect(container.execCalls).toEqual([
      { cmd: ['bun', 'run', CONTROL_WRAPPER_PATH], options: { env: { FOO: 'bar' }, cwd: '/' } },
    ]);
    expect(container.monitorCalls).toBe(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });

    const again = await launch(instance, REF_A, { FOO: 'bar' });

    expect(again).toEqual({ started: false });
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls).toHaveLength(1);
  });

  it('restores a stored snapshot with containerSnapshot and never passes image', async () => {
    const { instance, container } = setup({
      record: {
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: { id: 'snap-stored', sourceAllocation: REF_A },
      },
    });

    await instance.launchWrapper({ allocationRef: REF_B, env: {}, instance: 'lite' });

    const options = container.startCalls[0] as Record<string, unknown>;
    expect(options).toEqual({
      containerSnapshot: { id: 'snap-stored' },
      instance: 'lite',
      enableInternet: true,
    });
    expect('image' in options).toBe(false);
  });

  it('leaves launching when the wrapper exec fails, then adopts via pgrep or re-execs once', async () => {
    const failed = setup();
    failed.container.execHandler = () => {
      throw new Error('spawn failed');
    };
    await expect(launch(failed.instance, REF_A)).rejects.toThrow('spawn failed');
    expect(failed.readRecord()).toMatchObject({ state: 'launching', allocationRef: REF_A });

    const adopts = setup({ record: { ...idleRecord, state: 'launching', allocationRef: REF_A } });
    adopts.container.execHandler = () => makeExecProcess({ exitCode: 0 });
    const adopted = await launch(adopts.instance, REF_A);
    expect(adopted).toEqual({ started: true });
    expect(adopts.readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(adopts.container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep']);

    const reexecs = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    reexecs.container.execHandler = cmd =>
      makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    const reexecuted = await launch(reexecs.instance, REF_A);
    expect(reexecuted).toEqual({ started: true });
    expect(reexecs.readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(reexecs.container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep', 'bun']);
  });

  it('applies the requested instance when resuming a launch whose start never took effect', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });

    const resumed = await instance.launchWrapper({
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
    });

    expect(resumed).toEqual({ started: true });
    expect(container.startCalls).toEqual([
      { image: 'registry.example/kilo/app:test', instance: 'standard-3', enableInternet: true },
    ]);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep', 'bun']);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('repairs a stopping record that lacks a stop op id before snapshotting', async () => {
    const { instance, readRecord } = setup({
      record: { ...idleRecord, state: 'stopping', allocationRef: REF_A, stopOpId: null },
    });

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(readRecord()).toMatchObject({
      state: 'idle',
      lastSnapshot: { id: 'snap-1', sourceAllocation: REF_A },
    });
  });

  it('leaves launching and throws when the probe exits with an unexpected code, never re-execing', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 2 : 0 });

    await expect(launch(instance, REF_A)).rejects.toThrow();

    expect(readRecord()).toMatchObject({ state: 'launching', allocationRef: REF_A });
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep']);
  });

  it('treats a probe that never resolves as ambiguous and leaves launching', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    container.execHandler = () => new Promise<never>(() => {}) as unknown as ExecProcess;

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toBe('rejected');
    expect(readRecord()).toMatchObject({ state: 'launching', allocationRef: REF_A });
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep']);
  });

  it('retains ownership when start takes effect then throws, then stops the live container and relaunches', async () => {
    const { instance, container, readRecord } = setup();
    container.startBehavior = 'effect-then-reject';

    await expect(launch(instance, REF_A)).rejects.toThrow(
      'container start failed after taking effect'
    );

    expect(container.running).toBe(true);
    expect(readRecord()).toMatchObject({ state: 'launching', allocationRef: REF_A });

    const stopResult = await instance.stop(REF_A);

    expect(stopResult).toBe('terminal');
    expect(container.runningAtDestroy).toEqual([true]);
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null });

    container.startBehavior = 'ok';
    await launch(instance, REF_B);

    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_B });
    expect(container.startCalls).toHaveLength(2);
  });

  it('serialises concurrent launches so one allocation wins without executing the loser', async () => {
    const { instance, container, readRecord } = setup();

    const results = await Promise.allSettled([launch(instance, REF_A), launch(instance, REF_B)]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ContainersAllocationConflictError);
    expect((rejected[0].reason as ContainersAllocationConflictError).code).toBe(
      'allocation_conflict'
    );
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls).toHaveLength(1);
    expect([REF_A, REF_B]).toContain(readRecord().allocationRef);
  });
});

describe('SandboxContainers observe', () => {
  it('reports the raw observation for every state and ownership combination without starting', async () => {
    const combos: { record: StoredRecord; running: boolean; attachContainer?: boolean }[] = [
      { record: { ...idleRecord }, running: false, attachContainer: false },
      { record: { ...idleRecord }, running: true },
      { record: { ...idleRecord, state: 'launching', allocationRef: REF_A }, running: true },
      { record: { ...idleRecord, state: 'running', allocationRef: REF_A }, running: true },
      {
        record: { ...idleRecord, state: 'stopping', allocationRef: REF_A, stopOpId: 'op-1' },
        running: true,
      },
      { record: { ...idleRecord, state: 'launching', allocationRef: REF_A }, running: false },
      { record: { ...idleRecord, state: 'running', allocationRef: REF_B }, running: true },
    ];

    for (const combo of combos) {
      const { instance, container } = setup({
        record: combo.record,
        attachContainer: combo.attachContainer,
      });
      container.running = combo.running;

      const observed: ContainersObservation = await instance.observe(REF_A);

      expect(observed).toEqual({
        running: combo.running,
        state: combo.record.state,
        currentAllocationRef: combo.record.allocationRef,
      });
      expect(container.startCalls).toHaveLength(0);
      expect(container.execCalls).toHaveLength(0);
      expect(container.destroyCalls).toBe(0);
    }
  });
});

describe('SandboxContainers stop', () => {
  it('serialises duplicate stops while the snapshot resolves, destroying once after confirmation', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'deferred' };

    let first: 'terminal' | 'retryable' | undefined;
    let second: 'terminal' | 'retryable' | undefined;
    const firstStop = instance.stop(REF_A).then(result => {
      first = result;
    });
    const secondStop = instance.stop(REF_A).then(result => {
      second = result;
    });

    await vi.waitFor(() => expect(container.snapshotCalls).toBe(1));
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(container.destroyCalls).toBe(0);

    container.deferredSnapshots[0]?.resolve('snap-1');
    await Promise.all([firstStop, secondStop]);

    expect(first).toBe('terminal');
    expect(second).toBe('terminal');
    expect(container.snapshotCalls).toBe(1);
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null, stopOpId: null });
  });

  it('retains ownership when destroy fails, then a retried stop resumes the persisted op and destroys', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.destroyBehavior = 'reject';

    const first = await instance.stop(REF_A);

    expect(first).toBe('retryable');
    const persistedOpId = readRecord().stopOpId;
    expect(persistedOpId).toEqual(expect.any(String));
    expect(readRecord()).toMatchObject({ state: 'stopping', allocationRef: REF_A });
    expect(container.running).toBe(true);

    container.snapshotBehavior = { kind: 'deferred' };
    container.destroyBehavior = 'ok';
    let second: 'terminal' | 'retryable' | undefined;
    const secondStop = instance.stop(REF_A).then(result => {
      second = result;
    });

    await vi.waitFor(() => expect(container.snapshotCalls).toBe(2));
    expect(second).toBeUndefined();
    expect(readRecord().stopOpId).toBe(persistedOpId);

    container.deferredSnapshots[0]?.resolve('snap-2');
    await secondStop;

    expect(second).toBe('terminal');
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'snap-2', sourceAllocation: REF_A },
      snapshotOutcome: 'ready',
    });
  });

  it('does not publish a snapshot that resolves after the allocation was replaced', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'deferred' };

    const stopPromise = instance.stop(REF_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.snapshotCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(11_000);
    await expect(stopPromise).resolves.toBe('terminal');
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null, lastSnapshot: null });

    await launch(instance, REF_B);
    expect(readRecord()).toMatchObject({
      state: 'running',
      allocationRef: REF_B,
      lastSnapshot: null,
    });

    container.deferredSnapshots[0]?.resolve('late-snap');
    await vi.advanceTimersByTimeAsync(0);

    expect(readRecord().lastSnapshot).toBeNull();
  });

  it('does not let a timed-out stop publish after a later stop owns the record (no ABA)', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'deferred' };

    const firstStop = instance.stop(REF_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.snapshotCalls).toBe(1);
    const firstOpId = readRecord().stopOpId;

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(firstStop).resolves.toBe('terminal');
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null, lastSnapshot: null });
    expect(container.deferredSnapshots).toHaveLength(1);

    await launch(instance, REF_A);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });

    const secondStop = instance.stop(REF_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.snapshotCalls).toBe(2);
    const secondOpId = readRecord().stopOpId;
    expect(secondOpId).toEqual(expect.any(String));
    expect(secondOpId).not.toBe(firstOpId);

    container.deferredSnapshots[0]?.resolve('late-op1');
    await vi.advanceTimersByTimeAsync(0);
    expect(readRecord()).toEqual({
      state: 'stopping',
      allocationRef: REF_A,
      stopOpId: secondOpId,
      lastSnapshot: null,
      snapshotOutcome: 'failed',
      instance: 'standard-2',
    });

    container.deferredSnapshots[1]?.resolve('op2');
    await secondStop;
    await vi.advanceTimersByTimeAsync(0);

    expect(readRecord()).toMatchObject({
      lastSnapshot: { id: 'op2', sourceAllocation: REF_A },
      snapshotOutcome: 'ready',
    });
  });

  it('defers a late snapshot behind a pending destroy so it cannot publish during cleanup', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'deferred' };
    container.destroyBehavior = 'deferred';

    let settled: 'terminal' | 'retryable' | undefined;
    const stopPromise = instance.stop(REF_A).then(result => {
      settled = result;
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(container.snapshotCalls).toBe(1);
    const opId = readRecord().stopOpId;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(container.destroyCalls).toBe(1);
    expect(container.deferredDestroy).not.toBeNull();
    expect(settled).toBeUndefined();

    container.deferredSnapshots[0]?.resolve('late-snap');
    await vi.advanceTimersByTimeAsync(0);

    expect(readRecord()).toEqual({
      state: 'stopping',
      allocationRef: REF_A,
      stopOpId: opId,
      lastSnapshot: null,
      snapshotOutcome: 'failed',
    });

    container.deferredDestroy?.resolve();
    await stopPromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe('terminal');
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: null,
      snapshotOutcome: 'failed',
    });
  });

  it('returns retryable and keeps the live stop op when destroy never acknowledges', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.destroyBehavior = 'hang';

    let settled: 'terminal' | 'retryable' | undefined;
    const stopPromise = instance.stop(REF_A).then(result => {
      settled = result;
      return result;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(container.destroyCalls).toBe(1);
    const opId = readRecord().stopOpId;
    expect(opId).toEqual(expect.any(String));
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(stopPromise).resolves.toBe('retryable');
    expect(settled).toBe('retryable');
    expect(readRecord()).toEqual({
      state: 'stopping',
      allocationRef: REF_A,
      stopOpId: opId,
      lastSnapshot: { id: 'snap-1', sourceAllocation: REF_A },
      snapshotOutcome: 'ready',
    });
  });

  it('returns retryable for a stale stop while another allocation is stopping, then terminal after its destroy confirms', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'stopping', allocationRef: REF_A, stopOpId: 'op-a' },
    });
    container.running = true;

    await expect(instance.stop(REF_B)).resolves.toBe('retryable');
    expect(container.destroyCalls).toBe(0);
    expect(readRecord()).toMatchObject({ state: 'stopping', allocationRef: REF_A });

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null });

    await expect(instance.stop(REF_B)).resolves.toBe('terminal');
    expect(container.destroyCalls).toBe(1);
  });

  it('serialises duplicate stops while destroy is delayed, converging on one destroy', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.destroyBehavior = 'deferred';

    let first: 'terminal' | 'retryable' | undefined;
    let second: 'terminal' | 'retryable' | undefined;
    const firstStop = instance.stop(REF_A).then(result => {
      first = result;
    });
    const secondStop = instance.stop(REF_A).then(result => {
      second = result;
    });

    await vi.waitFor(() => expect(container.destroyCalls).toBe(1));
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(readRecord()).toMatchObject({ state: 'stopping', allocationRef: REF_A });
    expect(readRecord().stopOpId).toEqual(expect.any(String));

    container.deferredDestroy?.resolve();
    await Promise.all([firstStop, secondStop]);

    expect(first).toBe('terminal');
    expect(second).toBe('terminal');
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'snap-1', sourceAllocation: REF_A },
      snapshotOutcome: 'ready',
    });
  });

  it('records a failed capture, keeps the previous session snapshot, and reaches terminal', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        lastSnapshot: { id: 'prev-snap', sourceAllocation: REF_A },
      },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'reject' };

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'prev-snap', sourceAllocation: REF_A },
      snapshotOutcome: 'failed',
    });
  });

  it('records a timed-out capture as failed without leaving the record stopping', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        lastSnapshot: { id: 'prev-snap', sourceAllocation: REF_A },
      },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'deferred' };

    const stopPromise = instance.stop(REF_A);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(stopPromise).resolves.toBe('terminal');
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'prev-snap', sourceAllocation: REF_A },
      snapshotOutcome: 'failed',
    });
  });

  it('stores the captured snapshot and a ready outcome on the terminal record', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'resolve', id: 'snap-ready' };

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'snap-ready', sourceAllocation: REF_A },
      snapshotOutcome: 'ready',
    });
  });

  it('logs an outcome-write failure and still reaches terminal', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { instance, container, readRecord, storage } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    const put = storage.put.bind(storage);
    storage.put = async (key, value) => {
      if (
        key === RECORD_KEY &&
        typeof value === 'object' &&
        value !== null &&
        'snapshotOutcome' in value
      ) {
        throw new Error('outcome write failed');
      }
      return put(key, value);
    };

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: null,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Sandbox control diagnostic',
        level: 'warn',
        diagnosticEvent: 'session_snapshot',
        result: 'ready',
      })
    );
    log.mockRestore();
  });

  it('preserves a recorded outcome when a stopping record re-enters terminal without a container', async () => {
    const { instance, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'stopping',
        allocationRef: REF_A,
        stopOpId: 'op-1',
        lastSnapshot: { id: 'prev-snap', sourceAllocation: REF_A },
        snapshotOutcome: 'failed',
      },
      attachContainer: false,
    });

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'prev-snap', sourceAllocation: REF_A },
      snapshotOutcome: 'failed',
    });
  });

  it('does not write a late snapshot after the stop attempt has settled', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'deferred' };
    container.destroyBehavior = 'reject';

    const stopPromise = instance.stop(REF_A);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stopPromise).resolves.toBe('retryable');

    const settledRecord = structuredClone(readRecord());
    expect(settledRecord).toMatchObject({
      state: 'stopping',
      allocationRef: REF_A,
      lastSnapshot: null,
      snapshotOutcome: 'failed',
    });

    container.deferredSnapshots[0]?.resolve('late-snap');
    await vi.advanceTimersByTimeAsync(0);

    expect(readRecord()).toEqual(settledRecord);
    expect(readRecord().lastSnapshot).toBeNull();
  });

  it('skips capture while a warm restore is pending and records skipped', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        lastSnapshot: { id: 'trusted', sourceAllocation: REF_A },
        warmRestorePending: true,
      },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'resolve', id: 'new-snap' };
    const originalDestroy = container.destroy.bind(container);
    let recordAtDestroy: StoredRecord | undefined;
    container.destroy = async () => {
      recordAtDestroy = readRecord();
      await originalDestroy();
    };

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(container.snapshotCalls).toBe(0);
    // The pending bit and the skip survive on the stopping record until the
    // terminal write drops the bit.
    expect(recordAtDestroy).toMatchObject({
      state: 'stopping',
      snapshotOutcome: 'skipped',
      warmRestorePending: true,
    });
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'trusted', sourceAllocation: REF_A },
      snapshotOutcome: 'skipped',
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Sandbox control diagnostic',
        diagnosticEvent: 'session_snapshot',
        result: 'skipped',
      })
    );
    log.mockRestore();
  });

  it('skips capture on every stop retry while pending and keeps the previous snapshot', async () => {
    const trusted = { id: 'trusted', sourceAllocation: REF_A };
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        lastSnapshot: trusted,
        warmRestorePending: true,
      },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'reject' };
    container.destroyBehavior = 'reject';

    await expect(instance.stop(REF_A)).resolves.toBe('retryable');

    expect(container.snapshotCalls).toBe(0);
    expect(readRecord()).toMatchObject({
      state: 'stopping',
      allocationRef: REF_A,
      lastSnapshot: trusted,
      snapshotOutcome: 'skipped',
      warmRestorePending: true,
    });

    container.destroyBehavior = 'ok';
    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(container.snapshotCalls).toBe(0);
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: trusted,
      snapshotOutcome: 'skipped',
    });
  });
});

describe('SandboxContainers clear session snapshot', () => {
  it('clears lastSnapshot, preserves the recorded outcome, and does not touch the container or the warm-base record', async () => {
    const warmBase = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        lastSnapshot: { id: 'snap-stored', sourceAllocation: REF_A },
        snapshotOutcome: 'ready',
      },
      env: { WARM_BASE: warmBase } as unknown as Env,
    });

    await instance.clearSessionSnapshot();

    expect(readRecord().lastSnapshot).toBeNull();
    expect(readRecord().snapshotOutcome).toBe('ready');
    expect(container.snapshotCalls).toBe(0);
    expect(container.destroyCalls).toBe(0);
    expect(warmBase.get).not.toHaveBeenCalled();
    expect(warmBase.put).not.toHaveBeenCalled();
    expect(warmBase.delete).not.toHaveBeenCalled();
  });

  it('is a no-op when no session snapshot is stored', async () => {
    const { instance, readRecord } = setup();

    await instance.clearSessionSnapshot();

    expect(readRecord().lastSnapshot).toBeNull();
  });
});

describe('SandboxContainers force destroy', () => {
  it('clears the record to idle so a same-ref launch starts instead of reusing a destroyed container', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;

    await instance.forceDestroyForControlPlane();

    expect(container.destroyCalls).toBe(1);
    expect(container.running).toBe(false);
    await expect(instance.observe(REF_A)).resolves.toEqual({
      running: false,
      state: 'idle',
      currentAllocationRef: null,
    });
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null, stopOpId: null });

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true });
    expect(container.startCalls).toHaveLength(1);
  });
});

describe('SandboxContainers lease and log', () => {
  it('ensures the container lease only for the current allocation', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });

    await instance.ensureLeaseAtLeast(REF_B, 60_000);
    expect(container.leaseCalls).toEqual([]);

    await instance.ensureLeaseAtLeast(REF_A, 90_000);
    expect(container.leaseCalls).toEqual([90_000]);
  });

  it('reads the wrapper log with an argv array, clamps maxBytes, and rejects other refs and paths', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.execHandler = () => makeExecProcess({ exitCode: 0, stdout: 'log-bytes' });

    await expect(instance.readLog(REF_B, CONTROL_WRAPPER_LOG_PATH, 100)).resolves.toBe('');
    await expect(instance.readLog(REF_A, '/tmp/other.log', 100)).resolves.toBe('');
    expect(container.execCalls).toEqual([]);

    await expect(instance.readLog(REF_A, CONTROL_WRAPPER_LOG_PATH, 5 * 1024 * 1024)).resolves.toBe(
      'log-bytes'
    );
    expect(container.execCalls).toEqual([
      { cmd: ['tail', '-c', String(1024 * 1024), CONTROL_WRAPPER_LOG_PATH] },
    ]);

    await expect(instance.readLog(REF_A, CONTROL_WRAPPER_LOG_PATH, Number.NaN)).resolves.toBe('');
    expect(container.execCalls).toHaveLength(1);
  });

  it('returns an empty log when the owner ref is not backed by a running container', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });

    await expect(instance.readLog(REF_A, CONTROL_WRAPPER_LOG_PATH, 100)).resolves.toBe('');
    expect(container.execCalls).toEqual([]);
  });
});

describe('SandboxContainers warm base', () => {
  it('reports image, session snapshot, record presence, and pending state in one call', async () => {
    const fresh = setup({ record: null });
    await expect(fresh.instance.warmBaseFacts()).resolves.toEqual({
      image: 'registry.example/kilo/app:test',
      sessionSnapshotId: null,
      hasRecord: false,
      warmRestorePending: false,
    });

    const stored = setup({
      record: {
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: { id: 'snap-stored', sourceAllocation: REF_A },
      },
    });
    await expect(stored.instance.warmBaseFacts()).resolves.toEqual({
      image: 'registry.example/kilo/app:test',
      sessionSnapshotId: 'snap-stored',
      hasRecord: true,
      warmRestorePending: false,
    });

    const pending = setup({
      record: {
        state: 'launching',
        allocationRef: REF_A,
        stopOpId: null,
        lastSnapshot: null,
        warmRestorePending: true,
      },
    });
    await expect(pending.instance.warmBaseFacts()).resolves.toEqual({
      image: 'registry.example/kilo/app:test',
      sessionSnapshotId: null,
      hasRecord: true,
      warmRestorePending: true,
    });
  });

  it('starts a warm id from containerSnapshot and leaves lastSnapshot null', async () => {
    const { instance, container, readRecord } = setup();

    const result = await launch(instance, REF_A, {}, 'warm-snap');

    expect(result).toEqual({ started: true });
    expect(container.startCalls).toEqual([
      { containerSnapshot: { id: 'warm-snap' }, instance: 'standard-2', enableInternet: true },
    ]);
    expect(readRecord().lastSnapshot).toBeNull();
  });

  it('lets a stored session snapshot win over the warm id', async () => {
    const { instance, container } = setup({
      record: {
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: { id: 'snap-stored', sourceAllocation: REF_A },
      },
    });

    await launch(instance, REF_A, {}, 'warm-snap');

    expect(container.startCalls).toEqual([
      { containerSnapshot: { id: 'snap-stored' }, instance: 'standard-2', enableInternet: true },
    ]);
  });

  it('captures a warm base without writing lastSnapshot', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;

    await expect(instance.captureWarmBase()).resolves.toEqual({ id: 'snap-1' });

    expect(container.snapshotCalls).toBe(1);
    expect(container.startCalls).toEqual([]);
    expect(readRecord().lastSnapshot).toBeNull();
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('never starts the container when capturing', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = false;

    await expect(instance.captureWarmBase()).resolves.toEqual({ id: 'snap-1' });

    expect(container.startCalls).toEqual([]);
    expect(container.running).toBe(false);
  });

  it('applies the warm id when resuming a launch whose start never took effect', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });

    const resumed = await launch(instance, REF_A, {}, 'warm-snap');

    expect(resumed).toEqual({ started: true });
    expect(container.startCalls).toEqual([
      { containerSnapshot: { id: 'warm-snap' }, instance: 'standard-2', enableInternet: true },
    ]);
  });
});

describe('SandboxContainers warm restore pending', () => {
  it('writes the bit before start and keeps it on the running record', async () => {
    const { instance, container, readRecord } = setup();
    const originalStart = container.start.bind(container);
    let recordAtStart: StoredRecord | undefined;
    container.start = options => {
      recordAtStart = readRecord();
      originalStart(options);
    };

    await launch(instance, REF_A, {}, 'warm-snap');

    expect(recordAtStart).toMatchObject({ state: 'launching', warmRestorePending: true });
    expect(readRecord()).toMatchObject({ state: 'running', warmRestorePending: true });
    await expect(instance.warmBaseFacts()).resolves.toMatchObject({ warmRestorePending: true });
  });

  it('leaves the bit when a warm start takes effect then throws', async () => {
    const { instance, container, readRecord } = setup();
    container.startBehavior = 'effect-then-reject';

    await expect(launch(instance, REF_A, {}, 'warm-snap')).rejects.toThrow(
      'container start failed after taking effect'
    );

    expect(container.running).toBe(true);
    expect(readRecord()).toMatchObject({ state: 'launching', warmRestorePending: true });
    await expect(instance.warmBaseFacts()).resolves.toMatchObject({ warmRestorePending: true });
  });

  it('clears an existing bit when the session snapshot wins over the warm id', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        lastSnapshot: { id: 'snap-stored', sourceAllocation: REF_A },
        warmRestorePending: true,
      },
    });

    await launch(instance, REF_A, {}, 'warm-snap');

    expect(container.startCalls).toMatchObject([
      { containerSnapshot: { id: 'snap-stored' } },
    ]);
    expect(readRecord()).toMatchObject({ state: 'running' });
    expect(readRecord().warmRestorePending).toBeUndefined();
  });

  it('clears a stale bit on an image physical start', async () => {
    const { instance, readRecord } = setup({
      record: { ...idleRecord, warmRestorePending: true },
    });

    await launch(instance, REF_A);

    expect(readRecord()).toMatchObject({ state: 'running' });
    expect(readRecord().warmRestorePending).toBeUndefined();
  });

  it('leaves an in-flight bit untouched when the container is already running', async () => {
    const pending = setup({ record: { ...idleRecord, warmRestorePending: true } });
    pending.container.running = true;

    await launch(pending.instance, REF_A);

    expect(pending.container.startCalls).toHaveLength(0);
    expect(pending.readRecord()).toMatchObject({ state: 'running', warmRestorePending: true });
  });

  it('does not synthesize a bit when an already-running start has none', async () => {
    const fresh = setup();
    fresh.container.running = true;

    await launch(fresh.instance, REF_A);

    expect(fresh.container.startCalls).toHaveLength(0);
    expect(fresh.readRecord().warmRestorePending).toBeUndefined();
  });

  it('keeps the bit across a resume that physically starts from the warm id', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });

    await launch(instance, REF_A, {}, 'warm-snap');

    expect(container.startCalls).toEqual([
      { containerSnapshot: { id: 'warm-snap' }, instance: 'standard-2', enableInternet: true },
    ]);
    expect(readRecord()).toMatchObject({ state: 'running', warmRestorePending: true });
    await expect(instance.warmBaseFacts()).resolves.toMatchObject({ warmRestorePending: true });
  });

  it('keeps an in-flight bit through a probe-found resume without starting', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A, warmRestorePending: true },
    });
    container.running = true;
    container.execHandler = () => makeExecProcess({ exitCode: 0 });

    await launch(instance, REF_A);

    expect(container.startCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'running', warmRestorePending: true });
  });
});

describe('SandboxContainers clear warm restore pending', () => {
  it('deletes the bit and leaves the rest of the record intact', async () => {
    const { instance, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        warmRestorePending: true,
      },
    });

    await instance.clearWarmRestorePending();

    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(readRecord().warmRestorePending).toBeUndefined();
  });

  it('is a no-op when the bit is absent', async () => {
    const { instance, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });

    await instance.clearWarmRestorePending();

    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(readRecord().warmRestorePending).toBeUndefined();
  });
});
