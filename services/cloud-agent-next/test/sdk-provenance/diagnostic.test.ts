import { env, runInDurableObject } from 'cloudflare:test';
import {
  ContainerUsageClient,
  getBillingContext,
  installBillingHeartbeat,
  setBillingContext,
  updateBillingContext,
  type ContainerUsageRpcMethods,
} from '@kilocode/container-usage';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MeteredBillingLifecycle,
  type ContainerStopParams,
  type MeteredBillingHost,
} from '../../src/metered-billing-lifecycle.js';
import type { ProvenanceStorage } from './worker.js';

const namespace = (
  env as typeof env & { PROVENANCE_STORAGE: DurableObjectNamespace<ProvenanceStorage> }
).PROVENANCE_STORAGE;
const sentinel = 'SYNTHETIC_PRIVATE_STATE_OR_EXCEPTION_DO_NOT_LOG';
const attribution = {
  service: 'cloud-agent-next',
  instanceId: 'synthetic-sandbox',
  startEpochMs: 100,
  sku: 'cloud-agent-next:SandboxSmall',
  sessionId: 'synthetic-session',
  subject: { type: 'user' as const, id: 'synthetic-user' },
  actor: { type: 'user' as const, id: 'synthetic-user' },
};

type Case = {
  name: string;
  state?: unknown;
  error?: unknown;
  expectedState: string;
  expectedCode?: number;
  stoppedAtMs?: number;
  clockCalls?: number;
  codeGetterError?: boolean;
};

const cases: Case[] = [
  ...['running', 'healthy', 'stopping', 'stopped'].map(status => ({
    name: `${status} ignores code`,
    state: { status, exitCode: 137, lastChange: 400 },
    expectedState: status,
    stoppedAtMs: status === 'stopped' ? 400 : 1000,
  })),
  ...(
    [
      ['zero', 0],
      ['negative zero', -0],
      ['137', 137],
      ['signed32 minimum', -2147483648],
      ['signed32 maximum', 2147483647],
    ] satisfies [string, number][]
  ).map(([name, code]) => ({
    name: `retained ${name}`,
    state: { status: 'stopped_with_code', exitCode: code, lastChange: 400 },
    expectedState: 'stopped_with_code',
    expectedCode: code,
    stoppedAtMs: 400,
  })),
  ...(
    [
      ['missing', undefined],
      ['null', null],
      ['string', '0'],
      ['fractional', 0.5],
      ['NaN', NaN],
      ['infinity', Infinity],
      ['negative infinity', -Infinity],
      ['below signed32', -2147483649],
      ['above signed32', 2147483648],
      ['unsafe integer', Number.MAX_SAFE_INTEGER],
      ['boolean', false],
      ['bigint', 0n],
      ['object', { secret: sentinel }],
      ['array', [sentinel]],
      ['symbol', Symbol(sentinel)],
    ] satisfies [string, unknown][]
  ).map(([name, code]) => ({
    name: `invalid recorded ${name}`,
    state: { status: 'stopped_with_code', exitCode: code, lastChange: 400 },
    expectedState: 'stopped_with_code',
    stoppedAtMs: 400,
  })),
  ...(
    [
      ['missing status', {}],
      ['unrecognized status', { status: sentinel, exitCode: 0 }],
      ['null status', { status: null }],
      ['object status', { status: { secret: sentinel } }],
      ['array status', { status: [sentinel] }],
      ['malformed primitive', sentinel],
      ['malformed array', [sentinel]],
      ['undefined state', undefined],
      ['null state', null],
    ] satisfies [string, unknown][]
  ).map(([name, state]) => ({
    name,
    state,
    expectedState: 'unknown',
    clockCalls: state == null ? 2 : 1,
  })),
  ...(
    [
      ['zero', 0, 0],
      ['negative', -1, 1000],
      ['future', 1001, 1000],
      ['missing', undefined, 1000],
      ['NaN', NaN, 1000],
      ['infinity', Infinity, 1000],
      ['string', '400', 1000],
    ] satisfies [string, unknown, number][]
  ).map(([name, lastChange, stoppedAtMs]) => ({
    name: `stopped timestamp ${name}`,
    state: { status: 'stopped', lastChange },
    expectedState: 'stopped',
    stoppedAtMs,
  })),
  { name: 'read throws private Error', error: new Error(sentinel), expectedState: 'read_error' },
  { name: 'read throws private object', error: { token: sentinel }, expectedState: 'read_error' },
  {
    name: 'recorded code accessor throws without changing observed time',
    state: { status: 'stopped_with_code', lastChange: 400 },
    codeGetterError: true,
    expectedState: 'stopped_with_code',
    stoppedAtMs: 400,
  },
];

