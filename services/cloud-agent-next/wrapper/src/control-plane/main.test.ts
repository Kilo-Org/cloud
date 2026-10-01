import { describe, expect, it } from 'bun:test';
import type { ControlPlaneConnection } from './connection.js';
import {
  controlPlaneExitPolicy,
  createControlPlaneLifecycle,
  type ControlPlaneLifecycle,
  type ControlPlaneProcess,
} from './main.js';

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
  finalizes: () => { diagnostics: number; fileLogs: number };
  connectionState: ReturnType<typeof createFakeConnection>;
  logs: string[];
  stopCalls: () => number;
} {
  const proc = options.process ?? createFakeProcess();
  const exits: number[] = [];
  const phases: string[] = [];
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
    finalizes: () => ({ diagnostics: diagnosticsFinalize, fileLogs: fileLogFinalize }),
    connectionState,
    logs,
    stopCalls: () => stopCalls,
  };
}

describe('controlPlaneExitPolicy', () => {
  it('exits 0 on shutdown and SIGTERM, 1 on an uncaught exception, and never on a rejection', () => {
    expect(controlPlaneExitPolicy('shutdown')).toBe(0);
    expect(controlPlaneExitPolicy('sigterm')).toBe(0);
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

  it('exits 0 on SIGTERM after flushing diagnostics and logs', async () => {
    const state = createLifecycle();
    state.process.emit('SIGTERM');
    await Bun.sleep(0);
    expect(state.exits).toEqual([0]);
    expect(state.phases).toContain('stopping');
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
