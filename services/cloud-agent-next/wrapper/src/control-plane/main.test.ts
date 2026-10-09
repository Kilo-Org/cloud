import { describe, expect, it } from 'bun:test';
import type { ControlDiagnosticFields } from '../../../src/shared/control-diagnostics.js';
import type { ControlPlaneConnection } from './connection.js';
import {
  controlPlaneExitPolicy,
  createControlPlaneLifecycle,
  type ControlPlaneLifecycle,
  type ControlPlaneProcess,
} from './main.js';
import {
  createNativeStatusReporter,
  type NativeStatusScheduler,
  type NativeStatusSnapshot,
} from './native-status.js';

type AnyHandler = (...args: unknown[]) => void;
type FakeProcess = ControlPlaneProcess & { emit(event: string, ...args: unknown[]): void };

function createFakeProcess(): FakeProcess {
  const handlers = new Map<string, AnyHandler>();
  const process: FakeProcess = {
    once(event, listener) {
      handlers.set(event, listener);
      return process;
    },
    on(event, listener) {
      handlers.set(event, listener);
      return process;
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args);
    },
  };
  return process;
}

function createFakeConnection(): {
  connection: ControlPlaneConnection;
  started: () => number;
  closed: () => number;
  recycled: () => number;
} {
  let started = 0;
  let closed = 0;
  let recycled = 0;
  return {
    connection: {
      wrapperId: 'wrapper_test',
      snapshot: () => ({ phase: 'idle', attempt: 0, outboxBytes: 0 }),
      start: () => {
        started += 1;
      },
      send: () => undefined,
      recycle: () => {
        recycled += 1;
      },
      close: () => {
        closed += 1;
      },
    },
    started: () => started,
    closed: () => closed,
    recycled: () => recycled,
  };
}

function createLifecycle(
  options: {
    process?: FakeProcess;
    exit?: (code: number) => void;
    log?: (message: string) => void;
    stop?: () => Promise<void>;
  } = {}
): {
  lifecycle: ControlPlaneLifecycle;
  process: FakeProcess;
  exits: number[];
  phases: string[];
  nativeRecords: Array<{ event: string; fields: ControlDiagnosticFields }>;
  finalizes: () => { diagnostics: number; fileLogs: number };
  connectionState: ReturnType<typeof createFakeConnection>;
  logs: string[];
  stopCalls: () => number;
} {
  const proc = options.process ?? createFakeProcess();
  const exits: number[] = [];
  const phases: string[] = [];
  const nativeRecords: Array<{ event: string; fields: ControlDiagnosticFields }> = [];
  const logs: string[] = [];
  let diagnosticsFinalize = 0;
  let fileLogFinalize = 0;
  let stopCalls = 0;
  const connectionState = createFakeConnection();
  const lifecycle = createControlPlaneLifecycle({
    connection: connectionState.connection,
    diagnostics: {
      onDiagnostic: (event, fields) => {
        if (event === 'wrapper.lifecycle' && typeof fields.phase === 'string') {
          phases.push(fields.phase);
        }
      },
      finalize: async () => {
        diagnosticsFinalize += 1;
      },
    },
    fileLogs: {
      finalize: async () => {
        fileLogFinalize += 1;
      },
    },
    onNativeDiagnostic: (event, fields) => nativeRecords.push({ event, fields }),
    exit: options.exit ?? (code => exits.push(code)),
    process: proc,
    log: options.log ?? (message => logs.push(message)),
    ...(options.stop
      ? {
          stop: async () => {
            stopCalls += 1;
            await options.stop?.();
          },
        }
      : {}),
  });
  return {
    lifecycle,
    process: proc,
    exits,
    phases,
    nativeRecords,
    finalizes: () => ({ diagnostics: diagnosticsFinalize, fileLogs: fileLogFinalize }),
    connectionState,
    logs,
    stopCalls: () => stopCalls,
  };
}

