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
  CONTROL_SUPERVISOR_PATH,
  CONTROL_WRAPPER_LOG_PATH,
} from '../sandbox-control/container-paths.js';
import {
  ContainersAllocationConflictError,
  SandboxContainers,
  type ContainerInstanceSize,
  type ContainersObservation,
} from './SandboxContainers.js';
import type { Env } from '../types.js';

// The fake proves coordinator ordering only. It does not prove that exec behaves as assumed, and it
// fails any attempt to snapshot the container so a stop that snapshots cannot pass silently.
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
  inspectCalls = 0;
  leaseCalls: number[] = [];
  runningAtDestroy: boolean[] = [];
  // PID 1 as seen through `/proc/1/cmdline`. A manual `running = true` models the
  // deployed `sleep infinity` main process; `start()` with the native entrypoint
  // models the supervisor main process.
  mainProcess: 'sleep' | 'supervisor' | 'ambiguous' = 'sleep';
  // What native `start()` leaves as PID 1. A lucky start normally leaves the
  // supervisor; tests override this to model a start whose main process is wrong.
  identityAfterStart: 'sleep' | 'supervisor' | 'ambiguous' = 'supervisor';
  // Raw `/proc/1/cmdline` bytes for identity fixtures. Overrides `mainProcess`.
  cmdlineRaw?: string;
  stopAfterStart = false;

  startBehavior: StartBehavior = 'ok';
  destroyBehavior: DestroyBehavior = 'ok';
  deferredDestroy: { resolve: () => void; reject: (error: Error) => void } | null = null;
  execHandler: (cmd: string[]) => ExecProcess | Promise<ExecProcess> = () =>
    makeExecProcess({ exitCode: 0 });

  start(options?: ContainerStartupOptions): void {
    this.calls.push('start');
    this.startCalls.push(options as ContainerStartupOptions);
    if (this.startBehavior === 'reject') throw new Error('container start failed');
    this.running = true;
    if (options?.entrypoint?.includes(CONTROL_SUPERVISOR_PATH)) {
      this.mainProcess = this.identityAfterStart;
    }
    if (this.stopAfterStart) this.running = false;
    if (this.startBehavior === 'effect-then-reject') {
      throw new Error('container start failed after taking effect');
    }
  }

  async exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    this.calls.push(`exec:${cmd[0]}`);
    this.execCalls.push({ cmd, options });
    if (cmd[0] === 'cat' && cmd[1] === '/proc/1/cmdline') {
      if (this.cmdlineRaw !== undefined)
        return makeExecProcess({ exitCode: 0, stdout: this.cmdlineRaw });
      if (this.mainProcess === 'ambiguous') return makeExecProcess({ exitCode: 1 });
      return makeExecProcess({
        exitCode: 0,
        stdout:
          this.mainProcess === 'supervisor'
            ? `/bin/sh\0${CONTROL_SUPERVISOR_PATH}`
            : 'sleep\0infinity',
      });
    }
    return this.execHandler(cmd);
  }

  async snapshotContainer(_options: ContainerSnapshotOptions): Promise<ContainerSnapshot> {
    this.snapshotCalls += 1;
    throw new Error('container snapshot is disabled');
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

  async inspect(): Promise<ContainerInfo> {
    this.inspectCalls += 1;
    return { image: 'registry.example/kilo/app:test', labels: {} };
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

function attachOutbound(instance: SandboxContainers): void {
  const outbound = vi.fn((options: { props: { containerId: string } }) => options.props);
  (
    instance as unknown as { ctx: { exports: { ContainersOutbound: typeof outbound } } }
  ).ctx.exports = { ContainersOutbound: outbound };
}

const NATIVE_GATE_ENV = { CONTROL_PLANE_NATIVE_LOGS: '1' };
const NATIVE_ENTRYPOINT = ['/bin/sh', CONTROL_SUPERVISOR_PATH] as const;

function nativeStartOptions(
  instance: ContainerInstanceSize,
  env: Record<string, string> = {}
): Record<string, unknown> {
  return {
    image: 'registry.example/kilo/app:test',
    instance,
    enableInternet: true,
    entrypoint: [...NATIVE_ENTRYPOINT],
    env: { ...env, ...NATIVE_GATE_ENV },
  };
}

function sleepPreExec(record?: StoredRecord) {
  const state = setup({
    record:
      record ??
      ({
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      } as StoredRecord),
  });
  // A manually running container models the deployed `sleep infinity` main process.
  state.container.running = true;
  return state;
}

describe('SandboxContainers native start and main-process identity', () => {
  it('fresh idle+missing starts natively with the supervisor entrypoint, gate and CA, and never execs the supervisor', async () => {
    const { instance, container, readRecord } = setup();
    attachOutbound(instance);

    const result = await instance.launchWrapper({
      allocationRef: REF_A,
      env: { FOO: 'bar' },
      instance: 'standard-2',
      containment: true,
    });

    expect(result).toEqual({ started: true });
    expect(container.startCalls).toEqual([
      nativeStartOptions('standard-2', {
        FOO: 'bar',
        SANDBOX_INTERCEPT_HTTPS: '1',
        NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      }),
    ]);
    // The only exec is the PID 1 identity read; there is no supervisor exec.
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
    expect(container.monitorCalls).toBe(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(readRecord().wrapperAttempt).toBeUndefined();

    const again = await launch(instance, REF_A, { FOO: 'bar' });
    expect(again).toEqual({ started: false });
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls).toHaveLength(1);
  });

  it('starts from the image even when a stored snapshot exists, without consulting inspect()', async () => {
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
    expect(options).toEqual(nativeStartOptions('lite'));
    expect('containerSnapshot' in options).toBe(false);
    expect(container.inspectCalls).toBe(0);
  });

  it('installs the Kilo and git outbound proxy before a contained native start', async () => {
    const { instance, container } = setup();
    attachOutbound(instance);

    await instance.launchWrapper({
      allocationRef: REF_A,
      env: { FOO: 'bar' },
      instance: 'standard-2',
      containment: true,
    });

    expect(container.httpsIntercepts).toEqual(['*']);
    expect(container.httpIntercepts).toEqual(['*']);
    expect(container.startCalls).toHaveLength(1);
    // Containment precedes start, and the identity read is the only post-start exec.
    expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'start', 'exec:cat']);
    expect(container.execCalls[0]?.options?.env).toBeUndefined();
  });

  it('native-starts a stopped pre-exec launch with the requested instance', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      },
    });

    const resumed = await instance.launchWrapper({
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
    });

    expect(resumed).toEqual({ started: true });
    expect(container.startCalls).toEqual([nativeStartOptions('standard-3')]);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('treats a same-ref running record as a no-op and does not read identity', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A, instance: 'standard-1' },
    });
    container.running = true;

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: false });

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls).toHaveLength(0);
    expect(container.inspectCalls).toBe(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
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

  it('retains ownership when native start takes effect then throws, then stops and relaunches', async () => {
    const { instance, container, readRecord } = setup();
    container.startBehavior = 'effect-then-reject';

    await expect(launch(instance, REF_A)).rejects.toThrow(
      'container start failed after taking effect'
    );

    expect(container.running).toBe(true);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

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
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect([REF_A, REF_B]).toContain(readRecord().allocationRef);
  });
});

