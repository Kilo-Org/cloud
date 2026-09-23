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
  httpsIntercepts: string[] = [];
  httpIntercepts: string[] = [];
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

  async interceptOutboundHttps(addr: string, _binding: Fetcher): Promise<void> {
    this.httpsIntercepts.push(addr);
  }

  async interceptAllOutboundHttp(_binding: Fetcher): Promise<void> {
    this.httpIntercepts.push('*');
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.leaseCalls.push(Number(ms));
  }

  async monitor(): Promise<void> {
    this.monitorCalls += 1;
  }
}

function setup(options: { record?: StoredRecord; attachContainer?: boolean } = {}) {
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
  storage.map.set(RECORD_KEY, options.record ?? idleRecord);
  const ctx = {
    storage,
    id: { toString: () => 'do-id' },
    container: options.attachContainer === false ? undefined : container,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    waitUntil: (promise: Promise<unknown>) => {
      pendingTasks.push(promise);
    },
  } as unknown as DurableObjectState;
  const instance = new SandboxContainers(ctx, {} as Env);
  const readRecord = () => storage.map.get(RECORD_KEY) as StoredRecord;
  return { storage, container, instance, readRecord, pendingTasks, getAlarm: () => alarm };
}

function launch(
  instance: SandboxContainers,
  allocationRef: string,
  env: Record<string, string> = {}
) {
  return instance.launchWrapper({ allocationRef, env, instance: 'standard-2' });
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

  it('installs the Kilo and git outbound proxy before a contained start', async () => {
    const { instance, container } = setup();
    const outbound = vi.fn((options: { props: { containerId: string } }) => options.props);
    (
      instance as unknown as { ctx: { exports: { ContainersOutbound: typeof outbound } } }
    ).ctx.exports = { ContainersOutbound: outbound };

    await instance.launchWrapper({
      allocationRef: REF_A,
      env: { FOO: 'bar' },
      instance: 'standard-2',
      containment: true,
    });

    expect(outbound).toHaveBeenCalledWith({ props: { containerId: 'do-id' } });
    expect(container.httpsIntercepts).toEqual(['*']);
    expect(container.httpIntercepts).toEqual(['*']);
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls[0]?.cmd[0]).toBe('sh');
    expect(container.execCalls[1]?.options?.env).toEqual({
      FOO: 'bar',
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
    });
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
      instance: 'standard-2',
    });

    container.deferredSnapshots[1]?.resolve('op2');
    await secondStop;
    await vi.advanceTimersByTimeAsync(0);

    expect(readRecord().lastSnapshot).toEqual({ id: 'op2', sourceAllocation: REF_A });
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
    });
  });

  it('destroys even when the snapshot fails', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    });
    container.running = true;
    container.snapshotBehavior = { kind: 'reject' };

    const result = await instance.stop(REF_A);

    expect(result).toBe('terminal');
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null, lastSnapshot: null });
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
