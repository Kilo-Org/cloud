import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '@cloudflare/sandbox';
import { setBillingContext, type ContainerUsageClient } from '@kilocode/container-usage';
import { expect, it, vi } from 'vitest';
import {
  MeteredBillingLifecycle,
  type ContainerStopParams,
} from '../../src/metered-billing-lifecycle.js';
import type { ProvenanceStorage } from './worker.js';

type StoredState = {
  status: 'running' | 'healthy' | 'stopped_with_code';
  lastChange: number;
  exitCode?: number;
};

it('reconciled stopped container does not establish an observed clean exit', async () => {
  const namespace = (
    env as typeof env & { PROVENANCE_STORAGE: DurableObjectNamespace<ProvenanceStorage> }
  ).PROVENANCE_STORAGE;
  const output = vi.spyOn(console, 'log');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const results: {
    state: StoredState;
    callback: ContainerStopParams;
    lifecycleReadStates: unknown[];
    generation: string;
  }[] = [];
  try {
    for (const state of [
      { status: 'running', lastChange: 1000 },
      { status: 'healthy', lastChange: 1000 },
      { status: 'stopped_with_code', lastChange: 1000, exitCode: 137 },
      { status: 'stopped_with_code', lastChange: 1000, exitCode: 0 },
      { status: 'stopped_with_code', lastChange: 1000 },
    ] satisfies StoredState[]) {
      const stub = namespace.get(namespace.newUniqueId());
      const result = await runInDurableObject(stub, async (_instance, ctx) => {
        const pending: Promise<unknown>[] = [];
        const callbacks: ContainerStopParams[] = [];
        const callbackStates: unknown[] = [];
        const lifecycleReadStates: unknown[] = [];
        const persistedStops: unknown[] = [];
        let sandboxCleanupCompleted = false;
        const runtime = { running: false };
        await ctx.storage.put('__CF_CONTAINER_STATE', state);
        Object.defineProperty(ctx, 'container', { configurable: true, value: runtime });
        Object.defineProperty(ctx, 'blockConcurrencyWhile', {
          configurable: true,
          value: (fn: () => Promise<unknown>) => {
            const promise = Promise.resolve().then(fn);
            pending.push(promise);
            return promise;
          },
        });
        try {
          class CapturingSandbox extends Sandbox {
            async onStop(params?: Parameters<Sandbox['onStop']>[0]): Promise<void> {
              if (!params) throw new Error('Reconciliation omitted stop parameters');
              callbacks.push(params);
              callbackStates.push(await this.getState());
              await lifecycle.onContainerStopped({ sandboxClassName: 'SandboxSmall' }, params, () =>
                super.onStop(params).then(() => {
                  sandboxCleanupCompleted = true;
                })
              );
            }
          }
          const sandbox = new CapturingSandbox(ctx as ConstructorParameters<typeof Sandbox>[0], {});
          await Promise.all(pending);
          pending.length = 0;
          const lifecycle = new MeteredBillingLifecycle({
            storage: ctx.storage,
            usageClient: {} as ContainerUsageClient,
            schedule: async () => {
              throw new Error('Unexpected billing schedule');
            },
            deleteSchedules: () => {
              throw new Error('Unexpected billing schedule deletion');
            },
            getState: () => {
              expect(sandboxCleanupCompleted).toBe(true);
              return sandbox.getState().then(state => {
                lifecycleReadStates.push(state);
                return state;
              });
            },
            isContainerRunning: () => runtime.running,
            stopContainer: async () => {
              throw new Error('Unexpected runtime stop');
            },
            destroyContainer: async () => {
              throw new Error('Unexpected runtime destroy');
            },
            durableObjectId: ctx.id.toString(),
            waitUntil: promise => {
              pending.push(promise);
            },
          });
          lifecycle.attachHeartbeat({
            persistStop: async (params, stoppedAtMs) => {
              persistedStops.push({ params, stoppedAtMs });
              return undefined;
            },
            scheduleHeartbeat: async () => {
              throw new Error('Unexpected heartbeat schedule');
            },
            billingHeartbeatTick: async () => {
              throw new Error('Unexpected heartbeat tick');
            },
            recordStop: async () => {
              throw new Error('Unexpected billing RPC');
            },
            cancelHeartbeat: () => {
              throw new Error('Unexpected heartbeat cancellation');
            },
          });
          const billingContext = await setBillingContext(ctx.storage, {
            service: 'cloud-agent-next',
            instanceId: 'synthetic-sandbox',
            startEpochMs: 0,
            sku: 'cloud-agent-next:SandboxSmall',
            subject: { type: 'user', id: 'synthetic-user' },
            actor: { type: 'user', id: 'synthetic-user' },
          });
          const inherited = Object.getPrototypeOf(Sandbox.prototype);
          expect(Object.hasOwn(Sandbox.prototype, 'syncPendingStoppedEvents')).toBe(false);
          expect(Reflect.get(sandbox, 'getState')).toBe(inherited.getState);
          expect(Reflect.get(sandbox, 'syncPendingStoppedEvents')).toBe(
            inherited.syncPendingStoppedEvents
          );
          expect(Reflect.get(sandbox, 'callOnStop')).toBe(inherited.callOnStop);
          expect(inherited.syncPendingStoppedEvents.toString()).toContain('state.exitCode ?? 0');
          await sandbox.stop();
          await Promise.all(pending);
          expect(callbacks).toHaveLength(1);
          expect(callbackStates).toEqual([state]);
          expect(lifecycleReadStates).toEqual([state]);
          expect(persistedStops).toEqual([{ params: callbacks[0], stoppedAtMs: 1000 }]);
          expect(await sandbox.getState()).toEqual({ status: 'stopped', lastChange: 1000 });
          await sandbox.stop();
          expect(callbacks).toHaveLength(1);
          expect(lifecycleReadStates).toEqual([state]);
          return {
            state,
            callback: callbacks[0],
            lifecycleReadStates,
            generation: billingContext.generation,
          };
        } finally {
          await Promise.allSettled(pending);
          await ctx.storage.deleteAlarm();
          await ctx.storage.deleteAll();
          expect(await ctx.storage.list()).toHaveLength(0);
          expect(await ctx.storage.getAlarm()).toBeNull();
          expect(Reflect.deleteProperty(ctx, 'container')).toBe(true);
          expect(Reflect.deleteProperty(ctx, 'blockConcurrencyWhile')).toBe(true);
        }
      });
      results.push(result);
    }
    const logs = output.mock.calls.flat().filter(arg => arg?.tags?.logTag === 'container_stopped');
    expect(logs).toHaveLength(5);
    const projections = logs.map(log => ({ reason: log.reason, exitCode: log.exitCode }));
    expect(results.map(result => result.callback)).toEqual([
      { reason: 'exit', exitCode: 0 },
      { reason: 'exit', exitCode: 0 },
      { reason: 'exit', exitCode: 137 },
      { reason: 'exit', exitCode: 0 },
      { reason: 'exit', exitCode: 0 },
    ]);
    expect(projections).toEqual(results.map(result => result.callback));
    expect(projections[0]).toEqual(projections[3]);
    expect(projections[1]).toEqual(projections[3]);
    expect(projections[4]).toEqual(projections[3]);
    expect(projections[2]).not.toEqual(projections[3]);
    const diagnostics = logs.map(
      ({ sdkCallbackState, sdkRecordedExitCodeAvailable, sdkRecordedExitCode }) => ({
        sdkCallbackState,
        sdkRecordedExitCodeAvailable,
        ...(sdkRecordedExitCodeAvailable ? { sdkRecordedExitCode } : {}),
      })
    );
    expect(diagnostics).toEqual([
      { sdkCallbackState: 'running', sdkRecordedExitCodeAvailable: false },
      { sdkCallbackState: 'healthy', sdkRecordedExitCodeAvailable: false },
      {
        sdkCallbackState: 'stopped_with_code',
        sdkRecordedExitCodeAvailable: true,
        sdkRecordedExitCode: 137,
      },
      {
        sdkCallbackState: 'stopped_with_code',
        sdkRecordedExitCodeAvailable: true,
        sdkRecordedExitCode: 0,
      },
      { sdkCallbackState: 'stopped_with_code', sdkRecordedExitCodeAvailable: false },
    ]);
    const oldLogs = logs.map(
      ({
        sdkCallbackState: _state,
        sdkRecordedExitCodeAvailable: _available,
        sdkRecordedExitCode: _code,
        ...log
      }) => log
    );
    for (const [index, log] of oldLogs.entries()) {
      expect(log).toEqual({
        message: 'Container stopped',
        level: 'info',
        time: expect.any(String),
        tags: {
          logTag: 'container_stopped',
          sandboxId: 'synthetic-sandbox',
          $logger: { level: 'debug' },
        },
        sandboxClass: 'SandboxSmall',
        generation: results[index].generation,
        startEpochMs: 0,
        reason: results[index].callback.reason,
        exitCode: results[index].callback.exitCode,
        lifetimeMs: 1000,
        sessionId: undefined,
      });
      expect(
        new TextEncoder().encode(JSON.stringify(diagnostics[index])).byteLength
      ).toBeLessThanOrEqual(256);
      expect(Object.hasOwn(logs[index], 'sdkRecordedExitCode')).toBe(
        diagnostics[index].sdkRecordedExitCodeAvailable
      );
      const logpush = {
        ScriptName: 'cloud-agent-next',
        Logs: [{ Message: [JSON.stringify(logs[index])] }],
      };
      const selected = logpush.Logs.map(row => JSON.parse(row.Message[0]))
        .filter(
          p =>
            logpush.ScriptName === 'cloud-agent-next' &&
            p.message === 'Container stopped' &&
            p.generation === results[index].generation
        )
        .map(p => ({
          t: p.time,
          class: p.sandboxClass,
          generation: p.generation,
          callbackReason: p.reason,
          callbackCode: p.exitCode,
          sdkState: p.sdkCallbackState,
          recordedCodeAvailable: p.sdkRecordedExitCodeAvailable,
          recordedCode: p.sdkRecordedExitCode,
        }));
      expect(selected).toEqual([
        {
          t: log.time,
          class: 'SandboxSmall',
          generation: results[index].generation,
          callbackReason: results[index].callback.reason,
          callbackCode: results[index].callback.exitCode,
          sdkState: diagnostics[index].sdkCallbackState,
          recordedCodeAvailable: diagnostics[index].sdkRecordedExitCodeAvailable,
          recordedCode: diagnostics[index].sdkRecordedExitCode,
        },
      ]);
    }
    const stableLogs = oldLogs.map(({ time: _time, generation: _generation, ...log }) => log);
    expect(stableLogs[0]).toEqual(stableLogs[3]);
    expect(stableLogs[1]).toEqual(stableLogs[3]);
    expect(stableLogs[4]).toEqual(stableLogs[3]);
    expect(stableLogs[2]).not.toEqual(stableLogs[3]);
    expect(logs.every(log => !('status' in log) && !('exitStatusOrigin' in log))).toBe(true);
    output.mockRestore();
    console.log(
      'AMBIGUITY PROVEN',
      JSON.stringify({
        results,
        projections,
        cleanup: 'all five storage fixtures empty; alarms absent',
      })
    );
  } finally {
    output.mockRestore();
    clock.mockRestore();
  }
});
