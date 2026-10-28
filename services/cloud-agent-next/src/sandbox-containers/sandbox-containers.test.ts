import { preinstalledStartup } from '../sandbox-control/preinstalled-startup.js';
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
  ENVIRONMENT_BUILDER_PATH,
} from '../sandbox-control/container-paths.js';
import { RUNTIME_BUN_PATH } from '../shared/runtime-distribution.js';
import { logger } from '../logger.js';
import {
  SandboxContainers,
  type ContainerInstanceSize,
  type ContainersObservation,
} from './SandboxContainers.js';
import {
  PREVIEW_MARKER_ALLOCATION_HEADER,
  PREVIEW_MARKER_PORT_HEADER,
} from '../shared/preview-headers.js';
import type { Env } from '../types.js';
import type { ContainersOutboundProps } from './containers-outbound.js';

// The fake proves coordinator ordering only. It does not prove that exec behaves as assumed, and it
// fails any attempt to snapshot the container so a stop that snapshots cannot pass silently.
const RECORD_KEY = 'containers:record:v1';
const SNAPSHOT_SIZE = 1_234_567;
const REF_A = 'ref-a';
const REF_B = 'ref-b';

type StoredRecord = {
  state: 'idle' | 'launching' | 'running' | 'stopping';
  allocationRef: string | null;
  stopOpId?: string | null;
  lastSnapshot?: { id: string; sourceAllocation: string } | null;
  startSource?: 'image' | 'repository';
  startImage?: string;
  instance?: ContainerInstanceSize;
  billingConfigured?: true;
  wrapperAttempt?: string;
  repositoryStartFailures?: { snapshotId: string; attempts: number };
  egressPolicy?: { allocationRef: string; allowlist: string[] };
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
  snapshotBehavior:
    | { kind: 'resolve'; id: string }
    | { kind: 'reject'; error?: Error }
    | { kind: 'deferred' } = { kind: 'resolve', id: 'snap-1' };
  deferredSnapshots: Array<{
    resolve: (id: string) => void;
    reject: (error: Error) => void;
  }> = [];
  destroyCalls = 0;
  monitorCalls = 0;
  inspectCalls = 0;
  leaseCalls: number[] = [];
  runningAtDestroy: boolean[] = [];
  // PID 1 as seen through `/proc/1/cmdline`. A manual `running = true` models the
  // deployed `sleep infinity` main process; `start()` with the native entrypoint
  // models the supervisor main process.
  mainProcess: 'sleep' | 'supervisor' | 'environment-builder' | 'ambiguous' = 'sleep';
  // A runtime installer start (`/bin/sh -c <launch>`): hand off to the entry point
  // named in the launch, or exit with this code so `monitor()` rejects.
  runtimeOutcome: { kind: 'handoff' } | { kind: 'exit'; code: number } = { kind: 'handoff' };
  private exitError: Error | undefined;
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
    this.exitError = undefined;
    const entrypoint = options?.entrypoint ?? [];
    if (entrypoint.includes(CONTROL_SUPERVISOR_PATH)) {
      this.mainProcess = this.identityAfterStart;
    } else if (entrypoint.includes(ENVIRONMENT_BUILDER_PATH)) {
      this.mainProcess = 'environment-builder';
    } else if (entrypoint[1] === '-c') {
      if (this.runtimeOutcome.kind === 'exit') {
        this.running = false;
        this.exitError = new Error(
          `Container exited with unexpected exit code: ${this.runtimeOutcome.code}`
        );
      } else {
        this.mainProcess = entrypoint[2]?.includes('kilocode-environment-builder.js')
          ? 'environment-builder'
          : this.identityAfterStart;
      }
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
            : this.mainProcess === 'environment-builder'
              ? `${RUNTIME_BUN_PATH}\0${ENVIRONMENT_BUILDER_PATH}`
              : 'sleep\0infinity',
      });
    }
    return this.execHandler(cmd);
  }

  async snapshotContainer(_options: ContainerSnapshotOptions): Promise<ContainerSnapshot> {
    this.snapshotCalls += 1;
    if (this.snapshotBehavior.kind === 'reject')
      throw this.snapshotBehavior.error ?? new Error('snapshot failed');
    if (this.snapshotBehavior.kind === 'resolve')
      return { id: this.snapshotBehavior.id, size: SNAPSHOT_SIZE };
    return new Promise((resolve, reject) =>
      this.deferredSnapshots.push({
        resolve: id => resolve({ id, size: SNAPSHOT_SIZE }),
        reject,
      })
    );
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

  tcpPortCalls = 0;

  getTcpPort(_port: number): { fetch: (url: string, request: Request) => Promise<Response> } {
    this.tcpPortCalls += 1;
    return { fetch: async () => new Response('preview', { status: 200 }) };
  }

  async monitor(): Promise<void> {
    this.monitorCalls += 1;
    if (this.exitError) throw this.exitError;
    if (!this.stopAfterStart) await new Promise<void>(() => {});
  }

  async inspect(): Promise<ContainerInfo> {
    this.inspectCalls += 1;
    return { image: 'registry.example/kilo/app:test', labels: {} };
  }
}

type PutDecision = 'pass' | 'hold' | 'fail';