describe('SandboxContainers main-process identity decision table', () => {
  it('launching + missing adopts a live sleep main process without start or supervisor exec', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });
    container.running = true;
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 0 : 0 });

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true });

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'running',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('launching + missing while stopped refuses without start or exec', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, state: 'launching', allocationRef: REF_A },
    });

    await expect(launch(instance, REF_A)).rejects.toThrow(
      'pending and the container is not running'
    );

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls).toHaveLength(0);
    expect(container.httpsIntercepts).toHaveLength(0);
    expect(container.httpIntercepts).toHaveLength(0);
  });

  it('exec_pending while stopped throws and does not start', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
      },
    });

    await expect(launch(instance, REF_A)).rejects.toThrow(
      'pending and the container is not running'
    );

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls).toHaveLength(0);
    expect(container.httpsIntercepts).toHaveLength(0);
    expect(container.httpIntercepts).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('a verified supervisor PID 1 completes issuance without pgrep or exec', async () => {
    for (const wrapperAttempt of ['exec_pending', 'not_started'] as const) {
      const { instance, container, readRecord } = setup({
        record: {
          ...idleRecord,
          state: 'launching',
          allocationRef: REF_A,
          wrapperAttempt,
        },
      });
      container.running = true;
      container.mainProcess = 'supervisor';

      await expect(launch(instance, REF_A)).resolves.toEqual({ started: true });

      expect(container.startCalls).toHaveLength(0);
      expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
      expect(container.execCalls.some(call => call.cmd[0] === 'pgrep')).toBe(false);
      expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
      expect(readRecord().wrapperAttempt).toBeUndefined();
    }
  });

  it('running sleep not_started still execs with the gated env and uses the broad probe', async () => {
    const { instance, container, readRecord } = sleepPreExec();
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true });

    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep', '/bin/sh']);
    expect(container.execCalls.at(-1)?.options?.env).toMatchObject(NATIVE_GATE_ENV);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('running sleep exec_pending with a found wrapper adopts without a second exec', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
      },
    });
    container.running = true;
    container.execHandler = () => makeExecProcess({ exitCode: 0 });

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true });

    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'running',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('running sleep exec_pending with an absent or ambiguous probe never re-execs', async () => {
    const absent = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
      },
    });
    absent.container.running = true;
    absent.container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });

    await expect(launch(absent.instance, REF_A)).rejects.toThrow(
      'pending and no wrapper was found'
    );
    expect(absent.container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
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
    expect(ambiguous.container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
    expect(ambiguous.container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
  });

  it('an ambiguous PID 1 cmdline fails without start or exec', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
      },
    });
    container.running = true;
    container.mainProcess = 'ambiguous';

    await expect(launch(instance, REF_A)).rejects.toThrow('Main process identity is ambiguous');

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('classifies only the exact PID 1 cmdline bytes as a known main process', async () => {
    const cases: Array<{ label: string; raw: string; known: boolean }> = [
      { label: 'sleep, no trailing NUL', raw: 'sleep\0infinity', known: true },
      { label: 'sleep, trailing NUL', raw: 'sleep\0infinity\0', known: true },
      {
        label: 'supervisor, no trailing NUL',
        raw: `/bin/sh\0${CONTROL_SUPERVISOR_PATH}`,
        known: true,
      },
      {
        label: 'supervisor, trailing NUL',
        raw: `/bin/sh\0${CONTROL_SUPERVISOR_PATH}\0`,
        known: true,
      },
      { label: 'empty', raw: '', known: false },
      { label: 'space-joined sleep', raw: 'sleep infinity', known: false },
      { label: 'space-joined supervisor', raw: `/bin/sh ${CONTROL_SUPERVISOR_PATH}`, known: false },
      { label: 'other exit0', raw: 'node\0server.js', known: false },
      { label: 'double trailing NUL', raw: 'sleep\0infinity\0\0', known: false },
    ];
    for (const testCase of cases) {
      const { instance, container } = setup({
        record: {
          ...idleRecord,
          state: 'launching',
          allocationRef: REF_A,
          wrapperAttempt: 'exec_pending',
        },
      });
      container.running = true;
      container.cmdlineRaw = testCase.raw;
      container.execHandler = () => makeExecProcess({ exitCode: 0 });

      if (testCase.known) {
        await expect(launch(instance, REF_A), testCase.label).resolves.toEqual({ started: true });
      } else {
        await expect(launch(instance, REF_A), testCase.label).rejects.toThrow();
      }
      expect(container.startCalls, testCase.label).toHaveLength(0);
      expect(
        container.execCalls.filter(call => call.cmd[0] === '/bin/sh'),
        testCase.label
      ).toHaveLength(0);
    }
  });

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

  it('installs the containment proxy before a stopped insertion reuse, without start', async () => {
    const { instance, container } = sleepPreExec({
      ...idleRecord,
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'not_started',
    });
    container.running = false;
    attachOutbound(instance);

    await instance.launchWrapper({
      allocationRef: REF_A,
      env: {},
      instance: 'standard-2',
      containment: true,
    });

    // Containment precedes the native start; identity follows it.
    expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'start', 'exec:cat']);
    expect(container.httpsIntercepts).toEqual(['*']);
    expect(container.httpIntercepts).toEqual(['*']);
  });
});