afterEach(() => vi.restoreAllMocks());

it.each(cases)('bounds the existing stop snapshot: $name', async scenario => {
  const output = vi.spyOn(console, 'log');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const timers = vi.spyOn(globalThis, 'setTimeout');
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const pending: Promise<unknown>[] = [];
    const order: string[] = [];
    let clockCallsAtScheduling = 0;
    const params: ContainerStopParams = { reason: 'exit', exitCode: 0 };
    const state =
      typeof scenario.state === 'object' && scenario.state !== null
        ? {
            ...scenario.state,
            authorization: sentinel,
            headers: { token: sentinel },
            prompt: sentinel,
          }
        : scenario.state;
    if (scenario.codeGetterError && typeof state === 'object' && state !== null) {
      Object.defineProperty(state, 'exitCode', {
        get: () => {
          throw new Error(sentinel);
        },
      });
    }
    const getState = vi.fn<MeteredBillingHost['getState']>(async () => {
      order.push('existing_state_read');
      if ('error' in scenario) throw scenario.error;
      return state as Awaited<ReturnType<MeteredBillingHost['getState']>>;
    });
    const lifecycle = new MeteredBillingLifecycle({
      storage: ctx.storage,
      usageClient: {} as ContainerUsageClient,
      schedule: async () => {
        throw new Error('Unexpected scheduling');
      },
      deleteSchedules: () => {
        throw new Error('Unexpected scheduling');
      },
      getState,
      isContainerRunning: () => false,
      stopContainer: async () => {
        throw new Error('Unexpected runtime stop');
      },
      destroyContainer: async () => {
        throw new Error('Unexpected runtime destroy');
      },
      durableObjectId: ctx.id.toString(),
      waitUntil: promise => {
        clockCallsAtScheduling = clock.mock.calls.length;
        pending.push(promise);
      },
    });
    const persistStop = vi.fn(async (_received: unknown, _stoppedAtMs?: number) => {
      order.push('persist_stop');
      return undefined;
    });
    lifecycle.attachHeartbeat({
      persistStop,
      scheduleHeartbeat: async () => {
        throw new Error('Unexpected heartbeat');
      },
      billingHeartbeatTick: async () => {
        throw new Error('Unexpected heartbeat');
      },
      recordStop: async () => {
        throw new Error('Unexpected settlement RPC');
      },
      cancelHeartbeat: () => {
        throw new Error('Unexpected heartbeat');
      },
    });
    const billingContext = await setBillingContext(ctx.storage, attribution);
    const before = await ctx.storage.list();
    clock.mockClear();
    timers.mockClear();
    try {
      await lifecycle.onContainerStopped({ sandboxClassName: 'SandboxSmall' }, params, async () => {
        order.push('cleanup');
      });
      await Promise.all(pending);
      expect(getState).toHaveBeenCalledOnce();
      expect(clockCallsAtScheduling).toBe(scenario.clockCalls ?? 1);
      expect(timers).not.toHaveBeenCalled();
      expect(order).toEqual(['cleanup', 'existing_state_read', 'persist_stop']);
      expect(persistStop).toHaveBeenCalledOnce();
      expect(persistStop).toHaveBeenCalledWith(params, scenario.stoppedAtMs ?? 1000);
      expect(await ctx.storage.list()).toEqual(before);
      const logs = output.mock.calls
        .flat()
        .filter(arg => arg?.tags?.logTag === 'container_stopped');
      expect(logs).toHaveLength(1);
      const { sdkCallbackState, sdkRecordedExitCodeAvailable, sdkRecordedExitCode, ...oldLog } =
        logs[0];
      expect(oldLog).toEqual({
        message: 'Container stopped',
        level: 'info',
        time: expect.any(String),
        tags: {
          logTag: 'container_stopped',
          sandboxId: attribution.instanceId,
          $logger: { level: 'debug' },
        },
        sandboxClass: 'SandboxSmall',
        generation: billingContext.generation,
        startEpochMs: 100,
        reason: 'exit',
        exitCode: 0,
        lifetimeMs: (scenario.stoppedAtMs ?? 1000) - 100,
        sessionId: attribution.sessionId,
      });
      const diagnostics = {
        sdkCallbackState,
        sdkRecordedExitCodeAvailable,
        ...(Object.hasOwn(logs[0], 'sdkRecordedExitCode') ? { sdkRecordedExitCode } : {}),
      };
      expect(diagnostics).toEqual({
        sdkCallbackState: scenario.expectedState,
        sdkRecordedExitCodeAvailable: Object.hasOwn(scenario, 'expectedCode'),
        ...(Object.hasOwn(scenario, 'expectedCode')
          ? { sdkRecordedExitCode: scenario.expectedCode }
          : {}),
      });
      expect(new TextEncoder().encode(JSON.stringify(diagnostics)).byteLength).toBeLessThanOrEqual(
        256
      );
      expect(
        new TextEncoder().encode(JSON.stringify(logs[0])).byteLength -
          new TextEncoder().encode(JSON.stringify(oldLog)).byteLength
      ).toBeLessThanOrEqual(256);
      expect(JSON.stringify(output.mock.calls)).not.toContain(sentinel);
      expect(await ctx.storage.getAlarm()).toBeNull();
    } finally {
      await Promise.allSettled(pending);
      await ctx.storage.deleteAll();
      expect(await ctx.storage.list()).toHaveLength(0);
    }
  });
});