function setup(
  options: {
    record?: StoredRecord;
    attachContainer?: boolean;
    running?: boolean;
    env?: Partial<Env> & { CONTROL_PLANE_TIMER_DIVISOR?: string };
  } = {}
) {
  const container = new FakeContainer();
  container.running = options.running ?? false;
  let alarm: number | undefined;
  const pendingTasks: Promise<unknown>[] = [];
  let putGate: ((value: unknown) => PutDecision) | undefined;
  let releaseHeldPut: (() => void) | undefined;
  const storage = {
    map: new Map<string, unknown>(),
    async get<T>(key: string): Promise<T | undefined> {
      return storage.map.get(key) as T | undefined;
    },
    async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
      if (typeof key !== 'string') {
        for (const [entryKey, entryValue] of Object.entries(key)) {
          await storage.put(entryKey, entryValue);
        }
        return;
      }
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
    async delete(key: string | string[]): Promise<boolean | number> {
      if (Array.isArray(key)) return key.filter(entry => storage.map.delete(entry)).length;
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
  const blockConcurrencyWhile = vi.fn(async (fn: () => Promise<unknown>) => fn());
  const ctx = {
    storage,
    id: { toString: () => 'do-id' },
    container: options.attachContainer === false ? undefined : container,
    blockConcurrencyWhile,
    waitUntil: (promise: Promise<unknown>) => {
      pendingTasks.push(promise);
    },
  } as unknown as DurableObjectState;
  const instance = new SandboxContainers(ctx, (options.env ?? {}) as Env);
  const readRecord = () => storage.map.get(RECORD_KEY) as StoredRecord;
  return {
    storage,
    container,
    instance,
    readRecord,
    pendingTasks,
    blockConcurrencyWhile,
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
  return instance.launchWrapper({
    command: preinstalledStartup(),
    allocationRef,
    env,
    instance: 'standard-4',
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('supplied startup command', () => {
  const command = { argv: ['/bin/sh', '-c', 'exec /opt/selected/start "two words"'] };

  it.each(['image', 'repository'] as const)('starts the supplied command from %s', async source => {
    const { instance, container, readRecord } = setup();
    container.cmdlineRaw = `${command.argv.join('\0')}\0`;

    await expect(
      source === 'repository'
        ? launchFromSnapshot(instance, REF_A, { command })
        : instance.launchWrapper({ allocationRef: REF_A, command, env: {}, instance: 'standard-4' })
    ).resolves.toEqual({
      started: true,
      startSource: source,
    });
    expect(container.startCalls[0]?.entrypoint).toEqual(command.argv);
    if (source === 'repository')
      expect(container.startCalls[0]?.containerSnapshot).toEqual({ id: 'snap-env' });
    expect(container.execCalls.map(call => call.cmd)).toEqual([['cat', '/proc/1/cmdline']]);
    expect(readRecord().state).toBe('running');
  });

  it('starts the code-review instance at the legacy code-review capacity', async () => {
    const { instance, container } = setup();
    container.cmdlineRaw = `${preinstalledStartup().argv.join('\0')}\0`;

    await expect(
      instance.launchWrapper({
        allocationRef: REF_A,
        command: preinstalledStartup(),
        env: {},
        instance: 'code-review',
      })
    ).resolves.toMatchObject({ started: true });

    expect(container.startCalls[0]?.instance).toEqual({
      vcpu: 1,
      memoryMib: 4_096,
      diskMb: 8_000,
    });
  });

  it('accepts the stable supervisor after the supplied command execs it', async () => {
    const { instance, container } = setup();
    container.cmdlineRaw = `/bin/sh\0${CONTROL_SUPERVISOR_PATH}\0`;
    await expect(
      instance.launchWrapper({ allocationRef: REF_A, command, env: {}, instance: 'standard-3' })
    ).resolves.toMatchObject({ started: true });
    expect(container.startCalls[0]?.entrypoint).toEqual(command.argv);
  });

  it('execs the supplied command when a pre-exec launch still has sleep as PID 1', async () => {
    const { instance, container, readRecord } = setup({
      running: true,
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'not_started',
      },
    });
    container.execHandler = cmd =>
      makeExecProcess({ pid: 42, exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    await expect(
      instance.launchWrapper({
        allocationRef: REF_A,
        command,
        env: { CALLER: 'test' },
        instance: 'standard-3',
      })
    ).resolves.toMatchObject({ started: true });
    expect(container.startCalls).toEqual([]);
    expect(container.execCalls.at(-1)).toMatchObject({
      cmd: command.argv,
      options: { env: { CALLER: 'test' } },
    });
    expect(readRecord().state).toBe('running');
  });
});

type LogLine = { level: string; fields: Record<string, unknown>; message: string };

/** Record every structured log line; `diagnostics(event)` narrows to one control diagnostic. */
function captureLogs() {
  const lines: LogLine[] = [];
  vi.spyOn(logger, 'withFields').mockImplementation(((fields: Record<string, unknown>) => ({
    info: (message: string) => lines.push({ level: 'info', fields, message }),
    warn: (message: string) => lines.push({ level: 'warn', fields, message }),
    error: (message: string) => lines.push({ level: 'error', fields, message }),
  })) as unknown as typeof logger.withFields);
  return {
    lines,
    diagnostics: (event: string) => lines.filter(line => line.fields.diagnosticEvent === event),
  };
}

function attachOutbound(instance: SandboxContainers) {
  const outbound = vi.fn((options: { props: ContainersOutboundProps }) => options.props);
  (
    instance as unknown as { ctx: { exports: { ContainersOutbound: typeof outbound } } }
  ).ctx.exports = { ContainersOutbound: outbound };
  return outbound;
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

describe('SandboxContainers egress enforcement', () => {
  it.each([{ egressAllowlist: [] }, { egressAllowlist: ['Example.COM.', 'example.com'] }])(
    'restricts a native image start independently of credential containment: %j',
    async ({ egressAllowlist }) => {
      const { instance, container, readRecord } = setup();
      const outbound = attachOutbound(instance);
      await instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: { EGRESS_ALLOWLIST: '*' },
        instance: 'standard-3',
        egressAllowlist,
      });

      const expectedPolicy = egressAllowlist.length === 0 ? [] : ['example.com'];
      expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'start', 'exec:cat']);
      expect(container.startCalls[0]).toMatchObject({
        enableInternet: false,
        env: {
          SANDBOX_INTERCEPT_HTTPS: '1',
          NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
        },
      });
      expect(outbound).toHaveBeenCalledWith({
        props: { containerId: 'do-id', egressAllowlist: expectedPolicy },
      });
      expect(readRecord().egressPolicy).toEqual({
        allocationRef: REF_A,
        allowlist: expectedPolicy,
      });
    }
  );

  it('retains unrestricted starts when no policy or containment is supplied', async () => {
    const { instance, container } = setup();
    await launch(instance, REF_A);
    expect(container.calls).toEqual(['start', 'exec:cat']);
    expect(container.startCalls[0]?.enableInternet).toBe(true);
  });

  it.each(['interceptOutboundHttps', 'interceptAllOutboundHttp'] as const)(
    'never starts a restricted container when %s fails',
    async method => {
      const { instance, container } = setup();
      attachOutbound(instance);
      vi.spyOn(container, method).mockRejectedValue(new Error('interceptor unavailable'));
      await expect(
        instance.launchWrapper({
          command: preinstalledStartup(),
          allocationRef: REF_A,
          env: {},
          instance: 'standard-3',
          egressAllowlist: [],
        })
      ).rejects.toThrow('interceptor unavailable');
      expect(container.startCalls).toHaveLength(0);
    }
  );

  it('reinstalls trusted props on same-allocation retries after Durable Object reconstruction', async () => {
    const initial = setup();
    attachOutbound(initial.instance);
    await initial.instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
      egressAllowlist: ['example.com'],
    });
    const restored = setup({ record: initial.readRecord(), running: true });
    const outbound = attachOutbound(restored.instance);
    await restored.instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
      egressAllowlist: ['EXAMPLE.COM.'],
    });
    expect(restored.container.calls).toEqual(['https-intercept', 'http-intercept']);
    expect(outbound).toHaveBeenCalledWith({
      props: { containerId: 'do-id', egressAllowlist: ['example.com'] },
    });
    expect(restored.readRecord().egressPolicy?.allowlist).toEqual(['example.com']);
  });

  it.each(
    [undefined, [], ['other.test'], ['example.com', 'other.test']].map(egressAllowlist => ({
      egressAllowlist,
    }))
  )(
    'rejects policy changes on a restricted running allocation: %j',
    async ({ egressAllowlist }) => {
      const { instance, container, readRecord } = setup({
        record: {
          ...idleRecord,
          allocationRef: REF_A,
          state: 'running',
          egressPolicy: { allocationRef: REF_A, allowlist: ['example.com'] },
        },
        running: true,
      });
      await expect(
        instance.launchWrapper({
          command: preinstalledStartup(),
          allocationRef: REF_A,
          env: {},
          instance: 'standard-3',
          egressAllowlist,
        })
      ).rejects.toThrow('egress policy cannot change');
      expect(container.calls).toEqual([]);
      expect(readRecord().egressPolicy?.allowlist).toEqual(['example.com']);
    }
  );

  it('rejects attempts to retrofit runtime network isolation onto an unrestricted allocation', async () => {
    const { instance, container } = setup({
      record: { ...idleRecord, allocationRef: REF_A, state: 'running' },
      running: true,
    });
    await expect(
      instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: {},
        instance: 'standard-3',
        egressAllowlist: [],
      })
    ).rejects.toThrow('egress policy cannot change');
    expect(container.calls).toEqual([]);
  });

  it('rejects restricted fresh launches when an unowned physical container is already running', async () => {
    const { instance, container } = setup({ running: true });
    await expect(
      instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: {},
        instance: 'standard-3',
        egressAllowlist: [],
      })
    ).rejects.toThrow('unowned running container');
    expect(container.calls).toEqual([]);
  });

  it.each(
    [null, '*', ['*.example.com'], ['127.0.0.1']].map(egressAllowlist => ({ egressAllowlist }))
  )('fails closed before start for invalid policy %j', async ({ egressAllowlist }) => {
    const { instance, container } = setup();
    await expect(
      instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: {},
        instance: 'standard-3',
        egressAllowlist,
      } as never)
    ).rejects.toThrow();
    expect(container.calls).toEqual([]);
  });

  it('fails closed for invalid persisted policy instead of re-registering unrestricted props', async () => {
    const { instance, container } = setup({
      record: {
        ...idleRecord,
        allocationRef: REF_A,
        state: 'running',
        egressPolicy: { allocationRef: REF_A, allowlist: ['*'] },
      },
      running: true,
    });
    await expect(launch(instance, REF_A)).rejects.toThrow();
    expect(container.calls).toEqual([]);
  });

  it('retains policy after an ambiguous native start and rejects removal before adoption', async () => {
    const { instance, container, readRecord } = setup();
    attachOutbound(instance);
    container.startBehavior = 'effect-then-reject';
    const input = {
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3' as const,
      egressAllowlist: ['example.com'],
    };
    await expect(instance.launchWrapper(input)).rejects.toThrow('start failed');
    expect(readRecord()).toMatchObject({
      egressPolicy: { allocationRef: REF_A, allowlist: ['example.com'] },
      wrapperAttempt: 'exec_pending',
    });
    await expect(launch(instance, REF_A)).rejects.toThrow('egress policy cannot change');
    await expect(instance.launchWrapper(input)).resolves.toMatchObject({ started: true });
    expect(container.startCalls).toHaveLength(1);
    expect(container.startCalls[0]?.enableInternet).toBe(false);
  });

  it('retains enforcement on stopped pre-exec resume', async () => {
    const { instance, container } = setup({
      record: {
        ...idleRecord,
        allocationRef: REF_A,
        state: 'launching',
        wrapperAttempt: 'not_started',
        egressPolicy: { allocationRef: REF_A, allowlist: [] },
      },
    });
    attachOutbound(instance);
    await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
      egressAllowlist: [],
    });
    expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'start', 'exec:cat']);
    expect(container.startCalls[0]?.enableInternet).toBe(false);
  });

  it('retains trust and props on a running pre-exec resume', async () => {
    const { instance, container } = sleepPreExec({
      ...idleRecord,
      allocationRef: REF_A,
      state: 'launching',
      wrapperAttempt: 'not_started',
      egressPolicy: { allocationRef: REF_A, allowlist: ['example.com'] },
    });
    const outbound = attachOutbound(instance);
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
      egressAllowlist: ['example.com'],
    });
    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls.at(-1)?.options?.env).toMatchObject({
      SANDBOX_INTERCEPT_HTTPS: '1',
    });
    expect(outbound).toHaveBeenCalledWith({
      props: { containerId: 'do-id', egressAllowlist: ['example.com'] },
    });
  });

  it('allows policy replacement only after destroying the previous allocation', async () => {
    const { instance, container, readRecord } = setup();
    attachOutbound(instance);
    await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
      egressAllowlist: [],
    });
    await launch(instance, REF_B);
    expect(container.destroyCalls).toBe(1);
    expect(container.startCalls.map(options => options.enableInternet)).toEqual([false, true]);
    expect(readRecord().egressPolicy).toBeUndefined();
  });

  it('rejects policy removal after stop when retrying the same allocation reference', async () => {
    const { instance, container, readRecord } = setup();
    attachOutbound(instance);
    const input = {
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3' as const,
      egressAllowlist: [],
    };
    await instance.launchWrapper(input);
    await expect(instance.stop(REF_A)).resolves.toBe('terminal');
    expect(readRecord()).toMatchObject({
      state: 'idle',
      allocationRef: null,
      egressPolicy: { allocationRef: REF_A, allowlist: [] },
    });
    await expect(launch(instance, REF_A)).rejects.toThrow('egress policy cannot change');
    await expect(instance.launchWrapper(input)).resolves.toMatchObject({ started: true });
    expect(container.startCalls.map(options => options.enableInternet)).toEqual([false, false]);
  });
});