describe('controlPlaneExitPolicy', () => {
  it('exits 0 on shutdown, 1 on SIGTERM/uncaught exception, and never on a rejection', () => {
    expect(controlPlaneExitPolicy('shutdown')).toBe(0);
    expect(controlPlaneExitPolicy('sigterm')).toBe(1);
    expect(controlPlaneExitPolicy('uncaught_exception')).toBe(1);
    expect(controlPlaneExitPolicy('unhandled_rejection')).toBeNull();
  });
});

describe('createControlPlaneLifecycle', () => {
  it('starts the connection and recycles on demand', () => {
    const { lifecycle, connectionState } = createLifecycle();
    lifecycle.start();
    lifecycle.recycle();
    expect(connectionState.started()).toBe(1);
    expect(connectionState.recycled()).toBe(1);
  });

  it('exits 1 on SIGTERM so the supervisor restarts, after flushing diagnostics and logs', async () => {
    const state = createLifecycle();
    state.process.emit('SIGTERM');
    await Bun.sleep(0);
    expect(state.exits).toEqual([1]);
    expect(state.phases).toContain('failed');
    expect(state.finalizes()).toEqual({ diagnostics: 1, fileLogs: 1 });
    expect(state.connectionState.closed()).toBe(1);
  });

  it('exits 1 on an uncaught exception so the supervisor restarts it', async () => {
    const state = createLifecycle();
    state.process.emit('uncaughtException');
    await Bun.sleep(0);
    expect(state.exits).toEqual([1]);
    expect(state.phases).toContain('failed');
  });

  it('logs an unhandled rejection with its reason and does not exit', async () => {
    const state = createLifecycle();
    state.process.emit('unhandledRejection', new Error('boom'));
    await Bun.sleep(0);
    expect(state.exits).toEqual([]);
    expect(state.logs.some(message => message.includes('unhandled rejection'))).toBe(true);
    expect(state.logs.some(message => message.includes('boom'))).toBe(true);
    expect(state.finalizes()).toEqual({ diagnostics: 0, fileLogs: 0 });
    // The native owner line is closed: failure with the rejection cause, no reason text.
    expect(state.nativeRecords).toContainEqual({
      event: 'wrapper.lifecycle',
      fields: { phase: 'failed', retirementCause: 'unhandled_rejection' },
    });
    for (const record of state.nativeRecords) {
      expect(record.fields).not.toHaveProperty('detail');
      expect(record.fields).not.toHaveProperty('reason');
    }
  });

  it('exits 0 on a sandbox shutdown frame and ignores a second shutdown', async () => {
    const state = createLifecycle();
    const exitCode = controlPlaneExitPolicy('shutdown') ?? 0;
    await state.lifecycle.shutdown(exitCode, 'sandbox shutdown');
    await state.lifecycle.shutdown(exitCode, 'sandbox shutdown');
    expect(state.exits).toEqual([0]);
    expect(state.finalizes()).toEqual({ diagnostics: 1, fileLogs: 1 });
  });

  it('stops owned Kilo runtimes exactly once before exiting', async () => {
    const state = createLifecycle({ stop: async () => undefined });
    await state.lifecycle.shutdown(0, 'sandbox shutdown');
    expect(state.stopCalls()).toBe(1);
    expect(state.exits).toEqual([0]);
    await state.lifecycle.shutdown(0, 'sandbox shutdown');
    expect(state.stopCalls()).toBe(1);
  });
});

function nativeStatusSnapshot(): NativeStatusSnapshot {
  return {
    nativeConnectionPhase: 'idle',
    attempt: 0,
    outboxBytes: 0,
    sessionCount: 0,
    preparingCount: 0,
    activeTurnCount: 0,
    recentTerminalCount: 0,
    runtimeCount: 0,
    suspectedCount: 0,
    restartingCount: 0,
    unavailableCount: 0,
  };
}

