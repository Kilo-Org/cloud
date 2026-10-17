import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  NATIVE_RETIREMENT_CAP,
  isRetired,
  nativeLaunchTokenMatches,
  nativeReceiptPath,
  nativeReceiptReadCommand,
  nativeReceiptDeleteCommand,
  pruneRetirements,
  readNativeLaunchRecord,
  readRetirements,
  recordRetirement,
  type NativeRetirementFence,
} from './native-launch.js';
import {
  bakedLaunchCommand,
  launchSandbox,
  RuntimeLaunchSettlementError,
} from '../sandbox-control/runtime-launch.js';
import type {
  RuntimeLaunchOps,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../sandbox-control/runtime-launch.js';
import { testRuntimeSelection } from '../../test/helpers/runtime-release.js';
import { runtimeLaunchReceiptPath } from '../sandbox-control/runtime-launch-receipt.js';
import { CONTROL_SUPERVISOR_PATH } from '../sandbox-control/container-paths.js';
import { repoSnapshotIndexKey } from './repo-snapshot-index.js';
import { SandboxContainers } from './SandboxContainers.js';
import { createCloudflareContainersProviderAdapter } from '../sandbox-control/cloudflare-containers-provider.js';
import { parseSandboxBillingInput } from '../container-usage-context.js';
import type { ProviderAdapter, ProviderCreateIntent } from '../sandbox-control/provider.js';
import type { Env } from '../types.js';

/**
 * The native launch contract driven through the production `launchSandbox`
 * workflow and the real provider adapter over a FakeContainer. The stateful
 * scenario table asserts required ownership, issuance, deadline, settlement and
 * acknowledgement behavior, not implementation accidents.
 */

const IMAGE = 'registry.example/kilo/app:test';
const RECORD_KEY = 'containers:record:v1';
const OUTER_DEADLINE = Date.now() + 600_000;
const REF = 'sbx-1';

type LooseRecord = {
  runtimeProtocolVersion?: 1;
  state: string;
  allocationRef: string | null;
  nativeLaunch?: {
    launchId: string;
    firstReservationAt: number;
    attemptDeadlineAt: number;
    source: { kind: string; image: string; snapshotId?: string };
    issuedAt?: number;
    start?: { kind: string };
    settled?: { result: { kind: string; reason?: string }; at: number };
    acked?: true;
  };
  retirements?: { launchId: string; until: number }[];
  repositoryStartFailures?: { snapshotId: string; attempts: number };
  egressPolicy?: { allocationRef: string; allowlist: string[] };
};

function makeExec(behavior: { exitCode?: number; stdout?: string } = {}): ExecProcess {
  return {
    pid: 1,
    exitCode: Promise.resolve(behavior.exitCode ?? 0),
    output: async () => ({
      stdout: new TextEncoder().encode(behavior.stdout ?? '').buffer,
      stderr: new ArrayBuffer(0),
      exitCode: behavior.exitCode ?? 0,
    }),
  } as unknown as ExecProcess;
}

type NativeStartBehavior = 'ok' | 'reject' | 'reject-snapshot' | 'effect-then-reject';

class NativeFakeContainer {
  running = false;
  images: Record<string, string> = { app: IMAGE };
  labels: Record<string, string> = {};
  startCalls: ContainerStartupOptions[] = [];
  execCalls: string[][] = [];
  destroyCalls = 0;
  snapshotCalls = 0;
  leaseCalls: number[] = [];
  mainProcess: 'sleep' | 'supervisor' | 'ambiguous' = 'sleep';
  identityAfterStart: 'sleep' | 'supervisor' | 'ambiguous' = 'supervisor';
  startBehavior: NativeStartBehavior = 'ok';
  receipt: string | null = null;

  start(options?: ContainerStartupOptions): void {
    this.startCalls.push(options as ContainerStartupOptions);
    if (this.startBehavior === 'reject') throw new Error('container start failed');
    if (this.startBehavior === 'reject-snapshot' && options?.containerSnapshot !== undefined) {
      throw new Error('snapshot restore rejected');
    }
    this.running = true;
    this.mainProcess = this.identityAfterStart;
    this.labels = options?.labels ?? {};
    if (this.startBehavior === 'effect-then-reject') {
      throw new Error('container start failed after taking effect');
    }
  }

  async exec(cmd: string[]): Promise<ExecProcess> {
    this.execCalls.push(cmd);
    if (cmd[0] === 'cat' && cmd[1] === '/proc/1/cmdline') {
      if (this.mainProcess === 'ambiguous') return makeExec({ exitCode: 1 });
      return makeExec({
        exitCode: 0,
        stdout:
          this.mainProcess === 'supervisor'
            ? `/bin/sh\0${CONTROL_SUPERVISOR_PATH}`
            : 'sleep\0infinity',
      });
    }
    const script = cmd[2] ?? '';
    if (script.includes('rm -f')) {
      const expected = cmd[cmd.length - 1];
      if (this.receipt === null) return makeExec({ exitCode: 1 });
      if (this.receipt !== expected) return makeExec({ exitCode: 2 });
      this.receipt = null;
      return makeExec({ exitCode: 0 });
    }
    if (script.includes('head -c')) {
      if (this.receipt === null) return makeExec({ exitCode: 1 });
      return makeExec({ exitCode: 0, stdout: this.receipt });
    }
    return makeExec({ exitCode: 0 });
  }

  async inspect(): Promise<ContainerInfo> {
    return { image: this.images.app, labels: this.labels };
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.running = false;
  }

  async interceptOutboundHttps(): Promise<void> {}
  async interceptAllOutboundHttp(): Promise<void> {}
  async setInactivityTimeout(ms: number): Promise<void> {
    this.leaseCalls.push(ms);
  }
  async isBillingBlocked(): Promise<boolean> {
    return false;
  }
  async ensureBillingAdmission(): Promise<unknown> {
    return { success: false, code: 'meter_unavailable', message: 'no meter' };
  }
  async snapshotContainer(): Promise<ContainerSnapshot> {
    this.snapshotCalls += 1;
    return { id: 'snap-cap', size: 123 };
  }
}

function fakeKv(values: Record<string, unknown> = {}): KVNamespace {
  const data = new Map(
    Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)] as const)
  );
  return {
    async get(key: string, type?: string) {
      const raw = data.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      return data.delete(key);
    },
  } as unknown as KVNamespace;
}