describe('SandboxContainers launch', () => {
  it('fresh idle+missing starts natively with the supervisor entrypoint, gate and CA, and never execs the supervisor', async () => {
    const { instance, container, readRecord } = setup();
    attachOutbound(instance);

    const result = await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: { FOO: 'bar' },
      instance: 'standard-4',
      containment: true,
    });

    expect(result).toEqual({ started: true, startSource: 'image' });
    expect(container.startCalls).toEqual([
      nativeStartOptions('standard-4', {
        FOO: 'bar',
        SANDBOX_INTERCEPT_HTTPS: '1',
        NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      }),
    ]);
    // The only exec is the PID 1 identity read; there is no supervisor exec.
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
    expect(container.monitorCalls).toBe(1);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(readRecord().wrapperAttempt).toBeUndefined();

    const again = await launch(instance, REF_A, { FOO: 'bar' });
    expect(again).toEqual({ started: false, startSource: 'image' });
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

    await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_B,
      env: {},
      instance: 'standard-3',
    });

    const options = container.startCalls[0] as Record<string, unknown>;
    expect(options).toEqual(nativeStartOptions('standard-3'));
    expect('containerSnapshot' in options).toBe(false);
    expect(container.inspectCalls).toBe(0);
  });

  it('installs the Kilo and git outbound proxy before a contained native start', async () => {
    const { instance, container } = setup();
    attachOutbound(instance);

    await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: { FOO: 'bar' },
      instance: 'standard-4',
      containment: true,
    });

    expect(container.httpsIntercepts).toEqual(['*']);
    expect(container.httpIntercepts).toEqual(['*']);
    expect(container.startCalls).toHaveLength(1);
    // Containment precedes start, and the identity read is the only post-start exec.
    expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'start', 'exec:cat']);
    expect(container.execCalls[0]?.options?.env).toBeUndefined();
  });

  it('resumes a contained pre-exec launch into a wrapper that carries the intercept env', async () => {
    const { instance, container, readRecord } = sleepPreExec();
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === 'pgrep' ? 1 : 0 });
    attachOutbound(instance);

    await expect(
      instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: { FOO: 'bar' },
        instance: 'standard-4',
        containment: true,
      })
    ).resolves.toEqual({ started: true, startSource: 'image' });

    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep', '/bin/sh']);
    expect(container.calls).toEqual([
      'https-intercept',
      'http-intercept',
      'exec:cat',
      'exec:pgrep',
      'exec:/bin/sh',
    ]);
    expect(container.execCalls.at(-1)?.options?.env).toEqual({
      FOO: 'bar',
      ...NATIVE_GATE_ENV,
      SANDBOX_INTERCEPT_HTTPS: '1',
      NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
    });
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

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
    await expect(pending).resolves.toEqual({ started: true, startSource: 'image' });
    expect(maxActiveProbes).toBe(1);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(1);
    expect(container.execCalls.at(-1)?.cmd[0]).toBe('pgrep');
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

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
    await expect(pending).resolves.toEqual({ started: true, startSource: 'image' });
    expect(buns).toBe(2);
    expect(container.execCalls.at(-1)?.cmd[0]).toBe('/bin/sh');
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
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
    await expect(pending).resolves.toEqual({ started: true, startSource: 'image' });

    expect(buns).toBe(2);
    expect(bunStarts[1]).toBeGreaterThanOrEqual((bunStarts[0] ?? 0) + 1_000);
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
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-3',
    });

    expect(resumed).toEqual({ started: true, startSource: 'image' });
    expect(container.startCalls).toEqual([nativeStartOptions('standard-3')]);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
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

  it('serialises concurrent launches so the later allocation replaces the earlier one', async () => {
    const { instance, container, readRecord } = setup();

    await expect(Promise.all([launch(instance, REF_A), launch(instance, REF_B)])).resolves.toEqual([
      { started: true, startSource: 'image' },
      { started: true, startSource: 'image' },
    ]);

    expect(container.calls).toEqual(['start', 'exec:cat', 'start', 'exec:cat']);
    expect(container.runningAtDestroy).toEqual([true]);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_B });
  });

  it('replaces a launch left behind by an abandoned allocation instead of refusing every later one', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        wrapperAttempt: 'exec_pending',
        startSource: 'repository',
        instance: 'standard-4',
      },
      running: true,
    });

    await expect(launch(instance, REF_B)).resolves.toEqual({
      started: true,
      startSource: 'image',
    });

    expect(container.runningAtDestroy).toEqual([true]);
    expect(container.startCalls).toEqual([nativeStartOptions('standard-4')]);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_B });
    expect(readRecord().wrapperAttempt).toBeUndefined();
    await expect(instance.stop(REF_A)).resolves.toBe('terminal');
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_B });
  });

  it('fails a superseding launch without starting when the leftover cannot be destroyed, and recovers on the next launch', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A },
      running: true,
    });
    container.destroyBehavior = 'reject';

    await expect(launch(instance, REF_B)).rejects.toThrow(
      'Container from a superseded allocation could not be destroyed'
    );
    expect(container.startCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'stopping', allocationRef: REF_A });

    container.destroyBehavior = 'ok';
    await expect(launch(instance, 'ref-c')).resolves.toEqual({
      started: true,
      startSource: 'image',
    });
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: 'ref-c' });
  });
});

