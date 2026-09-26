import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  wrapperAttempt?: string;
};

const idleRecord: StoredRecord = {
  state: 'idle',
  allocationRef: null,
  stopOpId: null,
  lastSnapshot: null,
};

type ExecBehavior = {
  pid?: number;
  exitCode?: number;
  exitError?: Error;
  exitCodePromise?: Promise<number>;
  stdout?: string;
  stderr?: string;
  outputError?: Error;
};

function makeExecProcess(behavior: ExecBehavior = {}): ExecProcess {
  const exitCode = behavior.exitCodePromise
    ? behavior.exitCodePromise
    : behavior.exitError
      ? Promise.resolve().then((): number => {
          throw behavior.exitError;
        })
      : Promise.resolve(behavior.exitCode ?? 0);
  return {
    pid: behavior.pid ?? 1,
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
  calls: string[] = [];
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
  execHandler: (cmd: string[]) => ExecProcess | Promise<ExecProcess> = () =>
    makeExecProcess({ exitCode: 0 });

  start(options?: ContainerStartupOptions): void {
    this.calls.push('start');
    this.startCalls.push(options as ContainerStartupOptions);
    if (this.startBehavior === 'reject') throw new Error('container start failed');
    this.running = true;
    if (this.startBehavior === 'effect-then-reject') {
      throw new Error('container start failed after taking effect');
    }
  }

  async exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    this.calls.push(`exec:${cmd[0]}`);
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
    this.calls.push('https-intercept');
    this.httpsIntercepts.push(addr);
  }

  async interceptAllOutboundHttp(_binding: Fetcher): Promise<void> {
    this.calls.push('http-intercept');
    this.httpIntercepts.push('*');
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.leaseCalls.push(Number(ms));
  }

  async monitor(): Promise<void> {
    this.monitorCalls += 1;
  }
}

type PutDecision = 'pass' | 'hold' | 'fail';