describe('SandboxContainers native start confirmation', () => {
  it('fences the native start when PID 1 never matches the supervisor and does not exec', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    container.identityAfterStart = 'sleep';

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(89_000);
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('fences a failed running-record write after native startup and never starts or execs on retry', async () => {
    const { instance, container, readRecord, setPutGate } = setup();
    setPutGate(value => {
      const record = value as { state?: string; wrapperAttempt?: string; allocationRef?: string };
      return record.state === 'running' &&
        record.wrapperAttempt === undefined &&
        record.allocationRef === REF_A
        ? 'fail'
        : 'pass';
    });

    await expect(launch(instance, REF_A)).rejects.toThrow('storage put failed');

    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    setPutGate(() => 'pass');
    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true });
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('fences the native start when the container stops before PID 1 is confirmed', async () => {
    const { instance, container, readRecord } = setup();
    container.stopAfterStart = true;

    await expect(launch(instance, REF_A)).rejects.toThrow(
      'stopped before the supervisor main process was confirmed'
    );

    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    // A later same-ref entry on the stopped container refuses and never starts a supervisor.
    container.stopAfterStart = false;
    await expect(launch(instance, REF_A)).rejects.toThrow(
      'pending and the container is not running'
    );
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls).toHaveLength(0);
  });
});