describe('SandboxContainers wrapper attempt gate', () => {
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
        instance: 'standard-3',
        wrapperAttempt: 'exec_pending',
      },
    });
    container.running = true;

    await expect(launch(instance, REF_A)).resolves.toEqual({
      started: false,
      startSource: 'image',
    });

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls).toHaveLength(0);
    expect(readRecord()).toMatchObject({
      state: 'running',
      allocationRef: REF_A,
      instance: 'standard-3',
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
          instance: 'standard-3',
          ...(wrapperAttempt === undefined ? {} : { wrapperAttempt }),
        },
      });
      container.running = true;
      container.execHandler = () => makeExecProcess({ exitCode: 0 });
      attachOutbound(instance);

      await expect(
        instance.launchWrapper({
          command: preinstalledStartup(),
          allocationRef: REF_A,
          env: {},
          instance: 'standard-4',
          containment: true,
        })
      ).resolves.toEqual({ started: true, startSource: 'image' });

      expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
      expect(container.calls).toEqual([
        'https-intercept',
        'http-intercept',
        'exec:cat',
        'exec:pgrep',
      ]);
      expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
      expect(readRecord()).toMatchObject({
        state: 'running',
        allocationRef: REF_A,
        instance: 'standard-3',
        wrapperAttempt: 'exec_pending',
      });
    }
  });

  it('refuses a running pending or legacy record when the wrapper is absent or ambiguous', async () => {
    for (const wrapperAttempt of ['exec_pending', undefined] as const) {
      for (const exitCode of [1, 2]) {
        const { instance, container, readRecord } = setup({
          record: {
            ...idleRecord,
            state: 'launching',
            allocationRef: REF_A,
            ...(wrapperAttempt === undefined ? {} : { wrapperAttempt }),
          },
        });
        container.running = true;
        container.execHandler = () => makeExecProcess({ exitCode });

        await expect(launch(instance, REF_A)).rejects.toThrow(
          exitCode === 1 ? 'pending and no wrapper was found' : 'Wrapper probe was ambiguous'
        );
        expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat', 'pgrep']);
        expect(readRecord()).toMatchObject({
          state: 'launching',
          allocationRef: REF_A,
          wrapperAttempt: 'exec_pending',
        });
      }
    }
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
          command: preinstalledStartup(),
          allocationRef: REF_A,
          env: {},
          instance: 'standard-4',
          containment: true,
        })
      ).rejects.toThrow('pending and the container is not running');

      expect(container.startCalls).toHaveLength(0);
      expect(container.execCalls).toHaveLength(0);
      expect(container.httpsIntercepts).toHaveLength(0);
      expect(container.httpIntercepts).toHaveLength(0);
      expect(readRecord()).toMatchObject({
        state: 'launching',
        allocationRef: REF_A,
      });
    }
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
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-4',
      containment: true,
    });

    // Containment precedes the native start; identity follows it.
    expect(container.calls).toEqual(['https-intercept', 'http-intercept', 'start', 'exec:cat']);
    expect(container.httpsIntercepts).toEqual(['*']);
    expect(container.httpIntercepts).toEqual(['*']);
  });
});

describe('SandboxContainers readiness deadline', () => {
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
});

describe('SandboxContainers native start and main-process identity', () => {
  it('consumes the PID probe output without waiting separately for exitCode', async () => {
    const { instance, container, readRecord } = setup();
    const exec = container.exec.bind(container);
    vi.spyOn(container, 'exec').mockImplementation((cmd, options) => {
      if (cmd[0] !== 'cat') return exec(cmd, options);
      return Promise.resolve(
        makeExecProcess({
          exitCodePromise: new Promise<number>(() => {}),
          stdout: `/bin/sh\0${CONTROL_SUPERVISOR_PATH}\0`,
        })
      );
    });

    await expect(launch(instance, REF_A)).resolves.toEqual({
      started: true,
      startSource: 'image',
    });
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('treats a same-ref running record as a no-op and does not read identity', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A, instance: 'standard-3' },
    });
    container.running = true;

    await expect(launch(instance, REF_A)).resolves.toEqual({
      started: false,
      startSource: 'image',
    });

    expect(container.startCalls).toHaveLength(0);
    expect(container.execCalls).toHaveLength(0);
    expect(container.inspectCalls).toBe(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });
});

describe('SandboxContainers main-process identity decision table', () => {
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

      await expect(launch(instance, REF_A)).resolves.toEqual({
        started: true,
        startSource: 'image',
      });

      expect(container.startCalls).toHaveLength(0);
      expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
      expect(container.execCalls.some(call => call.cmd[0] === 'pgrep')).toBe(false);
      expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
      expect(readRecord().wrapperAttempt).toBeUndefined();
    }
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
        await expect(launch(instance, REF_A), testCase.label).resolves.toEqual({
          started: true,
          startSource: 'image',
        });
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

  it('logs the time to ready and the number of checks once PID 1 is the supervisor', async () => {
    vi.useFakeTimers();
    const { diagnostics } = captureLogs();
    const { instance, container } = setup();
    container.identityAfterStart = 'sleep';

    const pending = launch(instance, REF_A);
    await vi.advanceTimersByTimeAsync(1_500);
    container.mainProcess = 'supervisor';
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ started: true, startSource: 'image' });

    const lines = diagnostics('supervisor_confirm');
    expect(lines.map(line => [line.level, line.fields])).toEqual([
      [
        'info',
        expect.objectContaining({ result: 'ready', source: 'image', elapsedMs: 2_000, checks: 3 }),
      ],
    ]);
    expect(lines[0]?.fields).not.toHaveProperty('lastSeen');
  });

  it('logs the last PID 1 reading that completed when confirmation times out', async () => {
    vi.useFakeTimers();
    const { diagnostics } = captureLogs();
    const { instance, container } = setup();
    container.identityAfterStart = 'sleep';
    // The first read sees `sleep infinity`; every later read hangs, so the read in
    // flight at the deadline is cut off and must not hide what was last seen.
    const exec = container.exec.bind(container);
    let reads = 0;
    vi.spyOn(container, 'exec').mockImplementation((cmd, options) => {
      if (cmd[0] === 'cat' && (reads += 1) > 1) return new Promise<ExecProcess>(() => {});
      return exec(cmd, options);
    });

    const failed = expect(launch(instance, REF_A)).rejects.toThrow('wrapper exec timed out');
    await vi.advanceTimersByTimeAsync(90_000);
    await failed;

    const lines = diagnostics('supervisor_confirm');
    expect(lines.map(line => [line.level, line.fields])).toEqual([
      [
        'warn',
        expect.objectContaining({
          result: 'timeout',
          source: 'image',
          elapsedMs: 90_000,
          checks: 2,
          finalCutOff: true,
          lastSeen: 'cmdline',
          lastIdentity: 'sleep',
          lastCmdline: 'sleep_infinity',
          lastCmdlineBytes: 14,
        }),
      ],
    ]);
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
    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true, startSource: 'image' });
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls.filter(call => call.cmd[0] === '/bin/sh')).toHaveLength(0);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('lets the native PID 1 read wait for a start that is still pending', async () => {
    const { instance, container, readRecord } = setup();
    const start = container.start.bind(container);
    vi.spyOn(container, 'start').mockImplementation(options => {
      start(options);
      container.running = false;
    });
    const exec = container.exec.bind(container);
    vi.spyOn(container, 'exec').mockImplementation(async (cmd, options) => {
      // Native exec waits for an issued start. The running flag alone does not
      // distinguish this pending start from a stopped container.
      await Promise.resolve();
      container.running = true;
      return exec(cmd, options);
    });

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true, startSource: 'image' });
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
  });

  it('keeps the launch deadline while native startup remains pending', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    const start = container.start.bind(container);
    vi.spyOn(container, 'start').mockImplementation(options => {
      start(options);
      container.running = false;
    });
    vi.spyOn(container, 'exec').mockImplementation(() => new Promise<ExecProcess>(() => {}));

    const failed = expect(
      instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: {},
        instance: 'standard-4',
        deadlineAt: Date.now() + 5_000,
      })
    ).rejects.toThrow('wrapper exec timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(container.startCalls).toHaveLength(1);
    expect(readRecord()).toMatchObject({ state: 'launching', wrapperAttempt: 'exec_pending' });
  });

  it('retries a not-started read while the native lifecycle remains pending', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    const start = container.start.bind(container);
    vi.spyOn(container, 'start').mockImplementation(options => {
      start(options);
      container.running = false;
    });
    const exec = container.exec.bind(container);
    let reads = 0;
    vi.spyOn(container, 'exec').mockImplementation((cmd, options) => {
      if (++reads < 3) return Promise.reject(new Error('The container has not been started'));
      container.running = true;
      return exec(cmd, options);
    });

    const completed = launch(instance, REF_A);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(completed).resolves.toEqual({ started: true, startSource: 'image' });
    expect(container.startCalls).toHaveLength(1);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_A });
    expect(container.execCalls.map(call => call.cmd[0])).toEqual(['cat']);
  });

  it('fails promptly when native monitoring fails during a stalled PID 1 read', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    vi.spyOn(container, 'exec').mockImplementation(() => new Promise<ExecProcess>(() => {}));
    vi.spyOn(container, 'monitor').mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('native image unavailable')), 100);
        })
    );

    const failed = expect(launch(instance, REF_A)).rejects.toThrow(
      'stopped before the main process was confirmed'
    );
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(container.startCalls).toHaveLength(1);
    expect(readRecord()).toMatchObject({ state: 'launching', wrapperAttempt: 'exec_pending' });
  });

  it('fences the native start when the container stops before PID 1 is confirmed', async () => {
    const { diagnostics } = captureLogs();
    const { instance, container, readRecord } = setup();
    container.stopAfterStart = true;
    vi.spyOn(container, 'monitor').mockRejectedValue(new Error('native image unavailable'));
    vi.spyOn(container, 'exec').mockRejectedValue(new Error('Container is not running'));

    await expect(launch(instance, REF_A)).rejects.toThrow(
      'stopped before the main process was confirmed'
    );
    expect(diagnostics('supervisor_confirm')).toMatchObject([
      {
        level: 'warn',
        fields: {
          result: 'stopped',
          lastSeen: 'error',
          lastErrorName: 'Error',
          lastCause: 'native_image_unavailable',
        },
      },
    ]);

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
});