function setup(options: { record?: StoredRecord; attachContainer?: boolean } = {}) {
  const container = new FakeContainer();
  let alarm: number | undefined;
  const pendingTasks: Promise<unknown>[] = [];
  let putGate: ((value: unknown) => PutDecision) | undefined;
  let releaseHeldPut: (() => void) | undefined;
  const storage = {
    map: new Map<string, unknown>(),
    async get<T>(key: string): Promise<T | undefined> {
      return storage.map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      const decision = putGate?.(value) ?? 'pass';
      if (decision === 'fail') {
        putGate = undefined;
        throw new Error('storage put failed');
      }
      if (decision === 'hold') {
        putGate = undefined;
        await new Promise<void>(resolve => {
          releaseHeldPut = () => {
            storage.map.set(key, value);
            resolve();
          };
        });
        return;
      }
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
  return {
    storage,
    container,
    instance,
    readRecord,
    pendingTasks,
    getAlarm: () => alarm,
    setPutGate: (gate: (value: unknown) => PutDecision) => {
      putGate = gate;
    },
    releaseHeldPut: () => {
      releaseHeldPut?.();
      releaseHeldPut = undefined;
    },
  };
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
    expect(container.execCalls).toEqual([
      {
        cmd: ['bun', 'run', CONTROL_WRAPPER_PATH],
        options: {
          cwd: '/',
          env: {
            FOO: 'bar',
            SANDBOX_INTERCEPT_HTTPS: '1',
            NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
          },
        },
      },
    ]);
  });

  it('resumes a contained pre-exec launch into a wrapper that carries the intercept env', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      },
    });
    const outbound = vi.fn((options: { props: { containerId: string } }) => options.props);
    (
      instance as unknown as { ctx: { exports: { ContainersOutbound: typeof outbound } } }
    ).ctx.exports = { ContainersOutbound: outbound };
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });

    const resumed = await instance.launchWrapper({
      allocationRef: REF_A,
      env: { FOO: 'bar' },
      instance: 'standard-2',
      containment: true,
    });

    expect(resumed).toEqual({ started: true });
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep', 'bun']);
    expect(container.execCalls[1]?.options?.env).toEqual({
      FOO: 'bar',
      SANDBOX_INTERCEPT_HTTPS: '1',
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
    });
    expect(container.httpsIntercepts).toEqual(['*']);
    expect(container.httpIntercepts).toEqual(['*']);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('leaves launching when the wrapper exec fails, then adopts via pgrep or re-execs once', async () => {
    const failed = setup();
    failed.container.execHandler = () => {
      throw new Error('spawn failed');
    };
    await expect(launch(failed.instance, REF_A)).rejects.toThrow('spawn failed');
    expect(failed.readRecord()).toMatchObject({ state: 'launching', allocationRef: REF_A });

    const adopts = setup({ record: { ...idleRecord, state: 'launching', allocationRef: REF_A } });
    adopts.container.running = true;
    adopts.container.execHandler = () => makeExecProcess({ exitCode: 0 });
    const adopted = await launch(adopts.instance, REF_A);
    expect(adopted).toEqual({ started: true });
    expect(adopts.readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(adopts.container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep']);

    const reexecs = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      },
    });
    reexecs.container.execHandler = cmd =>
      makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    const reexecuted = await launch(reexecs.instance, REF_A);
    expect(reexecuted).toEqual({ started: true });
    expect(reexecs.readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(reexecs.container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep', 'bun']);
  });

  it('detects a wrapper that appears late while the pid-0 handle exitCode stays pending', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = setup();
    let activeProbes = 0;
    let maxActiveProbes = 0;
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        activeProbes += 1;
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
        const proc = makeExecProcess({ exitCode: Date.now() - startedAt >= 70_000 ? 0 : 1 });
        void proc.exitCode.finally(() => {
          activeProbes -= 1;
        });
        return proc;
      }
      return new Promise<ExecProcess>(resolve => {
        setTimeout(() => {
          resolve(
            makeExecProcess({
              pid: 0,
              // The wrapper is long-lived: its exitCode never settles.
              exitCodePromise: new Promise<number>(() => {}),
            })
          );
        }, 65_000);
      });
    };

    let settled = false;
    const pending = launch(instance, REF_A).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(settled).toBe(false);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['bun', 'pgrep']);
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ started: true });
    expect(maxActiveProbes).toBe(1);
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(container.execCalls.at(-1)?.cmd[0]).toBe('pgrep');
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('retries one bun only after the pid-0 handle exitCode fulfils and a fresh absent probe', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    let buns = 0;
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') return makeExecProcess({ exitCode: 1 });
      buns += 1;
      if (buns === 1) {
        return makeExecProcess({
          pid: 0,
          exitCodePromise: new Promise<number>(res => setTimeout(() => res(1), 40_000)),
        });
      }
      return makeExecProcess({ pid: 2 });
    };

    const pending = launch(instance, REF_A);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(buns).toBe(1);
    expect(container.execCalls[0]?.cmd[0]).toBe('bun');

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ started: true });
    expect(buns).toBe(2);
    expect(container.execCalls.at(-1)?.cmd[0]).toBe('bun');
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('does not retry the bun when the fresh post-completion probe is ambiguous', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = setup();
    let absentProbes = 0;
    let ambiguousProbes = 0;
    container.execHandler = cmd => {
      if (cmd[0] !== 'pgrep') {
        return makeExecProcess({
          pid: 0,
          exitCodePromise: new Promise<number>(res => setTimeout(() => res(0), 5_000)),
        });
      }
      if (Date.now() - startedAt >= 5_000) {
        ambiguousProbes += 1;
        return makeExecProcess({ exitCode: 2 });
      }
      absentProbes += 1;
      return makeExecProcess({ exitCode: 1 });
    };

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toBe('rejected');
    expect(absentProbes).toBeGreaterThanOrEqual(1);
    expect(ambiguousProbes).toBeGreaterThanOrEqual(1);
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('discards a stale pre-completion probe and probes fresh after the handle exitCode fulfils', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = setup();
    let resolveWrapperExit!: (code: number) => void;
    let resolveFirstProbeExit!: (code: number) => void;
    let buns = 0;
    let pgrepExecs = 0;
    let activeProbes = 0;
    let maxActiveProbes = 0;
    const pgrepStarts: number[] = [];
    const pgrepSettles: number[] = [];

    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        pgrepExecs += 1;
        pgrepStarts.push(Date.now() - startedAt);
        activeProbes += 1;
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
        const exitCode = new Promise<number>(resolve => {
          if (pgrepExecs === 1) resolveFirstProbeExit = resolve;
          else resolve(0);
        });
        void exitCode.then(() => {
          pgrepSettles.push(Date.now() - startedAt);
          activeProbes -= 1;
        });
        return makeExecProcess({ exitCodePromise: exitCode });
      }
      buns += 1;
      return makeExecProcess({
        pid: 0,
        exitCodePromise: new Promise<number>(resolve => {
          resolveWrapperExit = resolve;
        }),
      });
    };

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(buns).toBe(1);
    expect(pgrepExecs).toBe(1);

    await vi.advanceTimersByTimeAsync(40_000);
    resolveWrapperExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(pgrepExecs).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    resolveFirstProbeExit(1);
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toBe('resolved');
    expect(buns).toBe(1);
    expect(pgrepExecs).toBe(2);
    expect(maxActiveProbes).toBe(1);
    expect(pgrepStarts[1] ?? -1).toBeGreaterThanOrEqual(pgrepSettles[0] ?? Number.MAX_SAFE_INTEGER);
    expect(pgrepStarts[0] ?? -1).toBe(0);
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('fences an unresolved wrapper exec at the readiness deadline without probing or a retry', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    container.execHandler = () => new Promise<never>(() => {}) as unknown as ExecProcess;

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(89_000);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['bun']);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['bun']);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    container.running = false;
    await expect(launch(instance, REF_A)).rejects.toThrow(
      'pending and the container is not running'
    );
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
  });

  it('does not start a second bun while a pid-0 handle exitCode is pending', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    container.execHandler = cmd =>
      cmd[0] === 'pgrep'
        ? makeExecProcess({ exitCode: 1 })
        : makeExecProcess({ pid: 0, exitCodePromise: new Promise<number>(() => {}) });

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(90_000);

    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('does not overlap a pgrep whose native call is unsettled, even when the handle exitCode settles', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    let resolveHandleExit!: (code: number) => void;
    let pgrepCalls = 0;
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        pgrepCalls += 1;
        return new Promise<never>(() => {}) as unknown as ExecProcess;
      }
      return makeExecProcess({
        pid: 0,
        exitCodePromise: new Promise<number>(res => {
          resolveHandleExit = res;
        }),
      });
    };

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );

    await vi.advanceTimersByTimeAsync(50_000);
    expect(pgrepCalls).toBe(1);
    resolveHandleExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(pgrepCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(40_000);
    await expect(outcome).resolves.toBe('rejected');
    expect(pgrepCalls).toBe(1);
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('rejects a found probe when the retained handle exitCode rejected while it was pending', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    let rejectHandleExit!: (error: Error) => void;
    let resolveProbe!: (proc: ExecProcess) => void;
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        return new Promise<ExecProcess>(resolve => {
          resolveProbe = resolve;
        });
      }
      return makeExecProcess({
        pid: 0,
        exitCodePromise: new Promise<number>((_resolve, reject) => {
          rejectHandleExit = reject;
        }),
      });
    };

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(0);

    rejectHandleExit(new Error('wrapper handle failed'));
    await vi.advanceTimersByTimeAsync(0);

    resolveProbe(makeExecProcess({ exitCode: 0 }));
    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('bounds a probe by the remaining budget and queues no probe behind a hung exitCode', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = setup();
    let pgrepCalls = 0;
    let absentProbes = 0;
    let hungProbes = 0;
    let hungAtElapsed: number | undefined;
    container.execHandler = cmd => {
      if (cmd[0] !== 'pgrep') {
        return makeExecProcess({
          pid: 0,
          exitCodePromise: new Promise<number>(res => setTimeout(() => res(1), 88_000)),
        });
      }
      pgrepCalls += 1;
      if (Date.now() - startedAt >= 88_000) {
        hungProbes += 1;
        hungAtElapsed = Date.now() - startedAt;
        return makeExecProcess({ exitCodePromise: new Promise<number>(() => {}) });
      }
      absentProbes += 1;
      return makeExecProcess({ exitCode: 1 });
    };

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(89_000);
    expect(absentProbes).toBeGreaterThanOrEqual(1);
    expect(hungProbes).toBe(1);
    expect(hungAtElapsed).toBe(88_000);
    const probesAt89 = pgrepCalls;

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('rejected');
    expect(pgrepCalls).toBe(probesAt89);
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('does not start a pgrep when the final sleep lands on the deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = setup();
    const execStarts: number[] = [];
    const pgrepStarts: number[] = [];
    container.execHandler = cmd => {
      const elapsed = Date.now() - startedAt;
      execStarts.push(elapsed);
      if (cmd[0] === 'pgrep') {
        pgrepStarts.push(elapsed);
        return makeExecProcess({
          exitCodePromise: new Promise<number>(res => setTimeout(() => res(1), 700)),
        });
      }
      return makeExecProcess({ pid: 0, exitCodePromise: new Promise<number>(() => {}) });
    };

    const pending = launch(instance, REF_A);
    const failure = pending.then(
      () => null,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(90_000);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('wrapper exec timed out');
    expect(pgrepStarts.length).toBeGreaterThan(1);
    expect(pgrepStarts.at(-1) ?? 0).toBeGreaterThanOrEqual(88_000);
    expect(execStarts.filter(start => start >= 90_000)).toEqual([]);
    expect(pgrepStarts.filter(start => start >= 90_000)).toEqual([]);
    expect(container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('fences a rejected wrapper exec and never bun-execs on a later same-ref probe', async () => {
    const rejected = setup();
    rejected.container.execHandler = () => {
      throw new Error('spawn failed');
    };

    await expect(launch(rejected.instance, REF_A)).rejects.toThrow('spawn failed');
    expect(rejected.readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    // A later same-ref entry on the running container only probes: absent never re-execs.
    rejected.container.running = true;
    rejected.container.execHandler = cmd =>
      makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    await expect(launch(rejected.instance, REF_A)).rejects.toThrow(
      'pending and no wrapper was found'
    );
    expect(rejected.container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);

    // An ambiguous probe never re-execs either.
    rejected.container.execHandler = () => makeExecProcess({ exitCode: 2 });
    await expect(launch(rejected.instance, REF_A)).rejects.toThrow('Wrapper probe was ambiguous');
    expect(rejected.container.execCalls.filter(call => call.cmd[0] === 'bun')).toHaveLength(1);
  });

  it('applies the requested instance when resuming a pre-exec launch whose start never took effect', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      },
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
    container.running = true;
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
    container.running = true;
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

describe('SandboxContainers wrapper attempt gate', () => {
  function attachOutbound(instance: SandboxContainers): void {
    const outbound = vi.fn((options: { props: { containerId: string } }) => options.props);
    (
      instance as unknown as { ctx: { exports: { ContainersOutbound: typeof outbound } } }
    ).ctx.exports = { ContainersOutbound: outbound };
  }

  it('refuses an idle record that already carries a wrapper attempt before any physical call', async () => {
    for (const wrapperAttempt of ['exec_pending', 'not_started'] as const) {
      const { instance, container, readRecord } = setup({
        record: { ...idleRecord, wrapperAttempt },
      });

      await expect(launch(instance, REF_A)).rejects.toThrow();

      expect(container.startCalls).toHaveLength(0);
      expect(container.execCalls).toHaveLength(0);
      expect(readRecord()).toMatchObject({ state: 'idle', wrapperAttempt });
    }
  });

  it('fails closed on an unknown wrapper attempt phase', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'bogus',
      },
    });

    await expect(launch(instance, REF_A)).rejects.toThrow();

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'launching', wrapperAttempt: 'bogus' });
  });

  it('leaves a running record that carries a pending fence untouched and unbackfilled', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        instance: 'standard-1',
        wrapperAttempt: 'exec_pending',
      },
    });
    container.running = true;

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: false });

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'running',
      allocationRef: REF_A,
      instance: 'standard-1',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('adopts a found wrapper on a running pending or legacy record without launching again', async () => {
    for (const wrapperAttempt of ['exec_pending', undefined] as const) {
      const { instance, container, readRecord } = setup({
        record: {
          ...idleRecord,
          state: 'launching',
          allocationRef: REF_A,
          instance: 'standard-1',
          ...(wrapperAttempt === undefined ? {} : { wrapperAttempt }),
        },
      });
      container.running = true;
      container.execHandler = () => makeExecProcess({ exitCode: 0 });

      await expect(launch(instance, REF_A)).resolves.toEqual({ started: true });

      expect(container.startCalls).toHaveLength(0);
      expect(container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep']);
      expect(readRecord()).toMatchObject({
        state: 'running',
        allocationRef: REF_A,
        instance: 'standard-1',
        wrapperAttempt: 'exec_pending',
      });
    }
  });

  it('refuses a running pending or legacy record when the wrapper is absent or ambiguous', async () => {
    const absent = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    absent.container.running = true;
    absent.container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });

    await expect(launch(absent.instance, REF_A)).rejects.toThrow(
      'pending and no wrapper was found'
    );
    expect(absent.container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep']);
    expect(absent.readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    const ambiguous = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
      },
    });
    ambiguous.container.running = true;
    ambiguous.container.execHandler = () => makeExecProcess({ exitCode: 2 });

    await expect(launch(ambiguous.instance, REF_A)).rejects.toThrow('Wrapper probe was ambiguous');
    expect(ambiguous.container.execCalls.map(call => call.cmd[0])).toEqual(['pgrep']);
    expect(ambiguous.readRecord()).toMatchObject({
      state: 'launching',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('refuses a stopped pending or legacy record without proxy, probe, billing, start or bun', async () => {
    for (const wrapperAttempt of ['exec_pending', undefined] as const) {
      const { instance, container, readRecord } = setup({
        record: {
          ...idleRecord,
          state: 'launching',
          allocationRef: REF_A,
          ...(wrapperAttempt === undefined ? {} : { wrapperAttempt }),
        },
      });
      attachOutbound(instance);

      await expect(
        instance.launchWrapper({
          allocationRef: REF_A,
          env: {},
          instance: 'standard-2',
          containment: true,
        })
      ).rejects.toThrow('pending and the container is not running');

      expect(container.httpsIntercepts).toHaveLength(0);
      expect(container.httpIntercepts).toHaveLength(0);
      expect(container.startCalls).toHaveLength(0);
      expect(container.execCalls).toHaveLength(0);
      expect(readRecord()).toMatchObject({ state: 'launching', allocationRef: REF_A });
    }
  });

  it('installs the containment proxy before the adoption probe', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    container.running = true;
    container.execHandler = () => makeExecProcess({ exitCode: 0 });
    attachOutbound(instance);

    await instance.launchWrapper({
      allocationRef: REF_A,
      env: {},
      instance: 'standard-2',
      containment: true,
    });

    expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'exec:pgrep']);
  });

  it('orders containment before start and exec on a fresh contained launch', async () => {
    const { instance, container } = setup();
    attachOutbound(instance);

    await instance.launchWrapper({
      allocationRef: REF_A,
      env: {},
      instance: 'standard-2',
      containment: true,
    });

    expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'start', 'exec:bun']);
  });

  it('orders containment before start, probe and bun on a stopped pre-exec resume', async () => {
    const { instance, container } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      },
    });
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    attachOutbound(instance);

    await instance.launchWrapper({
      allocationRef: REF_A,
      env: {},
      instance: 'standard-2',
      containment: true,
    });

    expect(container.calls).toEqual([
      'https-intercept',
      'http-intercept',
      'start',
      'exec:pgrep',
      'exec:bun',
    ]);
  });
});