describe('SandboxContainers sleep exec retry', () => {
  it('retries one bun only after the pid-0 handle exitCode fulfils and a fresh absent probe', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = sleepPreExec();
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
    expect(container.execCalls.find(call => call.cmd[0] === '/bin/sh')).toBeDefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(buns).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(buns).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ started: true });
    expect(buns).toBe(2);
    expect(container.execCalls.at(-1)?.cmd[0]).toBe('/bin/sh');
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('fences an unresolved wrapper exec at the readiness deadline without probing or a retry', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = sleepPreExec();
    container.execHandler = cmd =>
      cmd[0] === 'pgrep'
        ? makeExecProcess({ exitCode: 1 })
        : (new Promise<never>(() => {}) as unknown as ExecProcess);

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(89_000);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    container.running = false;
    await expect(launch(instance, REF_A)).rejects.toThrow(
      'pending and the container is not running'
    );
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
  });

  it('does not start a second bun while a pid-0 handle exitCode is pending', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = sleepPreExec();
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
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('fences a rejected wrapper exec and never bun-execs on a later same-ref probe', async () => {
    const rejected = sleepPreExec();
    rejected.container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') return makeExecProcess({ exitCode: 1 });
      throw new Error('spawn failed');
    };

    await expect(launch(rejected.instance, REF_A)).rejects.toThrow('spawn failed');
    expect(rejected.readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    // A later same-ref entry on the running container only probes: absent never re-execs.
    rejected.container.execHandler = cmd =>
      makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    await expect(launch(rejected.instance, REF_A)).rejects.toThrow(
      'pending and no wrapper was found'
    );
    expect(rejected.container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
  });

  it('waits one poll interval before retrying a fast terminal wrapper exit', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = sleepPreExec();
    let buns = 0;
    const bunStarts: number[] = [];
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') return makeExecProcess({ exitCode: 1 });
      buns += 1;
      bunStarts.push(Date.now() - startedAt);
      return buns === 1 ? makeExecProcess({ pid: 0, exitCode: 1 }) : makeExecProcess({ pid: 2 });
    };

    const pending = launch(instance, REF_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(buns).toBe(1);

    // A fast terminal exit waits a full poll interval before the retry probe.
    await vi.advanceTimersByTimeAsync(999);
    expect(buns).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ started: true });

    expect(buns).toBe(2);
    expect(bunStarts[1]).toBeGreaterThanOrEqual((bunStarts[0] ?? 0) + 1_000);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('does not start or exec when the container stops during the absent probe', async () => {
    const { instance, container, readRecord } = sleepPreExec();
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        container.running = false;
        return makeExecProcess({ exitCode: 1 });
      }
      return makeExecProcess({ exitCode: 0 });
    };

    await expect(launch(instance, REF_A)).rejects.toThrow(
      'Container stopped before the wrapper exec'
    );

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'not_started',
    });
  });

  it('rolls the fence back to not_started when the exec_pending write returns past the deadline', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord, setPutGate, releaseHeldPut } = sleepPreExec();
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    setPutGate(value =>
      (value as { wrapperAttempt?: string }).wrapperAttempt === 'exec_pending' ? 'hold' : 'pass'
    );

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90_000);
    releaseHeldPut();

    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'not_started',
    });
  });
});