describe('SandboxContainers observe', () => {
  it('reports the raw observation for every state and ownership combination without starting', async () => {
    const combos: { record: StoredRecord; running: boolean; attachContainer?: boolean }[] = [
      { record: { ...idleRecord }, running: false, attachContainer: false },
      { record: { ...idleRecord }, running: true },
      { record: { ...idleRecord, state: 'launching', allocationRef: REF_A }, running: true },
      { record: { ...idleRecord, state: 'running', allocationRef: REF_A }, running: true },
      {
        record: { ...idleRecord, state: 'stopping', allocationRef: REF_A },
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
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(stopPromise).resolves.toBe('retryable');
    expect(settled).toBe('retryable');
    expect(readRecord()).toEqual({
      state: 'stopping',
      allocationRef: REF_A,
      stopOpId: expect.any(String),
      lastSnapshot: null,
    });
  });

  it('returns retryable for a stale stop while another allocation is stopping, then terminal after its destroy confirms', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'stopping', allocationRef: REF_A },
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
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null });

    await expect(launch(instance, REF_A)).resolves.toEqual({ started: true, startSource: 'image' });
    expect(container.startCalls).toHaveLength(1);
  });
});

describe('SandboxContainers lease and log', () => {
  it('restores the native lease on a new DO instance while the container is running', async () => {
    const { container, blockConcurrencyWhile, readRecord } = setup({ running: true });

    await blockConcurrencyWhile.mock.results[0]?.value;

    expect(blockConcurrencyWhile).toHaveBeenCalledOnce();
    expect(container.leaseCalls).toEqual([11 * 60_000]);
    expect(container.startCalls).toEqual([]);
    expect(container.execCalls).toEqual([]);
    expect(readRecord()).toEqual(idleRecord);
  });

  it('restores the native lease using the development timer scaling', async () => {
    const { container, blockConcurrencyWhile } = setup({
      running: true,
      env: { CONTROL_PLANE_TIMER_DIVISOR: '10' },
    });

    await blockConcurrencyWhile.mock.results[0]?.value;

    expect(container.leaseCalls).toEqual([2 * 60_000]);
  });

  it.each([true, false])(
    'does not restore a lease for a stopped or missing container (attached: %s)',
    attachContainer => {
      const { container, blockConcurrencyWhile } = setup({ attachContainer });

      expect(blockConcurrencyWhile).not.toHaveBeenCalled();
      expect(container.leaseCalls).toEqual([]);
      expect(container.startCalls).toEqual([]);
    }
  );

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

const IMAGE = 'registry.example/kilo/app:test';
const SNAPSHOT = { snapshotId: 'snap-env', baseImage: IMAGE };

function launchFromSnapshot(instance: SandboxContainers, ref: string, extra = {}) {
  return instance.launchWrapper({
    command: preinstalledStartup(),
    allocationRef: ref,
    env: {},
    instance: 'standard-4',
    snapshot: SNAPSHOT,
    ...extra,
  });
}

describe('SandboxContainers environment snapshot starts', () => {
  it('stops retrying a repeatedly failing snapshot but permits a replacement', async () => {
    const { instance, container } = setup();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      container.startBehavior = 'effect-then-reject';
      expect(await launchFromSnapshot(instance, REF_A)).toMatchObject({ snapshotFailed: true });
      await instance.stop(REF_A);
    }
    container.startBehavior = 'ok';
    expect(await launchFromSnapshot(instance, REF_A)).toMatchObject({ startSource: 'image' });
    expect(container.startCalls.at(-1)).toHaveProperty('image', IMAGE);
    await instance.stop(REF_A);
    expect(
      await launchFromSnapshot(instance, REF_A, {
        snapshot: { ...SNAPSHOT, snapshotId: 'replacement' },
      })
    ).toMatchObject({ startSource: 'repository' });
  });

  it('starts from the offered snapshot captured from the current image', async () => {
    const { diagnostics } = captureLogs();
    const { instance, container, readRecord } = setup();

    const result = await launchFromSnapshot(instance, REF_A);

    expect(result).toEqual({ started: true, startSource: 'repository' });
    const options = container.startCalls[0] as Record<string, unknown>;
    expect(options).toEqual({
      containerSnapshot: { id: 'snap-env' },
      instance: 'standard-4',
      enableInternet: true,
      entrypoint: ['/bin/sh', CONTROL_SUPERVISOR_PATH],
      env: NATIVE_GATE_ENV,
    });
    expect('image' in options).toBe(false);
    expect(readRecord()).toMatchObject({ state: 'running', startSource: 'repository' });
    expect(diagnostics('snapshot_lookup')[0].fields).toMatchObject({
      source: 'repository',
      reason: 'snapshot',
    });
    await expect(launchFromSnapshot(instance, REF_A)).resolves.toEqual({
      started: false,
      startSource: 'repository',
    });
  });

  it('starts from the image when the snapshot belongs to another image or none is offered', async () => {
    const { diagnostics } = captureLogs();
    const first = setup();
    await expect(
      launchFromSnapshot(first.instance, REF_A, {
        snapshot: { snapshotId: 'snap-old', baseImage: 'registry.example/kilo/app:previous' },
      })
    ).resolves.toEqual({ started: true, startSource: 'image' });
    expect(first.container.startCalls[0]).toEqual(nativeStartOptions('standard-4'));

    const second = setup();
    await expect(launch(second.instance, REF_A)).resolves.toEqual({
      started: true,
      startSource: 'image',
    });
    expect(diagnostics('snapshot_lookup').map(line => line.fields.reason)).toEqual([
      'image_mismatch',
      'no_snapshot',
    ]);
  });

  it('applies the same egress policy to a snapshot start and its image retry', async () => {
    vi.useFakeTimers();
    const { instance, container, readRecord } = setup();
    const outbound = attachOutbound(instance);
    container.identityAfterStart = 'ambiguous';
    const policy = { egressAllowlist: ['example.com'] };
    const pending = launchFromSnapshot(instance, REF_A, policy);
    await vi.waitFor(() => expect(container.startCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(300_000);
    expect((await pending).snapshotFailed).toBe(true);
    expect(readRecord().egressPolicy?.allowlist).toEqual(['example.com']);
    await expect(instance.stop(REF_A)).resolves.toBe('terminal');
    container.identityAfterStart = 'supervisor';
    await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-4',
      ...policy,
    });

    expect(container.startCalls.map(options => options.enableInternet)).toEqual([false, false]);
    expect(container.startCalls[0]).toMatchObject({ containerSnapshot: { id: 'snap-env' } });
    expect(container.startCalls[1]).toMatchObject({ image: IMAGE });
    expect(outbound.mock.calls.map(call => call[0].props.egressAllowlist)).toEqual([
      ['example.com'],
      ['example.com'],
    ]);
  });

  it('reports a failed snapshot start without destroying the container or counting it', async () => {
    const { instance, container, readRecord } = setup();
    container.startBehavior = 'effect-then-reject';

    await expect(launchFromSnapshot(instance, REF_A)).resolves.toEqual({
      started: false,
      startSource: 'repository',
      snapshotFailed: true,
    });
    expect(container.startCalls).toHaveLength(1);
    expect(container.destroyCalls).toBe(0);
    expect(readRecord()).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
    expect(readRecord()).not.toHaveProperty('repositoryStartFailures');
  });

  it('propagates an image start failure instead of reporting a snapshot failure', async () => {
    const { instance, container } = setup();
    container.startBehavior = 'reject';

    await expect(launch(instance, REF_A)).rejects.toThrow('container start failed');
  });

  it.each(['repository', 'image'] as const)(
    'bounds %s confirmation by its start-source timeout',
    async source => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const { diagnostics } = captureLogs();
      const { instance, container } = setup();
      container.identityAfterStart = 'ambiguous';
      const started =
        source === 'repository' ? launchFromSnapshot(instance, REF_A) : launch(instance, REF_A);
      const failed =
        source === 'repository'
          ? expect(started).resolves.toMatchObject({ snapshotFailed: true })
          : expect(started).rejects.toThrow('wrapper exec timed out');
      await vi.waitFor(() => expect(container.startCalls).toHaveLength(1));
      const budget = source === 'repository' ? 300_000 : 90_000;
      await vi.advanceTimersByTimeAsync(budget - 1_000);
      expect(container.startCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await failed;
      expect(diagnostics('supervisor_confirm')[0].fields.elapsedMs).toBe(budget);
    }
  );

  it('bounds snapshot confirmation by the supplied creation deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { diagnostics } = captureLogs();
    const { instance, container } = setup();
    container.identityAfterStart = 'ambiguous';

    const failed = expect(
      launchFromSnapshot(instance, REF_A, { deadlineAt: 15_000 })
    ).resolves.toMatchObject({ snapshotFailed: true });
    await vi.waitFor(() => expect(container.startCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(diagnostics('supervisor_confirm')[0].fields.elapsedMs).toBeGreaterThan(4_000);
    expect(diagnostics('supervisor_confirm')[0].fields.elapsedMs).toBeLessThanOrEqual(5_000);
    expect(container.destroyCalls).toBe(0);
  });

  it('does not issue an image start after its supplied deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { instance, container } = setup();

    await expect(
      instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: {},
        instance: 'standard-4',
        deadlineAt: 10_000,
      })
    ).rejects.toThrow('wrapper exec timed out');
    expect(container.startCalls).toEqual([]);
  });

  it('uses the recorded source when it resumes a launch that never started the wrapper', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        instance: 'standard-4',
        startSource: 'repository',
        wrapperAttempt: 'not_started',
      },
    });

    await expect(launchFromSnapshot(instance, REF_A)).resolves.toEqual({
      started: true,
      startSource: 'repository',
    });
    expect(container.startCalls[0]).toMatchObject({ containerSnapshot: { id: 'snap-env' } });
    expect(readRecord().startSource).toBe('repository');
  });

  it('resumes an interrupted image launch from the image even when a snapshot is offered', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        instance: 'standard-4',
        startSource: 'image',
        wrapperAttempt: 'not_started',
      },
    });

    await expect(launchFromSnapshot(instance, REF_A)).resolves.toEqual({
      started: true,
      startSource: 'image',
    });
    expect(container.startCalls[0]).toMatchObject({ image: IMAGE });
    expect(readRecord().startSource).toBe('image');
  });

  it('ignores a session snapshot left in a pre-change record and never takes one on stop', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'running',
        allocationRef: REF_A,
        lastSnapshot: { id: 'legacy-snap', sourceAllocation: 'old' },
      },
      running: true,
    });

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');
    expect(container.snapshotCalls).toBe(0);
    expect(readRecord().lastSnapshot).toEqual({ id: 'legacy-snap', sourceAllocation: 'old' });
  });
});