it('preserves real heartbeat settlement and one stop record per settled generation', async () => {
  const output = vi.spyOn(console, 'log');
  vi.spyOn(Date, 'now').mockReturnValue(5000);
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const pending: Promise<unknown>[] = [];
    const ack = { intervalId: 'synthetic-interval', durable: 'pg' as const, dedup: false };
    const rpc: ContainerUsageRpcMethods = {
      recordStart: vi.fn<ContainerUsageRpcMethods['recordStart']>(async () => ({
        success: true,
        ack,
      })),
      recordHeartbeat: vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(async () => ({
        ...ack,
        budget: { verdict: 'continue' },
      })),
      recordStop: vi.fn(async () => ack),
    };
    const client = new ContainerUsageClient(rpc, {
      service: 'cloud-agent-next',
      retry: { attempts: 1 },
    });
    const getState = vi.fn(async () => ({
      status: 'stopped_with_code' as const,
      lastChange: 4000,
      exitCode: 0,
    }));
    const schedule = vi.fn(async () => {
      throw new Error('Unexpected scheduling');
    });
    const deleteSchedules = vi.fn();
    const lifecycle = new MeteredBillingLifecycle({
      storage: ctx.storage,
      usageClient: client,
      schedule,
      deleteSchedules,
      getState,
      isContainerRunning: () => false,
      stopContainer: async () => undefined,
      destroyContainer: async () => undefined,
      durableObjectId: ctx.id.toString(),
      waitUntil: promise => {
        pending.push(promise);
      },
    });
    const heartbeat = installBillingHeartbeat(
      { schedule, deleteSchedules, getState },
      {
        client,
        storage: ctx.storage,
        enforceBudgetStop: async () => {
          throw new Error('Unexpected budget stop');
        },
      }
    );
    lifecycle.attachHeartbeat(heartbeat);
    const context = await setBillingContext(ctx.storage, attribution);
    await updateBillingContext(ctx.storage, {
      ...context,
      measurementStarted: true,
      usageMeasuredAtMs: 100,
    });
    try {
      await lifecycle.onContainerStopped(
        { sandboxClassName: 'SandboxSmall' },
        { reason: 'exit', exitCode: 0 },
        async () => undefined
      );
      await Promise.all(pending);
      expect(await getBillingContext(ctx.storage)).toBeUndefined();
      expect(rpc.recordStart).toHaveBeenCalledOnce();
      expect(rpc.recordStop).toHaveBeenCalledOnce();
      expect(rpc.recordStop).toHaveBeenCalledWith(
        expect.objectContaining({
          startEpochMs: 100,
          reason: 'exit',
          exitCode: 0,
          usageSinceLast: 3,
        })
      );
      expect(await ctx.storage.get('container-usage:start-ack-generation:v1')).toBeUndefined();
      expect(await ctx.storage.get('container-usage:pending-stop-reason:v1')).toBeUndefined();
      await lifecycle.onContainerStopped(
        { sandboxClassName: 'SandboxSmall' },
        { reason: 'exit', exitCode: 0 },
        async () => undefined
      );
      await Promise.all(pending);
      expect(rpc.recordStop).toHaveBeenCalledOnce();
      const logs = output.mock.calls
        .flat()
        .filter(arg => arg?.tags?.logTag === 'container_stopped');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        generation: context.generation,
        lifetimeMs: 3900,
        reason: 'exit',
        exitCode: 0,
        sdkCallbackState: 'stopped_with_code',
        sdkRecordedExitCodeAvailable: true,
        sdkRecordedExitCode: 0,
      });
      expect(schedule).not.toHaveBeenCalled();
      expect(await ctx.storage.getAlarm()).toBeNull();
    } finally {
      await Promise.allSettled(pending);
      await ctx.storage.deleteAll();
      expect(await ctx.storage.list()).toHaveLength(0);
    }
  });
});