function setupNative(options: { record?: unknown; running?: boolean; env?: Partial<Env> } = {}) {
  const container = new NativeFakeContainer();
  container.running = options.running ?? false;
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
    async setAlarm(): Promise<void> {},
    async getAlarm(): Promise<number | null> {
      return null;
    },
    async deleteAlarm(): Promise<void> {},
  };
  storage.map.set(
    RECORD_KEY,
    options.record ?? { state: 'idle', allocationRef: null, stopOpId: null, lastSnapshot: null }
  );
  const ctx = {
    storage,
    id: { toString: () => 'do-id' },
    container,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    waitUntil: () => undefined,
  } as unknown as DurableObjectState;
  const instance = new SandboxContainers(ctx, (options.env ?? {}) as Env);
  return {
    container,
    instance,
    storage,
    readRecord: () => storage.map.get(RECORD_KEY) as LooseRecord | undefined,
  };
}

function adapterFor(instance: SandboxContainers): ProviderAdapter {
  return createCloudflareContainersProviderAdapter({
    logicalSandboxId: 'sbx-1',
    allocationName: 'sbx-1',
    instance: 'standard-3',
    getContainer: () => instance as unknown as DurableObjectStub<SandboxContainers>,
  });
}

function makeIntent(launchId: string, createDeadlineAt: number): ProviderCreateIntent {
  return {
    intentId: 'intent-1',
    createdAt: Date.now(),
    launchToken: { launchId, createDeadlineAt },
  };
}

function request(
  ops: RuntimeLaunchOps,
  launchId: string,
  extra: Partial<RuntimeLaunchRequest> = {}
): RuntimeLaunchRequest {
  return {
    ops,
    selection: { kind: 'baked' },
    allocationId: 'alloc-1',
    launchId,
    outerDeadlineAt: OUTER_DEADLINE,
    reader: { head: async () => ({ size: 1 }) },
    effects: { grantSecret: async () => 'secret', onReserved: async () => true },
    launchEnv: {},
    failureRetention: true,
    ...extra,
  };
}