const RUNTIME_COMMAND = {
  argv: ['/bin/sh', '-c', 'exec /bin/sh /usr/local/bin/kilocode-control-plane-supervisor.sh'],
};

describe('SandboxContainers runtime release start', () => {
  it('runs the installer as PID 1 and confirms the supervisor after its handoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { instance, container, readRecord } = setup();

    await expect(
      instance.launchWrapper({
        allocationRef: REF_A,
        env: {},
        instance: 'standard-4',
        command: RUNTIME_COMMAND,
      })
    ).resolves.toEqual({ started: true, startSource: 'image' });

    const options = container.startCalls[0];
    expect(options?.entrypoint?.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(options?.entrypoint).toEqual(RUNTIME_COMMAND.argv);

    expect(options?.env).toMatchObject(NATIVE_GATE_ENV);
    expect(readRecord().state).toBe('running');
  });

  it('installs the selected runtime on a snapshot start too', async () => {
    const { instance, container } = setup();

    await expect(
      launchFromSnapshot(instance, REF_A, { command: RUNTIME_COMMAND })
    ).resolves.toEqual({
      started: true,
      startSource: 'repository',
    });
    expect(container.startCalls[0]).toMatchObject({ containerSnapshot: { id: 'snap-env' } });
    expect(container.startCalls[0]?.entrypoint).toEqual(RUNTIME_COMMAND.argv);
  });

  it('reports a failed snapshot start when the startup command exits', async () => {
    const { instance, container } = setup();
    container.runtimeOutcome = { kind: 'exit', code: 72 };

    await expect(
      launchFromSnapshot(instance, REF_A, { command: RUNTIME_COMMAND })
    ).resolves.toEqual({
      started: false,
      startSource: 'repository',
      snapshotFailed: true,
    });
  });

  it('throws when the installer exits with a code it does not own', async () => {
    const { instance, container } = setup();
    container.runtimeOutcome = { kind: 'exit', code: 1 };

    await expect(
      instance.launchWrapper({
        allocationRef: REF_A,
        env: {},
        instance: 'standard-4',
        command: RUNTIME_COMMAND,
      })
    ).rejects.toThrow('Container stopped before the main process was confirmed');
  });
});

const BUILDER_RUNNER = { url: 'https://worker.example/b', credential: 'builder-credential' };