function createFakeStatusScheduler(): {
  scheduler: NativeStatusScheduler;
  fire: () => void;
  size: () => number;
} {
  const timers = new Map<object, () => void>();
  return {
    scheduler: {
      setInterval: handler => {
        const handle = { unref: () => undefined };
        timers.set(handle, handler);
        return handle as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: handle => {
        timers.delete(handle as unknown as object);
      },
    },
    fire: () => {
      for (const handler of [...timers.values()]) handler();
    },
    size: () => timers.size,
  };
}

describe('createNativeStatusReporter', () => {
  it('arms at most one timer and only when the gate is set', async () => {
    const fake = createFakeStatusScheduler();
    const disabled = createNativeStatusReporter({
      enabled: false,
      project: () => {
        throw new Error('the gate-off reporter must not project');
      },
      snapshot: nativeStatusSnapshot,
      scheduler: fake.scheduler,
    });
    disabled.start();
    expect(fake.size()).toBe(0);

    const lines: Array<{ event: string; fields: unknown }> = [];
    const enabled = createNativeStatusReporter({
      enabled: true,
      project: (event, fields) => lines.push({ event, fields }),
      snapshot: nativeStatusSnapshot,
      scheduler: fake.scheduler,
    });
    enabled.start();
    enabled.start();
    expect(fake.size()).toBe(1);
    fake.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('wrapper.status');
    enabled.stop();
    enabled.stop();
    expect(fake.size()).toBe(0);
  });

  it('does not write a snapshot that resolves after stop and clears the handle', async () => {
    const fake = createFakeStatusScheduler();
    const lines: string[] = [];
    const deferred = Promise.withResolvers<NativeStatusSnapshot>();
    const reporter = createNativeStatusReporter({
      enabled: true,
      project: event => lines.push(event),
      snapshot: () => deferred.promise,
      scheduler: fake.scheduler,
    });
    reporter.start();
    fake.fire();
    await Promise.resolve();
    reporter.stop();
    deferred.resolve(nativeStatusSnapshot());
    await deferred.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(lines).toHaveLength(0);
    expect(fake.size()).toBe(0);
  });

  it('stops the reporter before the lifecycle exits', async () => {
    const order: string[] = [];
    const fake = createFakeStatusScheduler();
    const reporter = createNativeStatusReporter({
      enabled: true,
      project: () => order.push('project'),
      snapshot: nativeStatusSnapshot,
      scheduler: fake.scheduler,
    });
    reporter.start();
    const state = createLifecycle({
      exit: code => order.push(`exit:${code}`),
      stop: async () => {
        reporter.stop();
        order.push('stop');
      },
    });
    await state.lifecycle.shutdown(0, 'sandbox shutdown');
    expect(order).toEqual(['stop', 'exit:0']);
    expect(fake.size()).toBe(0);
  });

  it('runs one snapshot for two ticks during an in-flight read and queues none', async () => {
    const fake = createFakeStatusScheduler();
    const lines: string[] = [];
    let snapshots = 0;
    const deferred = Promise.withResolvers<NativeStatusSnapshot>();
    const reporter = createNativeStatusReporter({
      enabled: true,
      project: event => lines.push(event),
      snapshot: () => {
        snapshots += 1;
        return deferred.promise;
      },
      scheduler: fake.scheduler,
    });
    reporter.start();
    fake.fire();
    // A second tick while the first snapshot is in flight neither starts a
    // second snapshot nor queues one.
    fake.fire();
    await Promise.resolve();
    expect(snapshots).toBe(1);

    deferred.resolve(nativeStatusSnapshot());
    await deferred.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots).toBe(1);
    expect(lines).toEqual(['wrapper.status']);
    reporter.stop();
  });

  it('keeps the envelope phase and elapsedMs after the owner snapshot', async () => {
    const fake = createFakeStatusScheduler();
    const fields: Array<Record<string, unknown>> = [];
    const reporter = createNativeStatusReporter({
      enabled: true,
      project: (_event, next) => fields.push(next),
      snapshot: () => ({ ...nativeStatusSnapshot(), phase: 'owner', elapsedMs: -1 }),
      scheduler: fake.scheduler,
    });
    reporter.start();
    fake.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(fields[0]?.phase).toBe('status');
    expect(fields[0]?.elapsedMs).not.toBe(-1);
    reporter.stop();
  });
});