async function backend(launchId = 'launch-0001') {
  const setup = setupNative();
  const adapter = adapterFor(setup.instance);
  const intent = makeIntent(launchId, OUTER_DEADLINE);
  const created = await adapter.create(intent);
  const providerRef = 'providerRef' in created ? created.providerRef : '';
  const ops = adapter.runtimeExecution!(intent)!;
  return { ...setup, adapter, intent, providerRef, ops };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(['fake', 'native'] as const)('shared launch scenario table: %s', backendName => {
  it.each([
    {
      name: 'baked handoff',
      release: false,
      receipt: 'none',
      missing: false,
      ambiguous: false,
      expected: 'handoff',
      starts: 1,
      acks: 0,
    },
    {
      name: 'release receipt plus canonical supervisor',
      release: true,
      receipt: 'handoff',
      missing: false,
      ambiguous: false,
      expected: 'handoff',
      starts: 1,
      acks: 1,
    },
    {
      name: 'typed receipt wins after possible issuance',
      release: true,
      receipt: 'failure',
      missing: false,
      ambiguous: true,
      expected: 'installer-failed',
      starts: 1,
      acks: 1,
    },
    {
      name: 'preflight failure never starts',
      release: true,
      receipt: 'none',
      missing: true,
      ambiguous: false,
      expected: 'installer-failed',
      starts: 0,
      acks: 0,
    },
  ])('$name', async scenario => {
    const launchId = 'launch-contract';
    const receipt =
      scenario.receipt === 'none'
        ? undefined
        : JSON.stringify(
            scenario.receipt === 'handoff'
              ? { launchId, outcome: 'handoff' }
              : { launchId, outcome: 'installer_failed', code: 71 }
          );
    let starts = 0;
    let acks = 0;
    let stored: RuntimeLaunchResult | undefined;
    let ops: RuntimeLaunchOps;
    let native: ReturnType<typeof setupNative> | undefined;
    if (backendName === 'native') {
      native = setupNative();
      native.container.receipt = receipt ?? null;
      native.container.startBehavior = scenario.ambiguous ? 'effect-then-reject' : 'ok';
      ops = adapterFor(native.instance).runtimeExecution!(makeIntent(launchId, OUTER_DEADLINE))!;
    } else {
      ops = {
        async reserveLaunch() {
          return {
            kind: 'reserved',
            phase: 'reserved',
            providerRef: 'fake-ref',
            startSource: 'image',
            attemptDeadlineAt: OUTER_DEADLINE,
          };
        },
        async startLaunch() {
          starts += 1;
          return scenario.ambiguous ? { kind: 'unknown', reason: 'lost-ack' } : { kind: 'issued' };
        },
        async observeLaunch() {
          return { ...(receipt === undefined ? {} : { receipt }), process: 'supervisor' };
        },
        async settleLaunch({ result }) {
          stored = result;
          return true;
        },
        async acknowledgeLaunch() {
          expect(stored).toBeDefined();
          acks += 1;
        },
        async retireLaunch() {},
        async destroyLaunch() {
          return true;
        },
      };
    }
    const result = await launchSandbox(
      request(ops, launchId, {
        selection: scenario.release ? testRuntimeSelection() : { kind: 'baked' },
        reader: { head: async () => (scenario.missing ? null : { size: 10 }) },
      })
    );
    expect(result.kind).toBe(scenario.expected);
    if (native !== undefined) {
      starts = native.container.startCalls.length;
      acks = native.readRecord()?.nativeLaunch?.acked === true ? 1 : 0;
      stored = native.readRecord()?.nativeLaunch?.settled?.result as RuntimeLaunchResult;
    }
    expect(starts).toBe(scenario.starts);
    expect(acks).toBe(scenario.acks);
    expect(stored).toEqual(result);
    if (scenario.ambiguous && native !== undefined)
      expect(native.readRecord()?.repositoryStartFailures).toBeUndefined();
  });
});

describe('native retirement fences', () => {
  it('needs no additional fence for an expired token even at capacity', () => {
    const now = Date.now();
    const fences = Array.from({ length: NATIVE_RETIREMENT_CAP }, (_, index) => ({
      launchId: `live-${index}`,
      until: now + 1_000,
    }));
    expect(recordRetirement(fences, 'expired-token', now - 1, now)).toEqual({
      kind: 'expired',
      fences,
    });
  });
  it('retains a retired nonce through the outer deadline then prunes it', () => {
    const recorded = recordRetirement([], 'launch-0001', 1_000, 0);
    expect(recorded).toEqual({
      kind: 'recorded',
      fences: [{ launchId: 'launch-0001', until: 1_000 }],
    });
    if (recorded.kind !== 'recorded') throw new Error('unreachable');
    expect(isRetired(recorded.fences, 'launch-0001', 999)).toBe(true);
    expect(isRetired(recorded.fences, 'launch-0001', 1_000)).toBe(false);
    expect(pruneRetirements(recorded.fences, 1_000)).toEqual([]);
  });

  it('reports an existing fence and never duplicates it', () => {
    const first = recordRetirement([], 'launch-0001', 1_000, 0);
    if (first.kind !== 'recorded') throw new Error('unreachable');
    expect(recordRetirement(first.fences, 'launch-0001', 5_000, 0)).toEqual({
      kind: 'exists',
      fences: first.fences,
    });
  });

  it('refuses saturation recoverably instead of dropping a live fence', () => {
    let fences: NativeRetirementFence[] = [];
    for (let index = 0; index < NATIVE_RETIREMENT_CAP; index += 1) {
      const result = recordRetirement(fences, `launch-${index}`, 10_000, 0);
      if (result.kind !== 'recorded') throw new Error('unexpected');
      fences = result.fences;
    }
    const saturated = recordRetirement(fences, 'launch-overflow', 10_000, 0);
    expect(saturated.kind).toBe('saturated');
    expect(saturated.fences).toHaveLength(NATIVE_RETIREMENT_CAP);
  });

  it('matches a captured token only against the live launch identity', () => {
    expect(
      nativeLaunchTokenMatches(
        { launchId: 'launch-1', outerDeadlineAt: 100 },
        { launchId: 'launch-1', createDeadlineAt: 100 }
      )
    ).toBe(true);
    expect(
      nativeLaunchTokenMatches(
        { launchId: 'launch-2', outerDeadlineAt: 100 },
        { launchId: 'launch-1', createDeadlineAt: 100 }
      )
    ).toBe(false);
    expect(nativeLaunchTokenMatches({ launchId: 'launch-1' }, undefined)).toBe(false);
    expect(nativeLaunchTokenMatches({}, undefined)).toBe(true);
  });

  it('treats a present but malformed record and fence set as invalid, never legacy', () => {
    expect(readNativeLaunchRecord(undefined).kind).toBe('absent');
    expect(readNativeLaunchRecord({ launchId: 'launch-0001' }).kind).toBe('invalid');
    expect(readNativeLaunchRecord({ launchId: 'launch-0001', start: { kind: 'bogus' } }).kind).toBe(
      'invalid'
    );
    expect(readRetirements(undefined).kind).toBe('absent');
    expect(readRetirements([{ launchId: 'bad id', until: 1 }]).kind).toBe('invalid');
    const over = Array.from({ length: NATIVE_RETIREMENT_CAP + 1 }, (_, index) => ({
      launchId: `l-${index}`,
      until: 10,
    }));
    expect(readRetirements(over).kind).toBe('saturated');
  });

  it('exposes the exact receipt path the hold waits on', () => {
    expect(nativeReceiptPath('launch-0001')).toBe(runtimeLaunchReceiptPath('launch-0001'));
  });
});

describe('serialized native receipt operations', () => {
  it('reads and acknowledges exact bytes through a real POSIX shell', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-receipt-'")));
    try {
      const directory = path.join(root, 'launch-receipts');
      mkdirSync(directory);
      const receiptPath = runtimeLaunchReceiptPath('launch-shell', root);
      const receipt = JSON.stringify({
        launchId: 'launch-shell',
        outcome: 'installer_failed',
        code: 70,
      });
      writeFileSync(receiptPath, receipt);
      const read = nativeReceiptReadCommand('launch-shell', root);
      const observed = spawnSync(read[0], read.slice(1), { encoding: 'utf8' });
      expect(observed.status).toBe(0);
      expect(observed.stdout).toBe(receipt);
      const wrongAck = nativeReceiptDeleteCommand('launch-shell', '{}', root);
      expect(spawnSync(wrongAck[0], wrongAck.slice(1)).status).toBe(2);
      expect(existsSync(receiptPath)).toBe(true);
      const ack = nativeReceiptDeleteCommand('launch-shell', receipt, root);
      expect(spawnSync(ack[0], ack.slice(1)).status).toBe(0);
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink in an intermediate receipt root without reading or deleting its target', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-receipt-link-')));
    try {
      const real = path.join(root, 'real');
      mkdirSync(path.join(real, 'launch-receipts'), { recursive: true });
      const link = path.join(root, 'link');
      symlinkSync(real, link);
      const receiptPath = runtimeLaunchReceiptPath('launch-shell', real);
      writeFileSync(receiptPath, '{}');
      for (const command of [
        nativeReceiptReadCommand('launch-shell', link),
        nativeReceiptDeleteCommand('launch-shell', '{}', link),
      ]) {
        expect(spawnSync(command[0], command.slice(1)).status).toBe(3);
      }
      expect(existsSync(receiptPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('native launch workflow over the real adapter and FakeContainer', () => {
  it('runs the common workflow to a handoff and installs the initial lease', async () => {
    const { container, ops, readRecord } = await backend();
    const result = await launchSandbox(request(ops, 'launch-0001'));

    expect(result).toEqual({ kind: 'handoff', startSource: 'image' });
    expect(container.startCalls).toHaveLength(1);
    const options = container.startCalls[0];
    expect(options.entrypoint).toEqual(['/bin/sh', '-c', bakedLaunchCommand()]);
    expect(options.image).toBe(IMAGE);
    expect(options.labels).toEqual({ 'kilocode.launch': 'launch-0001' });
    expect(options.env?.KILO_RUNTIME_ARTIFACT_GRANT).toBeUndefined();
    // F2: the native start installs the provider lease after confirmed issuance.
    expect(container.leaseCalls.length).toBeGreaterThan(0);
    expect(readRecord()?.state).toBe('running');
    expect(readRecord()?.nativeLaunch?.settled?.result).toEqual({
      kind: 'handoff',
      startSource: 'image',
    });
  });

  it('F1: refuses a new reservation while another non-idle owner remains, then a Stop clears it', async () => {
    const { container, instance, ops } = await backend('launch-0001');
    // A owns the reservation but its container never started.
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    const foreign = await ops.reserveLaunch({
      allocationId: 'alloc-2',
      launchId: 'launch-0002',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    expect(foreign).toEqual({ kind: 'refused', reason: 'allocation_owned' });
    expect(container.startCalls).toHaveLength(0);
    // A's captured token still stops its own reservation.
    await expect(
      instance.stop(null, { launchId: 'launch-0001', createDeadlineAt: OUTER_DEADLINE })
    ).resolves.toBe('terminal');
  });

  it('F1: refuses to start an unexplained running container this nonce never issued', async () => {
    const { container, instance, ops, providerRef, readRecord } = await backend('launch-0001');
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    // A foreign process started the container after the reservation.
    container.running = true;
    const started = await ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef,
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: OUTER_DEADLINE,
      failureRetention: false,
    });
    expect(started).toEqual({ kind: 'refused', reason: 'container_running' });
    expect(container.startCalls).toHaveLength(0);
    expect(readRecord()?.nativeLaunch?.issuedAt).toBeUndefined();
    void instance;
  });

  it('F3: maps an exhausted start RPC after the effect to unknown with exactly one physical start', async () => {
    const setup = setupNative();
    const adapter = adapterFor(setup.instance);
    const intent = makeIntent('launch-0001', OUTER_DEADLINE);
    const created = await adapter.create(intent);
    const providerRef = 'providerRef' in created ? created.providerRef : '';
    let thrown = false;
    const flaky = new Proxy(setup.instance, {
      get(target, prop, receiver) {
        if (prop === 'startNativeLaunch') {
          return async (input: unknown) => {
            const result = await (
              target.startNativeLaunch as (value: unknown) => Promise<unknown>
            ).call(target, input);
            if (!thrown) {
              thrown = true;
              throw new Error('transport lost after start');
            }
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as SandboxContainers;
    const flakyAdapter = createCloudflareContainersProviderAdapter({
      logicalSandboxId: 'sbx-1',
      allocationName: 'sbx-1',
      instance: 'standard-3',
      getContainer: () => flaky as unknown as DurableObjectStub<SandboxContainers>,
    });
    const ops = flakyAdapter.runtimeExecution!(intent)!;
    setup.container.receipt = JSON.stringify({ launchId: 'launch-0001', outcome: 'handoff' });

    const result = await launchSandbox(request(ops, 'launch-0001'));

    expect(result).toEqual({ kind: 'handoff', startSource: 'image' });
    // The retry replays the recorded issuance: exactly one physical start.
    expect(setup.container.startCalls).toHaveLength(1);
    expect(setup.container.receipt).toBeNull();
    expect(providerRef).toBeTruthy();
  });

  it('F4: an effect-then-reject start is an ambiguous issuance with no snapshot penalty', async () => {
    const key = await repoSnapshotIndexKey('repo-key', IMAGE);
    const setup = setupNative({
      env: { REPO_SNAPSHOTS: fakeKv({ [key]: { snapshotId: 'snap-repo' } }) },
    });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    setup.container.startBehavior = 'effect-then-reject';

    const result = await launchSandbox(request(ops, 'launch-0001', { repoKey: 'repo-key' }));

    expect(result).toEqual({ kind: 'handoff', startSource: 'repository' });
    expect(setup.container.startCalls).toHaveLength(1);
    expect(setup.readRecord()?.repositoryStartFailures).toBeUndefined();
    expect(setup.container.destroyCalls).toBe(0);
  });

  it('F4: only a confirmed physical rejection penalises the snapshot and falls back once', async () => {
    const key = await repoSnapshotIndexKey('repo-key', IMAGE);
    const setup = setupNative({
      env: { REPO_SNAPSHOTS: fakeKv({ [key]: { snapshotId: 'snap-repo' } }) },
    });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    setup.container.startBehavior = 'reject-snapshot';

    const result = await launchSandbox(
      request(ops, 'launch-0001', {
        repoKey: 'repo-key',
        effects: {
          grantSecret: async () => 'secret',
          onReserved: async () => true,
          rotateFallbackNonce: async () => ({ launchId: 'launch-0002', launchEnv: {} }),
        },
      })
    );

    expect(result).toEqual({ kind: 'handoff', startSource: 'image' });
    expect(setup.readRecord()?.repositoryStartFailures).toEqual({
      snapshotId: 'snap-repo',
      attempts: 1,
    });
    // First the rejected repository start, then the image fallback.
    expect(setup.container.startCalls[0]).toMatchObject({ containerSnapshot: { id: 'snap-repo' } });
    expect(setup.container.startCalls[1]).toMatchObject({ image: IMAGE });
    expect(setup.container.destroyCalls).toBeGreaterThanOrEqual(1);
  });

  it('F4: never reissues a rejected snapshot start on a start retry', async () => {
    const key = await repoSnapshotIndexKey('repo-key', IMAGE);
    const setup = setupNative({
      env: { REPO_SNAPSHOTS: fakeKv({ [key]: { snapshotId: 'snap-repo' } }) },
    });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    setup.container.startBehavior = 'reject-snapshot';
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
      repoKey: 'repo-key',
    });
    const startInput = {
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef: RE_providerRef(setup.instance),
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: OUTER_DEADLINE,
      failureRetention: false,
    };
    expect(await ops.startLaunch(startInput)).toEqual({ kind: 'snapshot-failed' });
    const callsAfterFirst = setup.container.startCalls.length;
    expect(await ops.startLaunch(startInput)).toEqual({ kind: 'snapshot-failed' });
    expect(setup.container.startCalls).toHaveLength(callsAfterFirst);
  });

  it('F5: does zero physical work when the attempt bound already expired', async () => {
    const setup = setupNative();
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const reserved = await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    if (reserved.kind !== 'reserved') throw new Error('expected reservation');
    // Advance past the attempt bound, then run the common workflow.
    vi.setSystemTime(reserved.attemptDeadlineAt + 1);
    const result = await launchSandbox(request(ops, 'launch-0001'));
    expect(result).toEqual({ kind: 'deadline' });
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('F5: rechecks the expired bound inside the queued issuance', async () => {
    const setup = setupNative();
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    const reserved = await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    if (reserved.kind !== 'reserved') throw new Error('expected reservation');
    // Force the persisted bound into the past, then start directly.
    const record = setup.readRecord();
    if (record?.nativeLaunch !== undefined) {
      record.nativeLaunch.attemptDeadlineAt = Date.now() - 1;
    }
    const started = await ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef: RE_providerRef(setup.instance),
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: reserved.attemptDeadlineAt,
      failureRetention: false,
    });
    expect(started).toEqual({ kind: 'unknown', reason: 'deadline' });
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('F6: replays a typed settled outcome after ACK with no new work', async () => {
    const { container, ops, readRecord } = await backend('launch-0001');
    container.receipt = JSON.stringify({
      launchId: 'launch-0001',
      outcome: 'installer_failed',
      code: 71,
    });
    const first = await launchSandbox(request(ops, 'launch-0001'));
    expect(first).toEqual({ kind: 'installer-failed', reason: 'runtime_artifact_unauthorized' });
    expect(readRecord()?.nativeLaunch?.acked).toBe(true);
    const starts = container.startCalls.length;

    const replay = await launchSandbox(request(ops, 'launch-0001'));
    expect(replay).toEqual(first);
    expect(container.startCalls).toHaveLength(starts);
  });

  it('F6: reconciles an already-issued nonce with no second physical start', async () => {
    const setup = setupNative();
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    const first = await ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef: RE_providerRef(setup.instance),
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: OUTER_DEADLINE,
      failureRetention: false,
    });
    expect(first).toEqual({ kind: 'issued' });
    const starts = setup.container.startCalls.length;

    const replay = await ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef: RE_providerRef(setup.instance),
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: OUTER_DEADLINE,
      failureRetention: false,
    });
    expect(replay).toEqual({ kind: 'issued' });
    expect(setup.container.startCalls).toHaveLength(starts);
  });

  it('F7: a retired token refuses the start and ends observation as ownership lost', async () => {
    const { instance, ops, providerRef } = await backend('launch-0001');
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    await instance.stop(null, { launchId: 'launch-0001', createDeadlineAt: OUTER_DEADLINE });

    await expect(
      ops.startLaunch({
        allocationId: 'alloc-1',
        launchId: 'launch-0001',
        providerRef,
        command: bakedLaunchCommand(),
        env: {},
        attemptDeadlineAt: OUTER_DEADLINE,
        failureRetention: false,
      })
    ).resolves.toEqual({ kind: 'refused', reason: 'stale_token' });
    await expect(
      ops.observeLaunch({ providerRef, launchId: 'launch-0001', deadlineAt: OUTER_DEADLINE })
    ).resolves.toEqual({ retired: true, process: 'unknown' });
  });

  it('F8: a null-ref token Stop destroys the current plan and a wrong token cannot', async () => {
    const { container, instance, ops, readRecord } = await backend('launch-0001');
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    await launchSandbox(request(ops, 'launch-0001'));
    expect(container.running).toBe(true);

    await expect(
      instance.stop(null, { launchId: 'launch-0001', createDeadlineAt: OUTER_DEADLINE })
    ).resolves.toBe('terminal');
    expect(container.running).toBe(false);
    expect(readRecord()?.nativeLaunch).toBeUndefined();

    // A replacement under the same ref; the old nonce's token must not clear it.
    const next = await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0002',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    expect(next.kind).toBe('reserved');
    const destroys = container.destroyCalls;
    await expect(
      instance.stop(null, { launchId: 'launch-0001', createDeadlineAt: OUTER_DEADLINE })
    ).resolves.toBe('terminal');
    expect(readRecord()?.nativeLaunch?.launchId).toBe('launch-0002');
    expect(container.destroyCalls).toBe(destroys);
  });

  it('F10: persists the original base before the source lookup and never rebases on reentry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const key = await repoSnapshotIndexKey('repo-key', IMAGE);
    const setup = setupNative({
      env: { REPO_SNAPSHOTS: fakeKv({ [key]: { snapshotId: 'snap-repo' } }) },
    });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    const first = await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
      repoKey: 'repo-key',
    });
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    expect(first.startSource).toBe('repository');
    expect(setup.readRecord()?.nativeLaunch?.firstReservationAt).toBe(10_000);
    // A redeploy changes today's image; the same nonce returns the SAME plan.
    setup.container.images.app = 'registry.example/kilo/app:redeployed';
    vi.setSystemTime(60_000);
    const again = await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
      repoKey: 'repo-key',
    });
    expect(again).toEqual(first);
    expect(setup.readRecord()?.nativeLaunch?.source.image).toBe(IMAGE);
  });

  it('refuses a delayed reservation after a Stop retired the nonce', async () => {
    const { instance, ops, providerRef } = await backend('launch-0001');
    await expect(
      instance.stop(providerRef, { launchId: 'launch-0001', createDeadlineAt: OUTER_DEADLINE })
    ).resolves.toBe('terminal');
    await expect(
      ops.reserveLaunch({
        allocationId: 'alloc-1',
        launchId: 'launch-0001',
        outerDeadlineAt: OUTER_DEADLINE,
      })
    ).resolves.toEqual({ kind: 'refused', reason: 'retired' });
  });

  it('binds the first completed source lookup once, even when the same nonce reenters while it is pending', async () => {
    const store = fakeKv();
    const replies: ((value: unknown) => void)[] = [];
    store.get = vi.fn(
      () =>
        new Promise(resolve => {
          replies.push(resolve);
        })
    ) as KVNamespace['get'];
    const setup = setupNative({ env: { REPO_SNAPSHOTS: store } });
    const ops = adapterFor(setup.instance).runtimeExecution!(
      makeIntent('launch-pending', OUTER_DEADLINE)
    )!;
    const input = {
      allocationId: 'alloc-1',
      launchId: 'launch-pending',
      outerDeadlineAt: OUTER_DEADLINE,
      repoKey: 'repo-key',
    };
    const first = ops.reserveLaunch(input);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(setup.readRecord()?.nativeLaunch?.source.kind).toBe('resolving');
    const second = ops.reserveLaunch({
      ...input,
      outerDeadlineAt: OUTER_DEADLINE + 60_000,
      skipRepository: true,
    });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    await expect(
      ops.startLaunch({
        allocationId: 'alloc-1',
        launchId: input.launchId,
        providerRef: RE_providerRef(setup.instance),
        command: bakedLaunchCommand(),
        env: {},
        attemptDeadlineAt: OUTER_DEADLINE,
        failureRetention: false,
      })
    ).resolves.toEqual({ kind: 'refused', reason: 'source_pending' });
    replies[1]({ snapshotId: 'snapshot-first-completed' });
    const bound = await second;
    replies[0]({ snapshotId: 'snapshot-late' });
    await expect(first).resolves.toEqual(bound);
    expect(setup.readRecord()?.nativeLaunch?.source).toMatchObject({
      kind: 'repository',
      snapshotId: 'snapshot-first-completed',
    });
    expect(setup.readRecord()?.nativeLaunch?.attemptDeadlineAt).toBeLessThanOrEqual(OUTER_DEADLINE);
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('retires promptly while a source lookup is pending and refuses its delayed commit', async () => {
    const store = fakeKv();
    let reply = (_value: unknown) => {};
    const getSnapshot = vi.fn(
      () =>
        new Promise(resolve => {
          reply = resolve;
        })
    );
    store.get = getSnapshot as KVNamespace['get'];
    const setup = setupNative({ env: { REPO_SNAPSHOTS: store } });
    const ops = adapterFor(setup.instance).runtimeExecution!(
      makeIntent('launch-pending', OUTER_DEADLINE)
    )!;
    const reservation = ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-pending',
      outerDeadlineAt: OUTER_DEADLINE,
      repoKey: 'repo-key',
    });
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    await expect(
      setup.instance.stop(null, { launchId: 'launch-pending', createDeadlineAt: OUTER_DEADLINE })
    ).resolves.toBe('terminal');
    reply({ snapshotId: 'snapshot-late' });
    await expect(reservation).resolves.toMatchObject({ kind: 'refused' });
    expect(setup.readRecord()?.nativeLaunch).toBeUndefined();
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('does not hold Stop behind a probe output or issue a second probe after retirement', async () => {
    const { instance, container, ops, providerRef } = await backend('launch-probe');
    await launchSandbox(request(ops, 'launch-probe'));
    const original = container.exec.bind(container);
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    container.exec = async command => {
      const process = await original(command);
      return {
        ...process,
        output: async () => {
          await gate;
          return process.output();
        },
      } as ExecProcess;
    };
    const callsBefore = container.execCalls.length;
    const observation = ops.observeLaunch({
      providerRef,
      launchId: 'launch-probe',
      deadlineAt: OUTER_DEADLINE,
    });
    await vi.waitFor(() => expect(container.execCalls).toHaveLength(callsBefore + 1));
    await expect(
      instance.stop(providerRef, { launchId: 'launch-probe', createDeadlineAt: OUTER_DEADLINE })
    ).resolves.toBe('terminal');
    release();
    await expect(observation).resolves.toMatchObject({ retired: true });
    expect(container.execCalls).toHaveLength(callsBefore + 1);
  });

  it('fails closed on malformed persisted evidence and does no physical work', async () => {
    const setup = setupNative({
      record: {
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: null,
        nativeLaunch: { launchId: 'launch-0001' },
      },
    });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    await expect(
      ops.reserveLaunch({
        allocationId: 'alloc-1',
        launchId: 'launch-0001',
        outerDeadlineAt: OUTER_DEADLINE,
      })
    ).resolves.toEqual({ kind: 'refused', reason: 'metadata_invalid' });
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('refuses a saturated live fence set instead of truncating it', async () => {
    const retirements = Array.from({ length: NATIVE_RETIREMENT_CAP + 1 }, (_, index) => ({
      launchId: `launch-${index}`,
      until: OUTER_DEADLINE,
    }));
    const setup = setupNative({
      record: {
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: null,
        retirements,
      },
    });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-fresh', OUTER_DEADLINE))!;
    await expect(
      ops.reserveLaunch({
        allocationId: 'alloc-1',
        launchId: 'launch-fresh',
        outerDeadlineAt: OUTER_DEADLINE,
      })
    ).resolves.toEqual({ kind: 'refused', reason: 'retirement_saturated' });
    expect(setup.readRecord()?.retirements).toHaveLength(NATIVE_RETIREMENT_CAP + 1);
  });

  it('captures with the corroborated original base, not the current image', async () => {
    const store = fakeKv();
    const setup = setupNative({ env: { REPO_SNAPSHOTS: store } });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    const providerRef = RE_providerRef(setup.instance);
    await ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef,
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: OUTER_DEADLINE,
      failureRetention: false,
    });
    setup.container.images.app = 'registry.example/kilo/app:redeployed';

    await expect(
      setup.instance.captureRepository(providerRef, 'repo-key', 'deadbeef')
    ).resolves.toBe(true);
    const stored = await store.get(await repoSnapshotIndexKey('repo-key', IMAGE), 'json');
    expect(stored).toMatchObject({ snapshotId: 'snap-cap' });
  });

  it('declines a capture when the running nonce is not corroborated', async () => {
    const store = fakeKv();
    const setup = setupNative({ env: { REPO_SNAPSHOTS: store } });
    const adapter = adapterFor(setup.instance);
    const ops = adapter.runtimeExecution!(makeIntent('launch-0001', OUTER_DEADLINE))!;
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    const providerRef = RE_providerRef(setup.instance);
    await ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef,
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: OUTER_DEADLINE,
      failureRetention: false,
    });
    // A same-ref replacement relabels the container; the capture must decline.
    setup.container.labels = { 'kilocode.launch': 'launch-0002' };
    await expect(
      setup.instance.captureRepository(providerRef, 'repo-key', 'deadbeef')
    ).resolves.toBe(false);
    expect(setup.container.snapshotCalls).toBe(0);
  });

  it('confirms cleanup of a leftover legacy allocation and fences tokenless callbacks after migration', async () => {
    const setup = setupNative({
      running: true,
      record: { state: 'running', allocationRef: 'legacy-ref', stopOpId: null, lastSnapshot: null },
    });
    const ops = adapterFor(setup.instance).runtimeExecution!(
      makeIntent('launch-migrate', OUTER_DEADLINE)
    )!;
    const reserved = await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-migrate',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    expect(reserved.kind).toBe('reserved');
    expect(setup.container.destroyCalls).toBe(1);
    expect(setup.readRecord()?.runtimeProtocolVersion).toBe(1);
    await expect(
      setup.instance.launchWrapper({
        instance: 'standard-3',
        allocationRef: 'legacy-late',
        env: {},
        deadlineAt: OUTER_DEADLINE,
      })
    ).rejects.toThrow(/launch token/);
    if (reserved.kind !== 'reserved') throw new Error('expected reservation');
    await ops.retireLaunch({
      providerRef: reserved.providerRef,
      launchId: 'launch-migrate',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    expect(setup.readRecord()?.state).toBe('idle');
    await expect(
      setup.instance.launchWrapper({
        instance: 'standard-3',
        allocationRef: 'legacy-late',
        env: {},
        deadlineAt: OUTER_DEADLINE,
      })
    ).rejects.toThrow(/launch token/);
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('does not replace an unconfirmed legacy allocation and retries its cleanup when the condition clears', async () => {
    const setup = setupNative({
      running: true,
      record: { state: 'running', allocationRef: 'legacy-ref', stopOpId: null, lastSnapshot: null },
    });
    const originalDestroy = setup.container.destroy.bind(setup.container);
    const failure = vi
      .spyOn(setup.container, 'destroy')
      .mockRejectedValueOnce(new Error('destroy failed'))
      .mockImplementation(originalDestroy);
    const ops = adapterFor(setup.instance).runtimeExecution!(
      makeIntent('launch-migrate', OUTER_DEADLINE)
    )!;
    const input = {
      allocationId: 'alloc-1',
      launchId: 'launch-migrate',
      outerDeadlineAt: OUTER_DEADLINE,
    };
    await expect(ops.reserveLaunch(input)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'legacy_cleanup_unconfirmed',
    });
    expect(setup.readRecord()?.allocationRef).toBe('legacy-ref');
    expect(setup.readRecord()?.nativeLaunch).toBeUndefined();
    await expect(ops.reserveLaunch(input)).resolves.toMatchObject({ kind: 'reserved' });
    expect(failure).toHaveBeenCalledTimes(2);
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('retiring an issued attempt confirms physical destruction instead of clearing its owner', async () => {
    const { container, ops, providerRef, readRecord } = await backend('launch-retire');
    await launchSandbox(request(ops, 'launch-retire'));
    expect(container.running).toBe(true);
    await ops.retireLaunch({
      providerRef,
      launchId: 'launch-retire',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    expect(container.running).toBe(false);
    expect(container.destroyCalls).toBe(1);
    expect(readRecord()?.state).toBe('idle');
  });

  it('bounds a lost start acknowledgement without repeating its physical issuance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { instance, container, ops, providerRef } = await backend('launch-lost-response');
    const reserved = await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-lost-response',
      outerDeadlineAt: OUTER_DEADLINE,
    });
    if (reserved.kind !== 'reserved') throw new Error('expected reservation');
    const original = instance.startNativeLaunch.bind(instance);
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.spyOn(instance, 'startNativeLaunch').mockImplementation(async input => {
      const result = await original(input);
      await gate;
      return result;
    });
    const started = ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-lost-response',
      providerRef,
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: reserved.attemptDeadlineAt,
      failureRetention: false,
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(started).resolves.toEqual({ kind: 'unknown', reason: 'transport' });
    expect(container.startCalls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(container.startCalls).toHaveLength(1);
  });

  it('preserves a classified failure and does not ACK when settlement cannot be confirmed', async () => {
    const { instance, container, ops } = await backend('launch-settle-lost');
    container.receipt = JSON.stringify({
      launchId: 'launch-settle-lost',
      outcome: 'installer_failed',
      code: 70,
    });
    vi.spyOn(instance, 'settleNativeLaunch').mockRejectedValue(new Error('transport failed'));
    await expect(
      launchSandbox(
        request(ops, 'launch-settle-lost', {
          selection: testRuntimeSelection(),
          reader: { head: async () => ({ size: 10 }) },
        })
      )
    ).rejects.toMatchObject({
      name: RuntimeLaunchSettlementError.name,
      outcome: { kind: 'installer-failed', reason: 'runtime_artifact_unavailable' },
    });
    expect(container.execCalls.some(command => command.join(' ').includes('rm -f'))).toBe(false);
  });

  it('preserves a permanent billing error after retiring an unissued reservation', async () => {
    const setup = setupNative();
    const ops = adapterFor(setup.instance).runtimeExecution!({
      ...makeIntent('launch-billing-error', OUTER_DEADLINE),
      billing: {} as ProviderCreateIntent['billing'],
    })!;
    await expect(
      ops.reserveLaunch({
        allocationId: 'alloc-1',
        launchId: 'launch-billing-error',
        outerDeadlineAt: OUTER_DEADLINE,
      })
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(setup.readRecord()?.nativeLaunch).toBeUndefined();
    expect(setup.container.startCalls).toHaveLength(0);
  });

  it('exposes bounded non-secret evidence without a raw locator', async () => {
    const { instance, ops, providerRef } = await backend('launch-0001');
    const runtimeIdentity = {
      descriptorSha256: 'd'.repeat(64),
      cliSha256: 'a'.repeat(64),
      controlSha256: 'b'.repeat(64),
    };
    await ops.reserveLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      outerDeadlineAt: OUTER_DEADLINE,
      runtimeIdentity,
    });
    await ops.startLaunch({
      allocationId: 'alloc-1',
      launchId: 'launch-0001',
      providerRef,
      command: bakedLaunchCommand(),
      env: {},
      attemptDeadlineAt: OUTER_DEADLINE,
      failureRetention: false,
    });
    const evidence = await instance.nativeLaunchEvidence();
    expect(evidence).toMatchObject({
      doId: 'do-id',
      launchId: 'launch-0001',
      startSource: 'image',
      issuedAt: expect.any(Number),
      runtimeIdentity,
    });
    await instance.stop(providerRef, { launchId: 'launch-0001', createDeadlineAt: OUTER_DEADLINE });
    expect(await instance.nativeLaunchEvidence()).toMatchObject({
      lastConfirmedStop: {
        allocationId: 'alloc-1',
        launchId: 'launch-0001',
        confirmedAt: expect.any(Number),
      },
    });
    expect(evidence.baseFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain(IMAGE);
  });

  it('retires the reservation when billing admission fails after it', async () => {
    const setup = setupNative();
    const adapter = adapterFor(setup.instance);
    const billing = parseSandboxBillingInput({
      sandboxId: 'ses-abcdef',
      subject: { type: 'user', id: 'user-1' },
      actor: { type: 'user', id: 'user-1' },
      sessionId: 'workspace_test',
      metadata: { origin: 'cloud-agent' },
      enforcementRequested: true,
    });
    const intent: ProviderCreateIntent = {
      intentId: 'intent-1',
      createdAt: Date.now(),
      billing,
      launchToken: { launchId: 'launch-0001', createDeadlineAt: OUTER_DEADLINE },
    };
    const ops = adapter.runtimeExecution!(intent)!;

    await expect(
      ops.reserveLaunch({
        allocationId: 'alloc-1',
        launchId: 'launch-0001',
        outerDeadlineAt: OUTER_DEADLINE,
      })
    ).rejects.toMatchObject({ code: 'meter_unavailable' });

    expect(setup.container.startCalls).toHaveLength(0);
    expect(setup.readRecord()?.nativeLaunch).toBeUndefined();
    expect(setup.readRecord()?.retirements).toEqual([
      { launchId: 'launch-0001', until: OUTER_DEADLINE },
    ]);
  });
});

function RE_providerRef(instance: SandboxContainers): string {
  const record = (
    instance as unknown as { ctx: { storage: { map: Map<string, unknown> } } }
  ).ctx.storage.map.get(RECORD_KEY) as LooseRecord | undefined;
  return record?.allocationRef ?? REF;
}