function launchBuilder(instance: SandboxContainers, ref: string, extra = {}) {
  return instance.launchBuilder({
    command: { argv: [RUNTIME_BUN_PATH, ENVIRONMENT_BUILDER_PATH] },
    allocationRef: ref,
    runner: BUILDER_RUNNER,
    instance: 'standard-4',
    deadlineAt: Date.now() + 600_000,
    ...extra,
  });
}

describe('SandboxContainers environment builder', () => {
  it('starts the builder bundle as PID 1 from the image with internet egress', async () => {
    const { instance, container, readRecord } = setup();
    const outbound = attachOutbound(instance);

    await expect(launchBuilder(instance, REF_A)).resolves.toEqual({
      started: true,
      startSource: 'image',
    });
    expect(container.startCalls[0]).toEqual({
      image: IMAGE,
      instance: 'standard-4',
      enableInternet: true,
      entrypoint: [RUNTIME_BUN_PATH, ENVIRONMENT_BUILDER_PATH],
      // A snapshot keeps the start env, so the runner never travels in it.
      env: { ...NATIVE_GATE_ENV },
    });
    const delivery = container.execCalls.at(-1);
    expect(delivery?.cmd.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(delivery?.cmd[2]).toContain('umask 077');
    expect(delivery?.cmd[2]).toContain('/run/kilocode-environment-build/runner.json');
    expect(delivery?.cmd[2]).not.toContain(BUILDER_RUNNER.credential);
    expect(delivery?.options?.env).toEqual({
      KILO_BUILDER_RUNNER: JSON.stringify(BUILDER_RUNNER),
    });
    expect(outbound).not.toHaveBeenCalled();
    expect(readRecord()).toMatchObject({
      state: 'running',
      allocationRef: REF_A,
      instance: 'standard-4',
    });
    const execs = container.execCalls.length;
    await expect(launchBuilder(instance, REF_A)).resolves.toEqual({
      started: false,
      startSource: 'image',
    });
    expect(container.startCalls).toHaveLength(1);
    // The delivery script checks whether the runner was already consumed.
    expect(container.execCalls).toHaveLength(execs + 1);
  });

  it('fails the launch when the runner cannot be delivered', async () => {
    const { instance, container } = setup();
    container.execHandler = cmd => makeExecProcess({ exitCode: cmd[0] === '/bin/sh' ? 1 : 0 });

    await expect(launchBuilder(instance, REF_A)).rejects.toThrow('Builder runner delivery failed');
    container.execHandler = () => makeExecProcess({ exitCode: 0 });
    await expect(launchBuilder(instance, REF_A)).resolves.toMatchObject({ started: false });
    expect(container.startCalls).toHaveLength(1);
    expect(container.execCalls.at(-1)?.cmd[2]).toContain('runner.json.consumed');
  });

  it('runs the builder through the runtime installer when a release is selected', async () => {
    const { instance, container } = setup();

    await expect(
      launchBuilder(instance, REF_A, {
        command: {
          argv: ['/bin/sh', '-c', `exec ${RUNTIME_BUN_PATH} ${ENVIRONMENT_BUILDER_PATH}`],
        },
      })
    ).resolves.toMatchObject({
      started: true,
    });
    const script = container.startCalls[0]?.entrypoint?.[2] ?? '';
    expect(script).toContain('kilocode-environment-builder.js');
    expect(script).toContain(`exec ${RUNTIME_BUN_PATH} ${ENVIRONMENT_BUILDER_PATH}`);
  });

  it('destroys a previous builder allocation before starting the next', async () => {
    const { instance, container, readRecord } = setup({
      record: { ...idleRecord, state: 'running', allocationRef: REF_A, instance: 'standard-4' },
      running: true,
    });

    await expect(launchBuilder(instance, REF_B)).resolves.toMatchObject({ started: true });
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()).toMatchObject({ state: 'running', allocationRef: REF_B });
  });

  it('confirms a builder whose start was in flight when the DO restarted', async () => {
    const { instance, container, readRecord } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        instance: 'standard-4',
        wrapperAttempt: 'exec_pending',
      },
      running: true,
    });
    container.mainProcess = 'environment-builder';

    await expect(launchBuilder(instance, REF_A)).resolves.toEqual({
      started: true,
      startSource: 'image',
    });
    expect(container.startCalls).toEqual([]);
    expect(readRecord().state).toBe('running');
  });

  it('fails closed when an in-flight builder start shows another main process', async () => {
    const { instance, container } = setup({
      record: {
        ...idleRecord,
        state: 'launching',
        allocationRef: REF_A,
        instance: 'standard-4',
        wrapperAttempt: 'exec_pending',
      },
      running: true,
    });
    container.mainProcess = 'supervisor';

    await expect(launchBuilder(instance, REF_A)).rejects.toThrow(
      'Main process identity is ambiguous'
    );
  });
});

function runningForCapture() {
  return setup({
    record: { ...idleRecord, state: 'running', allocationRef: REF_A },
    running: true,
  });
}