describe('SandboxContainers sleep wrapper exec', () => {
  it('detects a wrapper that appears late while the pid-0 handle exitCode stays pending', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = sleepPreExec();
    let entryProbe = true;
    let activeProbes = 0;
    let maxActiveProbes = 0;
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        if (entryProbe) {
          entryProbe = false;
          return makeExecProcess({ exitCode: 1 });
        }
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
          resolve(makeExecProcess({ pid: 0, exitCodePromise: new Promise<number>(() => {}) }));
        }, 65_000);
      });
    };

    let settled = false;
    const pending = launch(instance, REF_A).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(settled).toBe(false);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ started: true });
    expect(maxActiveProbes).toBe(1);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(container.execCalls.at(-1)?.cmd[0]).toBe('pgrep');
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('does not retry the bun when the fresh post-completion probe is ambiguous', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = sleepPreExec();
    let entryProbe = true;
    let ambiguousProbes = 0;
    container.execHandler = cmd => {
      if (cmd[0] !== 'pgrep') {
        return makeExecProcess({
          pid: 0,
          exitCodePromise: new Promise<number>(res => setTimeout(() => res(0), 5_000)),
        });
      }
      if (entryProbe) {
        entryProbe = false;
        return makeExecProcess({ exitCode: 1 });
      }
      if (Date.now() - startedAt >= 5_000) {
        ambiguousProbes += 1;
        return makeExecProcess({ exitCode: 2 });
      }
      return makeExecProcess({ exitCode: 1 });
    };

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toBe('rejected');
    expect(ambiguousProbes).toBeGreaterThanOrEqual(1);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('discards a stale pre-completion probe and probes fresh after the handle exitCode fulfils', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = sleepPreExec();
    let resolveWrapperExit!: (code: number) => void;
    let resolveFirstProbeExit!: (code: number) => void;
    let pgrepExecs = 0;
    let buns = 0;
    let activeProbes = 0;
    let maxActiveProbes = 0;
    const pgrepStarts: number[] = [];
    const pgrepSettles: number[] = [];

    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        pgrepExecs += 1;
        if (pgrepExecs === 1) return makeExecProcess({ exitCode: 1 });
        pgrepStarts.push(Date.now() - startedAt);
        activeProbes += 1;
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
        const exitCode = new Promise<number>(resolve => {
          if (pgrepExecs === 2) resolveFirstProbeExit = resolve;
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
    expect(pgrepExecs).toBe(2);

    await vi.advanceTimersByTimeAsync(40_000);
    resolveWrapperExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(pgrepExecs).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    resolveFirstProbeExit(1);
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toBe('resolved');
    expect(buns).toBe(1);
    expect(pgrepExecs).toBe(3);
    expect(maxActiveProbes).toBe(1);
    expect(pgrepStarts[1] ?? -1).toBeGreaterThanOrEqual(pgrepSettles[0] ?? Number.MAX_SAFE_INTEGER);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('does not overlap a pgrep whose native call is unsettled, even when the handle exitCode settles', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = sleepPreExec();
    let resolveHandleExit!: (code: number) => void;
    let pgrepCalls = 0;
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        pgrepCalls += 1;
        if (pgrepCalls === 1) return makeExecProcess({ exitCode: 1 });
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
    expect(pgrepCalls).toBe(2);
    resolveHandleExit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(pgrepCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(40_000);
    await expect(outcome).resolves.toBe('rejected');
    expect(pgrepCalls).toBe(2);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('rejects a found probe when the retained handle exitCode rejected while it was pending', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = sleepPreExec();
    let rejectHandleExit!: (error: Error) => void;
    let resolveProbe!: (proc: ExecProcess) => void;
    let entryProbe = true;
    container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') {
        if (entryProbe) {
          entryProbe = false;
          return makeExecProcess({ exitCode: 1 });
        }
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
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('bounds a probe by the remaining budget and queues no probe behind a hung exitCode', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = sleepPreExec();
    let entryProbe = true;
    let pgrepCalls = 0;
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
      if (entryProbe) {
        entryProbe = false;
        return makeExecProcess({ exitCode: 1 });
      }
      if (Date.now() - startedAt >= 88_000) {
        hungProbes += 1;
        hungAtElapsed = Date.now() - startedAt;
        return makeExecProcess({ exitCodePromise: new Promise<number>(() => {}) });
      }
      return makeExecProcess({ exitCode: 1 });
    };

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(89_000);
    expect(hungProbes).toBe(1);
    expect(hungAtElapsed).toBe(88_000);
    const probesAt89 = pgrepCalls;

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('rejected');
    expect(pgrepCalls).toBe(probesAt89);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      wrapperAttempt: 'exec_pending',
    });
  });

  it('does not start a pgrep when the final sleep lands on the deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { instance, container, readRecord } = sleepPreExec();
    const execStarts: number[] = [];
    const pgrepStarts: number[] = [];
    let entryProbe = true;
    container.execHandler = cmd => {
      const elapsed = Date.now() - startedAt;
      if (cmd[0] === 'pgrep') {
        if (entryProbe) {
          entryProbe = false;
          return makeExecProcess({ exitCode: 1 });
        }
        pgrepStarts.push(elapsed);
        return makeExecProcess({
          exitCodePromise: new Promise<number>(res => setTimeout(() => res(1), 700)),
        });
      }
      execStarts.push(elapsed);
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
    // The final sleep lands on the deadline; no exec or probe may start at or after it.
    expect(execStarts.filter(start => start >= 90_000)).toEqual([]);
    expect(pgrepStarts.filter(start => start >= 90_000)).toEqual([]);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
  });

  it('keeps the pending fence when the post-deadline rollback write fails', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord, setPutGate, releaseHeldPut } = sleepPreExec();
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    setPutGate(value =>
      (value as { wrapperAttempt?: string }).wrapperAttempt === 'exec_pending' ? 'hold' : 'pass'
    );

    const pending = launch(instance, REF_A);
    const outcome = pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    await vi.advanceTimersByTimeAsync(90_000);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);

    // The rollback write fails; the durable exec_pending fence must remain.
    setPutGate(value =>
      (value as { wrapperAttempt?: string }).wrapperAttempt === 'not_started' ? 'fail' : 'pass'
    );
    releaseHeldPut();
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toBe('rejected');
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
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
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
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
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
  });

  it('repairs a stopping record that lacks a stop op id and destroys without snapshotting', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'stopping', allocationRef: REF_A, stopOpId: null },
    });

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    expect(container.snapshotCalls).toBe(0);
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toMatchObject({
      state: 'idle',
      allocationRef: null,
      lastSnapshot: null,
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
  it('destroys without snapshotting and keeps an already stored snapshot untouched', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        lastSnapshot: { id: 'old-snap', sourceAllocation: REF_A },
      },
    });
    container.running = true;

    const result = await instance.stop(REF_A);

    expect(result).toBe('terminal');
    expect(container.snapshotCalls).toBe(0);
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toEqual({
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: { id: 'old-snap', sourceAllocation: REF_A },
    });
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

    container.destroyBehavior = 'deferred';
    let second: 'terminal' | 'retryable' | undefined;
    const secondStop = instance.stop(REF_A).then(result => {
      second = result;
    });

    await vi.waitFor(() => expect(container.destroyCalls).toBe(2));
    expect(second).toBeUndefined();
    expect(readRecord().stopOpId).toBe(persistedOpId);

    container.deferredDestroy?.resolve();
    await secondStop;

    expect(second).toBe('terminal');
    expect(container.snapshotCalls).toBe(0);
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
      lastSnapshot: null,
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
      lastSnapshot: null,
    });
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