describe('SandboxContainers readiness deadline', () => {
  it('does not invoke the native exec when the awaited phase write returns past the deadline, and rolls back', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord, setPutGate, releaseHeldPut } = setup();
    setPutGate(value =>
      (value as { wrapperAttempt?: string }).wrapperAttempt === 'exec_pending' ? 'hold' : 'pass'
    );

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    // The launch is suspended on the awaited durable write; time passes the deadline.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(container.execCalls).toHaveLength(0);

    releaseHeldPut();
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'not_started',
    });
  });

  it('keeps the pending fence when the post-deadline rollback write fails', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord, setPutGate, releaseHeldPut } = setup();
    setPutGate(value =>
      (value as { wrapperAttempt?: string }).wrapperAttempt === 'exec_pending' ? 'hold' : 'pass'
    );

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(90_000);
    expect(container.execCalls).toHaveLength(0);

    // The rollback write fails; the durable exec_pending fence must remain.
    setPutGate(value =>
      (value as { wrapperAttempt?: string }).wrapperAttempt === 'not_started' ? 'fail' : 'pass'
    );
    releaseHeldPut();
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
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

  it('does not clear a pending phase when a timed-out destroy later resolves, but a confirmed stop does', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
      },
    });
    container.destroyBehavior = 'deferred';

    const first = instance.stop(REF_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.destroyCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBe('retryable');
    expect(readRecord()).toMatchObject({
      state: 'stopping',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    // The late resolution has no continuation that could clear the phase.
    container.deferredDestroy?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(readRecord()).toMatchObject({
      state: 'stopping',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    container.destroyBehavior = 'ok';
    await expect(instance.stop(REF_A)).resolves.toBe('terminal');
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null });
    expect(readRecord().wrapperAttempt).toBeUndefined();
  });

  it('does not clear a pending or legacy phase when the container is missing, but clears not_started', async () => {
    const pending = setup({
      attachContainer: false,
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
      },
    });
    await expect(pending.instance.stop(REF_A)).resolves.toBe('retryable');
    expect(pending.readRecord()).toMatchObject({
      state: 'stopping',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    const legacy = setup({
      attachContainer: false,
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    await expect(legacy.instance.stop(REF_A)).resolves.toBe('retryable');
    expect(legacy.readRecord()).toMatchObject({ state: 'stopping', allocationRef: REF_A });

    const preExec = setup({
      attachContainer: false,
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      },
    });
    await expect(preExec.instance.stop(REF_A)).resolves.toBe('terminal');
    expect(preExec.readRecord()).toMatchObject({ state: 'idle', allocationRef: null });
    expect(preExec.readRecord().wrapperAttempt).toBeUndefined();
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

describe('containment trust ownership', () => {
  const sandboxContainersSource = readFileSync(
    fileURLToPath(new URL('./SandboxContainers.ts', import.meta.url).href),
    'utf8'
  );
  const dockerfileSource = readFileSync(
    fileURLToPath(new URL('../../Dockerfile.containers', import.meta.url).href),
    'utf8'
  );

  it('runs no CA trust exec in the Durable Object', () => {
    expect(sandboxContainersSource).not.toContain('trustInterceptCa');
    expect(sandboxContainersSource).not.toContain('container CA trust timed out');
    expect(sandboxContainersSource).not.toContain('update-ca-certificates');
  });

  it('keeps the container entrypoint to PID 1 only', () => {
    expect(dockerfileSource).not.toContain('update-ca-certificates');
    expect(dockerfileSource).toContain('exec sleep infinity');
  });
});