describe('SandboxContainers capture by id', () => {
  it('pins capture compatibility to the running allocation image across a rollout', async () => {
    const { instance, container } = setup();
    await launch(instance, REF_A);
    container.images.app = 'registry.example/kilo/app:next';
    expect(await instance.captureSnapshot(REF_A, 'image-pin')).toMatchObject({
      status: 'stored',
      baseImage: IMAGE,
    });
  });

  it('stores the snapshot under its capture id before it replies', async () => {
    const { instance, container, storage } = runningForCapture();
    container.snapshotBehavior = { kind: 'resolve', id: 'snap-captured' };

    const result = await instance.captureSnapshot(REF_A, 'capture-1');

    expect(result).toMatchObject({
      status: 'stored',
      snapshotId: 'snap-captured',
      size: SNAPSHOT_SIZE,
      baseImage: IMAGE,
    });
    expect(storage.map.get('containers:capture:v1:capture-1')).toMatchObject({
      state: 'stored',
      snapshotId: 'snap-captured',
    });
    await expect(instance.readCapture('capture-1')).resolves.toEqual(result);
    await expect(instance.captureSnapshot(REF_A, 'capture-1')).resolves.toEqual(result);
    expect(container.snapshotCalls).toBe(1);
  });

  it('joins a capture that is still running in this isolate', async () => {
    const { instance, container } = runningForCapture();
    container.snapshotBehavior = { kind: 'deferred' };

    const first = instance.captureSnapshot(REF_A, 'capture-1');
    await vi.waitFor(() => expect(container.deferredSnapshots).toHaveLength(1));
    await expect(instance.readCapture('capture-1')).resolves.toEqual({ status: 'in_progress' });
    const second = instance.captureSnapshot(REF_A, 'capture-1');
    container.deferredSnapshots[0]?.resolve('snap-late');

    await expect(first).resolves.toMatchObject({ status: 'stored', snapshotId: 'snap-late' });
    await expect(second).resolves.toMatchObject({ status: 'stored', snapshotId: 'snap-late' });
    expect(container.snapshotCalls).toBe(1);
  });

  it('reports an issued capture whose call was lost as uncertain and never snapshots again', async () => {
    const { instance, container, storage } = runningForCapture();
    storage.map.set('containers:capture:v1:capture-1', {
      state: 'issued',
      allocationRef: REF_A,
      issuedAt: 1,
    });

    await expect(instance.readCapture('capture-1')).resolves.toEqual({
      status: 'failed',
      reason: 'uncertain',
    });
    await expect(instance.captureSnapshot(REF_A, 'capture-1')).resolves.toEqual({
      status: 'failed',
      reason: 'uncertain',
    });
    expect(container.snapshotCalls).toBe(0);
  });

  it('refuses a capture for an allocation that is not the running one', async () => {
    const { instance, container } = runningForCapture();

    await expect(instance.captureSnapshot(REF_B, 'capture-1')).resolves.toEqual({
      status: 'failed',
      reason: 'not_running',
    });
    expect(container.snapshotCalls).toBe(0);
    await expect(instance.readCapture('missing')).resolves.toBeNull();
  });

  it('stores a failed snapshot call and a capture abandoned by a stop', async () => {
    const failed = runningForCapture();
    failed.container.snapshotBehavior = { kind: 'reject' };
    await expect(failed.instance.captureSnapshot(REF_A, 'capture-1')).resolves.toEqual({
      status: 'failed',
      reason: 'snapshot_failed',
    });

    const abandoned = runningForCapture();
    abandoned.container.snapshotBehavior = { kind: 'deferred' };
    const capture = abandoned.instance.captureSnapshot(REF_A, 'capture-2');
    await vi.waitFor(() => expect(abandoned.container.deferredSnapshots).toHaveLength(1));
    await expect(abandoned.instance.stop(REF_A)).resolves.toBe('terminal');
    abandoned.container.deferredSnapshots[0]?.resolve('snap-after-stop');
    await expect(capture).resolves.toEqual({ status: 'failed', reason: 'abandoned' });
  });

  it('gives up on a capture that never finishes and does not block a stop', async () => {
    vi.useFakeTimers();
    const { instance, container } = runningForCapture();
    container.snapshotBehavior = { kind: 'deferred' };

    const capture = instance.captureSnapshot(REF_A, 'capture-1');
    await vi.waitFor(() => expect(container.deferredSnapshots).toHaveLength(1));
    await expect(instance.stop(REF_A)).resolves.toBe('terminal');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(capture).resolves.toEqual({ status: 'failed', reason: 'snapshot_failed' });
  });

  it('retains a bounded number of capture records', async () => {
    const { instance, storage } = runningForCapture();
    for (let index = 0; index < 10; index += 1) {
      await instance.captureSnapshot(REF_A, `capture-${index}`);
    }
    const kept = [...storage.map.keys()].filter(key => key.startsWith('containers:capture:v1:'));
    expect(kept).toHaveLength(8);
    expect(kept).not.toContain('containers:capture:v1:capture-0');
    expect(storage.map.get('containers:captures:v1')).toEqual(
      Array.from({ length: 8 }, (_, index) => `capture-${9 - index}`)
    );
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

describe('SandboxContainers preview fetch boundary', () => {
  const runningRecord = (): StoredRecord => ({
    ...idleRecord,
    state: 'running',
    allocationRef: REF_A,
  });

  function markedRequest(headers: Record<string, string>): Request {
    return new Request('http://localhost:5173/page', { headers });
  }

  it('answers 404 for an unmarked request without touching the container', async () => {
    const { instance, container } = setup({ record: runningRecord(), running: true });
    const response = await instance.fetch(new Request('http://localhost:5173/page'));
    expect(response.status).toBe(404);
    expect(container.tcpPortCalls).toBe(0);
  });

  it('refuses a missing allocation header with a fixed 503 before getTcpPort', async () => {
    const { instance, container } = setup({ record: runningRecord(), running: true });
    const response = await instance.fetch(markedRequest({ [PREVIEW_MARKER_PORT_HEADER]: '5173' }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('The sandbox is not running');
    expect(container.tcpPortCalls).toBe(0);
  });

  it('refuses a replacement allocation ref with 503 before getTcpPort', async () => {
    const { instance, container } = setup({ record: runningRecord(), running: true });
    const response = await instance.fetch(
      markedRequest({
        [PREVIEW_MARKER_PORT_HEADER]: '5173',
        [PREVIEW_MARKER_ALLOCATION_HEADER]: REF_B,
      })
    );
    expect(response.status).toBe(503);
    expect(container.tcpPortCalls).toBe(0);
  });

  it('refuses a stopping record with 503 before getTcpPort', async () => {
    const { instance, container } = setup({
      record: { ...runningRecord(), state: 'stopping' },
      running: true,
    });
    const response = await instance.fetch(
      markedRequest({
        [PREVIEW_MARKER_PORT_HEADER]: '5173',
        [PREVIEW_MARKER_ALLOCATION_HEADER]: REF_A,
      })
    );
    expect(response.status).toBe(503);
    expect(container.tcpPortCalls).toBe(0);
  });

  it('refuses with 503 when ctx.container is absent', async () => {
    const { instance } = setup({ record: runningRecord(), attachContainer: false });
    const response = await instance.fetch(
      markedRequest({
        [PREVIEW_MARKER_PORT_HEADER]: '5173',
        [PREVIEW_MARKER_ALLOCATION_HEADER]: REF_A,
      })
    );
    expect(response.status).toBe(503);
  });

  it('serves a running allocation and never calls the DO lease or container activity timer', async () => {
    const { instance, container } = setup({ record: runningRecord(), running: true });
    const lease = vi.spyOn(instance, 'ensureLeaseAtLeast');
    const leaseCallsBeforeFetch = container.leaseCalls.length;
    const response = await instance.fetch(
      markedRequest({
        [PREVIEW_MARKER_PORT_HEADER]: '5173',
        [PREVIEW_MARKER_ALLOCATION_HEADER]: REF_A,
      })
    );
    expect(response.status).toBe(200);
    expect(container.tcpPortCalls).toBe(1);
    expect(container.leaseCalls).toHaveLength(leaseCallsBeforeFetch);
    expect(lease).not.toHaveBeenCalled();
  });
});

describe('SandboxContainers native image selection', () => {
  const RUNTIME_FREE_IMAGE = 'registry.example/kilo/runtime-free:test';

  it('starts the baseline app image when no image is selected', async () => {
    const { instance, container, readRecord } = setup();

    await launch(instance, REF_A);

    expect(container.startCalls[0]?.image).toBe(IMAGE);
    expect(readRecord().startImage).toBe(IMAGE);
  });

  it('starts the runtime-free image when it is selected', async () => {
    const { instance, container, readRecord } = setup();
    container.images['runtime-free'] = RUNTIME_FREE_IMAGE;

    await instance.launchWrapper({
      command: preinstalledStartup(),
      allocationRef: REF_A,
      env: {},
      instance: 'standard-4',
      nativeImage: 'runtime-free',
    });

    expect(container.startCalls[0]?.image).toBe(RUNTIME_FREE_IMAGE);
    expect(readRecord()).toMatchObject({
      state: 'running',
      startSource: 'image',
      startImage: RUNTIME_FREE_IMAGE,
    });
  });

  it('fails before any physical start when the selected image is unavailable', async () => {
    const { instance, container, readRecord } = setup();

    await expect(
      instance.launchWrapper({
        command: preinstalledStartup(),
        allocationRef: REF_A,
        env: {},
        instance: 'standard-4',
        nativeImage: 'runtime-free',
      })
    ).rejects.toThrow('Container image "runtime-free" is unavailable');

    expect(container.startCalls).toEqual([]);
    expect(container.execCalls).toEqual([]);
    expect(readRecord()).toMatchObject({ state: 'idle', allocationRef: null });
  });

  it('restores only environment snapshots captured from the selected image', async () => {
    const baselineSnapshot = setup();
    baselineSnapshot.container.images['runtime-free'] = RUNTIME_FREE_IMAGE;
    await expect(
      launchFromSnapshot(baselineSnapshot.instance, REF_A, { nativeImage: 'runtime-free' })
    ).resolves.toEqual({ started: true, startSource: 'image' });
    expect(baselineSnapshot.container.startCalls[0]).toMatchObject({ image: RUNTIME_FREE_IMAGE });

    const runtimeFreeSnapshot = setup();
    runtimeFreeSnapshot.container.images['runtime-free'] = RUNTIME_FREE_IMAGE;
    await expect(
      launchFromSnapshot(runtimeFreeSnapshot.instance, REF_A, {
        nativeImage: 'runtime-free',
        snapshot: { snapshotId: 'snap-runtime-free', baseImage: RUNTIME_FREE_IMAGE },
      })
    ).resolves.toEqual({ started: true, startSource: 'repository' });
    expect(runtimeFreeSnapshot.container.startCalls[0]).toMatchObject({
      containerSnapshot: { id: 'snap-runtime-free' },
    });
    expect(runtimeFreeSnapshot.readRecord().startImage).toBe(RUNTIME_FREE_IMAGE);
  });
});
