import { describe, expect, it } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_PLANE_TIMERS,
  type ControlPlaneTimers,
} from '../../../src/shared/control-plane-timers.js';
import type { KiloFeedEvent, KiloEventFeedSource } from './kilo-event-feed.js';
import type { ControlDiagnosticFields } from '../../../src/shared/control-diagnostics.js';
import { createTurnManager } from './turn.js';
import { SESSION_SNAPSHOT_INTERVAL_MS } from './runtime-activity.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import {
  cleanupStaleKiloPidfiles,
  createKiloRuntime,
  createKiloRuntimes,
  KiloWorktreeMcpMismatchError,
  parseKiloPidfile,
  type KiloFeedCallbacks,
  type KiloProcess,
  type KiloProcessSpawner,
  type KiloRuntime,
  type KiloRuntimeOptions,
  type KiloRuntimeScheduler,
  type KiloRuntimes,
} from './kilo-runtime.js';

function timers(overrides: Partial<ControlPlaneTimers['wrapper']> = {}): ControlPlaneTimers {
  return {
    ...CONTROL_PLANE_TIMERS,
    wrapper: { ...CONTROL_PLANE_TIMERS.wrapper, ...overrides },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await Bun.sleep(1);
  }
  return;
}

type FakeScheduler = {
  scheduler: KiloRuntimeScheduler;
  advance(ms: number): void;
  intervalCount(): number;
  fire(): void;
};

function createScheduler(): FakeScheduler {
  let current = 1_000_000;
  const intervals = new Map<symbol, () => void>();
  return {
    scheduler: {
      now: () => current,
      setInterval: (handler: () => void) => {
        const id = Symbol('interval');
        intervals.set(id, handler);
        return id;
      },
      clearInterval: handle => {
        intervals.delete(handle as symbol);
      },
    },
    advance(ms) {
      current += ms;
    },
    intervalCount: () => intervals.size,
    fire() {
      for (const handler of [...intervals.values()]) handler();
    },
  };
}

type FakeProcessRecord = { pid: number; stopped: number; exit: () => void };

function createSpawner(): {
  spawn: KiloProcessSpawner;
  processes: FakeProcessRecord[];
  spawnCount(): number;
} {
  let nextPid = 1_000;
  const processes: FakeProcessRecord[] = [];
  const spawn: KiloProcessSpawner = async () => {
    const pid = nextPid++;
    const deferred = Promise.withResolvers<void>();
    const record: FakeProcessRecord = { pid, stopped: 0, exit: () => deferred.resolve() };
    processes.push(record);
    const process: KiloProcess = {
      pid,
      url: `http://127.0.0.1:${pid}`,
      exited: deferred.promise,
      stop: async () => {
        record.stopped += 1;
        return true;
      },
    };
    return process;
  };
  return { spawn, processes, spawnCount: () => processes.length };
}

type FakeFeedRecord = { callbacks: KiloFeedCallbacks; closed: number };

function createFeedFactory(options: { failOpens?: number } = {}): {
  openFeed: (
    source: KiloEventFeedSource,
    callbacks: KiloFeedCallbacks
  ) => { open(): Promise<void>; close(): void };
  feeds: FakeFeedRecord[];
} {
  const feeds: FakeFeedRecord[] = [];
  let remainingFailures = options.failOpens ?? 0;
  return {
    feeds,
    openFeed: (_source, callbacks) => {
      const record: FakeFeedRecord = { callbacks, closed: 0 };
      feeds.push(record);
      return {
        open: async () => {
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new Error('feed failed to open');
          }
          // Behave like the real reader: deliver the first event before
          // `open()` resolves so a successful attempt is visible immediately.
          callbacks.onEvent({ type: 'server.connected', properties: {}, nativeRuntimeId: 'r' });
        },
        close: () => {
          record.closed += 1;
        },
      };
    },
  };
}

function createProbe(answer: boolean | (() => Promise<boolean>)): {
  probe: () => Promise<boolean>;
  calls: { count: number };
  set(answer: boolean | (() => Promise<boolean>)): void;
} {
  let current = answer;
  const calls = { count: 0 };
  return {
    calls,
    probe: async () => {
      calls.count += 1;
      return typeof current === 'function' ? current() : current;
    },
    set(value) {
      current = value;
    },
  };
}

const TEST_TIMERS = timers({
  sseSilenceMs: 100,
  healthRequestMs: 1_000,
  kiloRestartLimit: 3,
  kiloRestartWindowMs: 60_000,
});

function createRuntime(options: {
  spawner: ReturnType<typeof createSpawner>;
  feed: ReturnType<typeof createFeedFactory>;
  probe: ReturnType<typeof createProbe>;
  scheduler: FakeScheduler;
  restarts?: Array<{ reason: string; outcomeReason?: string }>;
  unavailable?: number;
  directory?: string;
  env?: Record<string, string>;
  isIdle?: () => boolean | Promise<boolean>;
  prepareFilesystem?: (env: Record<string, string>, directory: string) => Promise<void>;
  spawnKilo?: KiloProcessSpawner;
  timers?: ControlPlaneTimers;
  onRestart?: (info: { directory: string; reason: string }) => void;
  sampleMemory?: KiloRuntimeOptions['sampleMemory'];
  memoryHolds?: boolean[];
  readSnapshot?: KiloRuntimeOptions['readSnapshot'];
}) {
  const restarts: Array<{ reason: string; outcomeReason?: string }> = options.restarts ?? [];
  const restartingAtOnRestart: boolean[] = [];
  const logs: string[] = [];
  const nativeDiagnostics: Array<{ event: string; fields: ControlDiagnosticFields }> = [];
  const runtimeRef: { current?: ReturnType<typeof createKiloRuntime> } = {};
  let unavailable = options.unavailable ?? 0;
  const runtime = createKiloRuntime({
    readSnapshot: options.readSnapshot ?? (async () => []),
    directory: options.directory ?? '/tmp/kilo-runtime-test',
    env: options.env ?? { HOME: '/old' },
    timers: options.timers ?? TEST_TIMERS,
    pidfileDirectory: '/tmp/kilo-runtime-test-pids',
    spawnKilo: options.spawnKilo ?? options.spawner.spawn,
    openFeed: options.feed.openFeed,
    probeHealth: options.probe.probe,
    scheduler: options.scheduler.scheduler,
    readProcessStartTime: () => undefined,
    log: message => logs.push(message),
    onNativeDiagnostic: (event, fields) => nativeDiagnostics.push({ event, fields }),
    ...(options.isIdle
      ? {
          isIdle: async () => options.isIdle!(),
        }
      : {}),
    ...(options.prepareFilesystem ? { prepareFilesystem: options.prepareFilesystem } : {}),
    ...(options.sampleMemory ? { sampleMemory: options.sampleMemory } : {}),
    onMemoryHold: info => options.memoryHolds?.push(info.held),
    onRestart: info => {
      restarts.push({
        reason: info.reason,
        ...(info.outcomeReason === undefined ? {} : { outcomeReason: info.outcomeReason }),
      });
      restartingAtOnRestart.push(runtimeRef.current?.isRestarting() ?? true);
      options.onRestart?.(info);
    },
    onUnavailable: () => {
      unavailable += 1;
    },
  });
  runtimeRef.current = runtime;
  return {
    restarts,
    restartingAtOnRestart,
    logs,
    nativeDiagnostics,
    unavailable: () => unavailable,
    runtime,
  };
}

describe('Kilo startup lifecycle', () => {
  it('keeps credentials installed while the first feed is opening pending behind the idle gate', async () => {
    const spawner = createSpawner();
    const feed = createFeedFactory();
    const connected = Promise.withResolvers<void>();
    const environments: Record<string, string>[] = [];
    const filesystemEnvironments: Record<string, string>[] = [];
    const scheduler = createScheduler();
    let idle = false;
    const original = feed.openFeed;
    feed.openFeed = (source, callbacks) => {
      const next = original(source, callbacks);
      return {
        ...next,
        open: async () => {
          await connected.promise;
          await next.open();
        },
      };
    };
    const { runtime } = createRuntime({
      spawner,
      feed,
      scheduler,
      probe: createProbe(true),
      isIdle: () => idle,
      prepareFilesystem: async env => {
        filesystemEnvironments.push(env);
      },
      spawnKilo: async input => {
        environments.push(input.env);
        return spawner.spawn(input);
      },
    });
    const starting = runtime.ensure();
    await waitFor(() => feed.feeds.length === 1);
    await runtime.installCredentials({ HOME: '/new' });
    connected.resolve();
    await starting;
    expect(await runtime.applyPendingCredentials(() => true)).toBe(false);
    expect(environments).toEqual([{ HOME: '/old' }]);
    idle = true;
    await runtime.refreshActivity();
    expect(await runtime.applyPendingCredentials(() => true)).toBe(true);
    expect(environments).toEqual([{ HOME: '/old' }, { HOME: '/new' }]);
    expect(filesystemEnvironments).toEqual(environments);
    await runtime.shutdown();
  });

  it('does not spawn after shutdown during filesystem preparation', async () => {
    const filesystem = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const { runtime } = createRuntime({
      spawner,
      scheduler,
      feed: createFeedFactory(),
      probe: createProbe(true),
      prepareFilesystem: async () => {
        entered.resolve();
        await filesystem.promise;
      },
    });
    const starting = runtime.ensure();
    const rejected = starting.catch(error => error);
    await entered.promise;
    await runtime.shutdown();
    filesystem.resolve();
    expect(await rejected).toBeInstanceOf(Error);
    expect(spawner.spawnCount()).toBe(0);
    expect(scheduler.intervalCount()).toBe(0);
  });

  it('stops the owned process and rejects startup on shutdown during feed opening', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    let callbacks: KiloFeedCallbacks | undefined;
    let closed = 0;
    const feed = createFeedFactory();
    feed.openFeed = (_source, next) => {
      callbacks = next;
      return {
        open: async () => new Promise<void>(() => undefined),
        close: () => {
          closed += 1;
        },
      };
    };
    const { runtime } = createRuntime({ spawner, scheduler, feed, probe: createProbe(true) });
    const starting = runtime.ensure();
    const rejected = starting.catch(error => error);
    await waitFor(() => callbacks !== undefined);
    await runtime.shutdown();
    expect(await rejected).toBeInstanceOf(Error);
    callbacks?.onEvent({ type: 'server.connected', properties: {}, nativeRuntimeId: 'r' });
    expect(spawner.processes[0].stopped).toBe(1);
    expect(closed).toBe(1);
    expect(scheduler.intervalCount()).toBe(0);
    expect(() => runtime.client).toThrow('not started');
  });
});

describe('parseKiloPidfile', () => {
  it('accepts a well-formed record and rejects anything else', () => {
    expect(parseKiloPidfile('{"pid":12,"startTime":"345"}')).toEqual({ pid: 12, startTime: '345' });
    expect(parseKiloPidfile('not json')).toBeUndefined();
    expect(parseKiloPidfile('{"pid":0,"startTime":"1"}')).toBeUndefined();
    expect(parseKiloPidfile('{"pid":12,"startTime":"abc"}')).toBeUndefined();
    expect(parseKiloPidfile('{"pid":12}')).toBeUndefined();
  });
});

describe('cleanupStaleKiloPidfiles', () => {
  it('kills only the process group whose PID and start time still match, then clears every pidfile', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilo-pidfile-test-'));
    try {
      await fsp.writeFile(
        path.join(directory, '101.pid.json'),
        JSON.stringify({ pid: 101, startTime: '500' })
      );
      await fsp.writeFile(
        path.join(directory, '202.pid.json'),
        JSON.stringify({ pid: 202, startTime: '999' })
      );
      await fsp.writeFile(path.join(directory, '303.pid.json'), 'not json');
      const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const count = await cleanupStaleKiloPidfiles({
        directory,
        readProcessStartTime: pid => (pid === 101 ? '500' : '777'),
        killProcessGroup: (pid, signal) => killed.push({ pid, signal }),
        log: () => undefined,
      });
      expect(count).toBe(1);
      expect(killed).toEqual([{ pid: 101, signal: 'SIGKILL' }]);
      expect(await fsp.readdir(directory)).toEqual([]);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('is a no-op for a missing directory', async () => {
    const count = await cleanupStaleKiloPidfiles({
      directory: '/tmp/kilo-pidfile-does-not-exist',
      log: () => undefined,
    });
    expect(count).toBe(0);
  });
});

describe('createKiloRuntime', () => {
  it('reserves credential retirement before ensure can hand out a client, and retains old-client identity after recovery', async () => {
    const spawner = createSpawner();
    const stopping = Promise.withResolvers<void>();
    const releaseStop = Promise.withResolvers<void>();
    const { runtime } = createRuntime({
      spawner,
      scheduler: createScheduler(),
      feed: createFeedFactory(),
      probe: createProbe(true),
      isIdle: () => true,
      spawnKilo: async input => {
        const process = await spawner.spawn(input);
        return {
          ...process,
          stop: async deadline => {
            stopping.resolve();
            await releaseStop.promise;
            return process.stop(deadline);
          },
        };
      },
    });
    const oldClient = await runtime.ensure();
    await runtime.installCredentials({ HOME: '/new' });
    const applying = runtime.applyPendingCredentials(() => true);
    await stopping.promise;
    expect(runtime.isRestarting()).toBe(true);
    expect(runtime.isRetiredClient(oldClient)).toBe(true);
    let ensured = false;
    const ensuring = runtime.ensure().then(client => {
      ensured = true;
      return client;
    });
    await Bun.sleep(1);
    expect(ensured).toBe(false);
    releaseStop.resolve();
    expect(await applying).toBe(true);
    expect(await ensuring).not.toBe(oldClient);
    expect(runtime.isRestarting()).toBe(false);
    expect(runtime.isRetiredClient(oldClient)).toBe(true);
    expect(runtime.isRetiredClient(runtime.client)).toBe(false);
    await runtime.shutdown();
  });

  it.each(['busy', 'finalizing', 'pending-attachment'])(
    'blocks shared-sibling credential retirement during %s',
    async activity => {
      const spawner = createSpawner();
      const inspected = Promise.withResolvers<boolean>();
      const attachment = Promise.withResolvers<{ prompt: string }>();
      const finalization = Promise.withResolvers<{ success: boolean }>();
      const { runtime } = createRuntime({
        spawner,
        scheduler: createScheduler(),
        feed: createFeedFactory(),
        probe: createProbe(true),
        isIdle: () => inspected.promise,
      });
      const client = await runtime.ensure();
      client.sendPromptAsync = async () => undefined;
      const turns = createTurnManager({
        timers: TEST_TIMERS,
        runtimes: { get: () => runtime },
        emit: () => undefined,
        materializeAttachments: async message => ({
          ...message,
          ...(activity === 'pending-attachment' ? await attachment.promise : { prompt: 'hello' }),
        }),
        runAutoCommit: () => finalization.promise,
      });
      turns.registerRoute({
        sessionId: 'workspace_a',
        kiloSessionId: 'ses_a',
        directory: runtime.directory,
        attemptId: 'a',
      });
      turns.registerRoute({
        sessionId: 'workspace_b',
        kiloSessionId: 'ses_b',
        directory: runtime.directory,
        attemptId: 'b',
      });
      await runtime.installCredentials({ HOME: '/new' });
      const applying = runtime.applyPendingCredentials(() =>
        turns.canRestartRuntime(runtime.directory)
      );
      turns.submit('workspace_b', {
        messageId: 'm1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code', model: 'test/model' },
        finalization: { autoCommit: activity === 'finalizing' },
      });
      await Bun.sleep(1);
      if (activity === 'finalizing') {
        turns.observeKiloEvent({
          type: 'session.turn.close',
          properties: { sessionID: 'ses_b', reason: 'completed' },
          nativeRuntimeId: 'r',
        });
      }
      inspected.resolve(true);
      expect(await applying).toBe(false);
      expect(spawner.processes[0].stopped).toBe(0);
      attachment.resolve({ prompt: 'hello' });
      finalization.resolve({ success: true });
      turns.release('workspace_b');
      turns.shutdown();
      await runtime.shutdown();
    }
  );

  it.each(['idle-first', 'attachment-first'])(
    'does not retire a submission client after held idle inspection: %s',
    async order => {
      const spawner = createSpawner();
      const scheduler = createScheduler();
      const inspected = Promise.withResolvers<boolean>();
      const attachment = Promise.withResolvers<{ prompt: string }>();
      const frames: ControlPlaneWrapperFrame[] = [];
      const { runtime } = createRuntime({
        spawner,
        scheduler,
        feed: createFeedFactory(),
        probe: createProbe(true),
        isIdle: () => inspected.promise,
      });
      const client = await runtime.ensure();
      const submitted: string[] = [];
      client.sendPromptAsync = async input => {
        submitted.push(input.messageId ?? '');
      };
      const turns = createTurnManager({
        timers: TEST_TIMERS,
        runtimes: { get: () => runtime },
        emit: frame => frames.push(frame),
        materializeAttachments: async message => ({ ...message, ...(await attachment.promise) }),
      });
      turns.registerRoute({
        sessionId: 'workspace_a',
        kiloSessionId: 'ses_a',
        directory: runtime.directory,
        attemptId: 'a',
      });
      const installation = runtime.installCredentials({ HOME: '/new' });
      const applying = runtime.applyPendingCredentials(() =>
        turns.canRestartRuntime(runtime.directory)
      );
      turns.submit('workspace_a', {
        messageId: 'm1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code', model: 'test/model' },
      });
      if (order === 'idle-first') {
        inspected.resolve(true);
        await applying;
        attachment.resolve({ prompt: 'hello' });
      } else {
        attachment.resolve({ prompt: 'hello' });
        await waitFor(() => submitted.length > 0);
        inspected.resolve(true);
        await applying;
      }
      await installation;
      await waitFor(() => submitted.length > 0);
      expect(spawner.processes[0].stopped).toBe(0);
      expect(spawner.spawnCount()).toBe(1);
      expect(frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      turns.shutdown();
      await runtime.shutdown();
    }
  );

  it('restarts on an unexpected Kilo exit but not after a deliberate stop', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime, logs } = createRuntime({ spawner, feed, probe, scheduler });
    await runtime.ensure();
    expect(spawner.spawnCount()).toBe(1);

    spawner.processes[0]!.exit();
    await waitFor(() => spawner.spawnCount() === 2);
    expect(
      logs.some(message => message.includes('kilo restarting') && message.includes('reason=exit'))
    ).toBe(true);

    await runtime.shutdown();
    spawner.processes[1]!.exit();
    await Bun.sleep(5);
    expect(spawner.spawnCount()).toBe(2);
    expect(scheduler.intervalCount()).toBe(0);
  });

  it('emits kilo_restarting before the replacement spawn and kilo_restarted only after it', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    let releaseSpawn!: () => void;
    let spawnCalls = 0;
    const gate = new Promise<void>(resolve => {
      releaseSpawn = resolve;
    });
    const { runtime, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      spawnKilo: async input => {
        spawnCalls += 1;
        if (spawnCalls >= 2) await gate;
        return spawner.spawn(input);
      },
    });
    await runtime.ensure();

    spawner.processes[0]!.exit();
    await waitFor(() => nativeDiagnostics.some(entry => entry.fields.phase === 'kilo_restarting'));
    // The replacement has not spawned yet; no completed restart may be reported.
    expect(nativeDiagnostics.some(entry => entry.fields.phase === 'kilo_restarted')).toBe(false);

    releaseSpawn();
    await waitFor(() => nativeDiagnostics.some(entry => entry.fields.phase === 'kilo_restarted'));
    expect(nativeDiagnostics).toEqual([
      {
        event: 'wrapper.lifecycle',
        fields: { phase: 'kilo_restarting', kiloRestartReason: 'exit' },
      },
      {
        event: 'wrapper.lifecycle',
        fields: { phase: 'kilo_restarted', kiloRestartReason: 'exit' },
      },
    ]);
    await runtime.shutdown();
  });

  it('emits kilo_restart_failed and not kilo_restarted when the replacement spawn rejects', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    let spawnCalls = 0;
    const { runtime, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      spawnKilo: async input => {
        spawnCalls += 1;
        if (spawnCalls >= 2) throw new Error('spawn boom');
        return spawner.spawn(input);
      },
    });
    await runtime.ensure();

    spawner.processes[0]!.exit();
    await waitFor(() =>
      nativeDiagnostics.some(entry => entry.fields.phase === 'kilo_restart_failed')
    );
    expect(nativeDiagnostics.some(entry => entry.fields.phase === 'kilo_restarted')).toBe(false);
    await runtime.shutdown();
  });

  it('does not emit a restart outcome when shutdown interrupts replacement preparation', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const gate = Promise.withResolvers<void>();
    let preparations = 0;
    const { runtime, nativeDiagnostics, logs } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      prepareFilesystem: async () => {
        preparations += 1;
        if (preparations === 2) await gate.promise;
      },
    });
    await runtime.ensure();

    spawner.processes[0]!.exit();
    await waitFor(() => preparations === 2);
    await runtime.shutdown();
    gate.resolve();
    await waitFor(() => logs.some(message => message.includes('kilo restart failed')));

    expect(runtime.phase()).toBe('stopped');
    expect(spawner.spawnCount()).toBe(1);
    expect(nativeDiagnostics).toEqual([
      {
        event: 'wrapper.lifecycle',
        fields: { phase: 'kilo_restarting', kiloRestartReason: 'exit' },
      },
    ]);
  });

  it('runs onRestart only after the runtime reports it is no longer restarting', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime, restarts, restartingAtOnRestart } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
    });
    await runtime.ensure();

    spawner.processes[0]!.exit();
    await waitFor(() => restarts.length === 1);
    expect(restartingAtOnRestart).toEqual([false]);
    expect(runtime.isRestarting()).toBe(false);
    await runtime.shutdown();
  });

  it('swallows a throwing onRestart handler without stranding the runtime', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      onRestart: () => {
        throw new Error('handler boom');
      },
    });
    await runtime.ensure();

    spawner.processes[0]!.exit();
    await waitFor(() => restarts.length === 1);
    expect(runtime.isRestarting()).toBe(false);
    expect(runtime.isUnavailable()).toBe(false);
    await runtime.ensure();
    await runtime.shutdown();
  });

  it('cleans up a failed start so the next ensure spawns a fresh Kilo', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory({ failOpens: 1 });
    const probe = createProbe(false);
    const { runtime } = createRuntime({ spawner, feed, probe, scheduler });

    let failure: unknown;
    try {
      await runtime.ensure();
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error ? failure.message : String(failure)).toContain(
      'feed failed to open'
    );
    expect(spawner.processes[0]!.stopped).toBe(1);

    const client = await runtime.ensure();
    expect(spawner.spawnCount()).toBe(2);
    expect(client).toBeDefined();
  });

  it('restarts at once when 30 s of silence gets no health answer', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime, restarts, logs } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => spawner.spawnCount() === 2);

    expect(probe.calls.count).toBe(1);
    expect(restarts).toEqual([{ reason: 'hang' }]);
    expect(
      logs.some(message => message.includes('kilo restarting') && message.includes('reason=hang'))
    ).toBe(true);
    expect(
      logs.some(message => message.includes('kilo restarted') && message.includes('reason=hang'))
    ).toBe(true);
  });

  it('keeps the suspect state during silence until the next event', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const { runtime, restarts } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    // Hold the next health probe so the recovery loop does not replace the
    // stream before the assertion; suspicion clears on a delivered event.
    probe.set(() => new Promise(() => {}));
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => runtime.isSuspected());

    expect(spawner.spawnCount()).toBe(1);
    expect(restarts).toEqual([]);

    const event: KiloFeedEvent = { type: 'message.updated', properties: {}, nativeRuntimeId: 'r' };
    feed.feeds[0]!.callbacks.onEvent(event);
    expect(runtime.isSuspected()).toBe(false);
    await runtime.shutdown();
  });

  it('reconnects the stream and counts it when the health probe answers', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      timers: timers({
        sseSilenceMs: 100,
        healthRequestMs: 1_000,
        sseReconnectLimit: 6,
        sseReconnectWindowMs: 120_000,
        kiloRestartLimit: 3,
        kiloRestartWindowMs: 60_000,
      }),
    });

    await runtime.ensure();
    expect(feed.feeds.length).toBe(1);

    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => feed.feeds.length === 2);

    // The stalled feed was closed without restarting Kilo, and a fresh stream
    // was attached for the same live process.
    expect(feed.feeds[0]!.closed).toBe(1);
    expect(spawner.spawnCount()).toBe(1);
    expect(restarts).toEqual([]);
    await runtime.shutdown();
  });

  it('restarts Kilo after sseReconnectLimit reconnects inside the window', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    // Production-shaped ratio: the window is four silence thresholds, so a
    // connect frame that ended the episode would cap reconnects at four per
    // window and the limit would never be reached.
    const activeTimers = timers({
      sseSilenceMs: 6_000,
      healthRequestMs: 1_000,
      sseReconnectLimit: 6,
      sseReconnectWindowMs: 24_000,
      kiloRestartLimit: 3,
      kiloRestartWindowMs: 600_000,
    });
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      timers: activeTimers,
    });

    await runtime.ensure();
    // Drive the watchdog one tick at a time. The connect frame does not clear
    // the episode, so every stream that stays silent past its proof window is
    // replaced until the reconnect budget is spent.
    let ticks = 0;
    while (restarts.length === 0 && ticks < 60) {
      scheduleTick(scheduler, activeTimers);
      ticks += 1;
      await Bun.sleep(1);
    }

    expect(restarts).toEqual([{ reason: 'hang' }]);
    expect(spawner.spawnCount()).toBe(2);
    // Six reconnects happened before the restart, not one "recovered" connect.
    expect(feed.feeds.length).toBeGreaterThanOrEqual(7);
    await runtime.shutdown();
  });

  describe('with production timings', () => {
    const PRODUCTION_SILENCE = timers({
      sseSilenceMs: 30_000,
      healthRequestMs: 5_000,
      sseReconnectLimit: 6,
      sseReconnectWindowMs: 120_000,
      kiloRestartLimit: 3,
      kiloRestartWindowMs: 600_000,
    });
    const TICK_MS = 5_000;

    async function tick(scheduler: FakeScheduler, count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        scheduleTick(scheduler, PRODUCTION_SILENCE);
        await Bun.sleep(2);
      }
    }

    async function silentStreamReconnectedOnce() {
      const spawner = createSpawner();
      const scheduler = createScheduler();
      const feed = createFeedFactory();
      const probe = createProbe(true);
      const created = createRuntime({
        spawner,
        feed,
        probe,
        scheduler,
        timers: PRODUCTION_SILENCE,
      });
      await created.runtime.ensure();
      scheduleSilence(scheduler, PRODUCTION_SILENCE);
      await waitFor(() => feed.feeds.length === 2);
      return { ...created, spawner, scheduler, feed, probe };
    }

    it('lets a reconnected stream deliver its heartbeat before replacing it', async () => {
      const { runtime, restarts, spawner, scheduler, feed, probe } =
        await silentStreamReconnectedOnce();

      // Kilo's first heartbeat arrives 10 s after connect, so the stream must
      // survive two 5 s checks with nothing delivered.
      await tick(scheduler, 2);
      expect(feed.feeds.length).toBe(2);
      expect(feed.feeds[1]!.closed).toBe(0);

      const heartbeat: KiloFeedEvent = {
        type: 'server.heartbeat',
        properties: {},
        nativeRuntimeId: 'r',
      };
      feed.feeds[1]!.callbacks.onEvent(heartbeat);
      expect(runtime.isSuspected()).toBe(false);

      await tick(scheduler, 4);
      expect(feed.feeds.length).toBe(2);
      expect(spawner.spawnCount()).toBe(1);
      expect(restarts).toEqual([]);
      expect(probe.calls.count).toBe(1);
      await runtime.shutdown();
    });

    it('replaces a reconnected stream that stays silent after its proof window', async () => {
      const { runtime, restarts, spawner, scheduler, feed } = await silentStreamReconnectedOnce();

      await tick(scheduler, 2);
      expect(feed.feeds.length).toBe(2);

      await tick(scheduler, 1);
      await waitFor(() => feed.feeds.length === 3);
      expect(feed.feeds[1]!.closed).toBe(1);
      expect(spawner.spawnCount()).toBe(1);
      expect(restarts).toEqual([]);
      await runtime.shutdown();
    });

    it('spends the six reconnects inside the two-minute window before restarting', async () => {
      const { runtime, restarts, spawner, scheduler, feed } = await silentStreamReconnectedOnce();

      let elapsed = 0;
      while (restarts.length === 0 && elapsed < 120_000) {
        await tick(scheduler, 1);
        elapsed += TICK_MS;
      }

      expect(restarts).toEqual([{ reason: 'hang' }]);
      expect(elapsed).toBeLessThan(120_000);
      expect(feed.feeds.length).toBeGreaterThanOrEqual(7);
      await waitFor(() => spawner.spawnCount() === 2);
      await runtime.shutdown();
    });
  });

  it('clears the reconnect budget for a new Kilo after a budget restart', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const activeTimers = timers({
      sseSilenceMs: 6_000,
      healthRequestMs: 1_000,
      sseReconnectLimit: 6,
      sseReconnectWindowMs: 24_000,
      kiloRestartLimit: 3,
      kiloRestartWindowMs: 600_000,
    });
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      timers: activeTimers,
    });

    await runtime.ensure();
    let ticks = 0;
    while (restarts.length === 0 && ticks < 60) {
      scheduleTick(scheduler, activeTimers);
      ticks += 1;
      await Bun.sleep(1);
    }
    expect(restarts).toEqual([{ reason: 'hang' }]);
    await waitFor(() => spawner.spawnCount() === 2);
    await Bun.sleep(10);

    // An ordinary drop on the fresh Kilo must reconnect, not restart again.
    const feedsAfterRestart = feed.feeds.length;
    feed.feeds[feedsAfterRestart - 1]!.callbacks.onFailure();
    await waitFor(() => feed.feeds.length === feedsAfterRestart + 1);
    expect(spawner.spawnCount()).toBe(2);
    expect(restarts).toEqual([{ reason: 'hang' }]);
    await runtime.shutdown();
  });

  it('completes an attempt and reconnects when the stream ends', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const { runtime, restarts } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    feed.feeds[0]!.callbacks.onFailure();
    await waitFor(() => feed.feeds.length === 2);

    // The stream end completed a recovery attempt and reconnected the same
    // live process; it did not restart Kilo.
    expect(feed.feeds[0]!.closed).toBe(1);
    expect(spawner.spawnCount()).toBe(1);
    expect(restarts).toEqual([]);
    await runtime.shutdown();
  });

  it('does not restart Kilo immediately for a stream drop while it is healthy', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const { runtime, restarts } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    feed.feeds[0]!.callbacks.onFailure();
    await Bun.sleep(5);
    expect(spawner.spawnCount()).toBe(1);
    expect(restarts).toEqual([]);
    await runtime.shutdown();
  });

  it('prunes reconnect attempts outside sseReconnectWindowMs', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      timers: timers({
        sseSilenceMs: 100,
        healthRequestMs: 1_000,
        sseReconnectLimit: 2,
        sseReconnectWindowMs: 100,
        kiloRestartLimit: 3,
        kiloRestartWindowMs: 60_000,
      }),
    });

    await runtime.ensure();
    feed.feeds[0]!.callbacks.onFailure();
    await waitFor(() => feed.feeds.length === 2);
    await Bun.sleep(5);

    scheduler.advance(200);
    feed.feeds[1]!.callbacks.onFailure();
    await waitFor(() => feed.feeds.length === 3);
    await Bun.sleep(5);

    scheduler.advance(200);
    feed.feeds[2]!.callbacks.onFailure();
    await waitFor(() => feed.feeds.length === 4);

    // Each attempt aged out of the window before the next, so the limit never
    // accumulated and Kilo was never restarted.
    expect(restarts).toEqual([]);
    expect(spawner.spawnCount()).toBe(1);
    await runtime.shutdown();
  });

  it('allows three restarts in the window and then reports the runtime unavailable', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime, unavailable, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
    });

    await runtime.ensure();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      scheduleSilence(scheduler, TEST_TIMERS);
      await waitFor(() => spawner.spawnCount() === attempt + 2);
    }
    expect(runtime.isUnavailable()).toBe(false);

    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => runtime.isUnavailable());
    expect(unavailable()).toBe(1);
    expect(spawner.spawnCount()).toBe(4);
    expect(runtime.isSuspected()).toBe(true);
    expect(nativeDiagnostics).toContainEqual({
      event: 'wrapper.lifecycle',
      fields: { phase: 'kilo_unavailable' },
    });
  });

  it('installs refreshed credentials by restarting without spending the crash budget', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime, restarts, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      isIdle: () => true,
    });

    await runtime.ensure();
    await runtime.installCredentials({ HOME: '/new' });
    expect(spawner.spawnCount()).toBe(1);
    expect(await runtime.applyPendingCredentials(() => true)).toBe(true);
    await waitFor(() => spawner.spawnCount() === 2);
    expect(runtime.env.HOME).toBe('/new');
    expect(restarts).toEqual([{ reason: 'credentials' }]);
    // A credential refresh is not a fault and is not projected.
    expect(
      nativeDiagnostics.filter(
        entry => typeof entry.fields.phase === 'string' && entry.fields.phase.startsWith('kilo_')
      )
    ).toHaveLength(0);

    // The credential restart must not consume the 3-in-10 crash budget.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      scheduleSilence(scheduler, TEST_TIMERS);
      await waitFor(() => spawner.spawnCount() === attempt + 3);
    }
    expect(runtime.isUnavailable()).toBe(false);
  });

  it('defers the credential restart while a turn is busy but records the new env', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    let idle = false;
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      isIdle: () => idle,
    });

    await runtime.ensure();
    await runtime.installCredentials({ HOME: '/new' });
    expect(spawner.spawnCount()).toBe(1);
    expect(runtime.env.HOME).toBe('/new');
    expect(await runtime.applyPendingCredentials(() => true)).toBe(false);
    expect(restarts).toEqual([]);

    idle = true;
    expect(await runtime.applyPendingCredentials(() => true)).toBe(true);
    await waitFor(() => spawner.spawnCount() === 2);
    expect(restarts).toEqual([{ reason: 'credentials' }]);
  });

  it('does not restart when the idle probe fails or hangs', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      isIdle: () => Promise.reject(new Error('probe failed')),
    });

    await runtime.ensure();
    await runtime.installCredentials({ HOME: '/new' });
    expect(spawner.spawnCount()).toBe(1);
    expect(await runtime.applyPendingCredentials(() => true)).toBe(false);
    expect(restarts).toEqual([]);
  });

  it('probes once per silence episode and reconnects without re-probing', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const { runtime } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => feed.feeds.length === 2);
    expect(probe.calls.count).toBe(1);

    // The connect frame did not end the episode, so the next silence reconnects
    // without another health probe.
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => feed.feeds.length === 3);
    await Bun.sleep(5);
    expect(probe.calls.count).toBe(1);

    // A real event ends the episode, so the next silence probes again.
    const event: KiloFeedEvent = { type: 'message.updated', properties: {}, nativeRuntimeId: 'r' };
    feed.feeds[2]!.callbacks.onEvent(event);
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => probe.calls.count === 2);
    await runtime.shutdown();
  });

  it('aborts a hung Kilo startup at the start deadline', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const hang: KiloProcessSpawner = input =>
      new Promise((_resolve, reject) => {
        if (input.signal?.aborted) {
          reject(new Error('Kilo server startup aborted'));
          return;
        }
        input.signal?.addEventListener(
          'abort',
          () => reject(new Error('Kilo server startup aborted')),
          { once: true }
        );
      });
    const { runtime } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      spawnKilo: hang,
      timers: timers({
        sseSilenceMs: 100,
        healthRequestMs: 1_000,
        kiloRestartLimit: 3,
        kiloRestartWindowMs: 60_000,
        kiloRuntimeStartMs: 30,
      }),
    });

    let failure: unknown;
    try {
      await runtime.ensure();
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error ? failure.message : String(failure)).toContain(
      'startup aborted'
    );
  });

  it('clears the dead client on stop so ensure re-spawns after a failed restart', async () => {
    let calls = 0;
    const processes: Array<{ pid: number; stopped: number; exit: () => void }> = [];
    let nextPid = 5_000;
    const spawner: KiloProcessSpawner = async () => {
      calls += 1;
      if (calls === 2) throw new Error('spawn failed');
      const pid = nextPid++;
      const deferred = Promise.withResolvers<void>();
      const record = { pid, stopped: 0, exit: () => deferred.resolve() };
      processes.push(record);
      return {
        pid,
        url: `http://127.0.0.1:${pid}`,
        exited: deferred.promise,
        stop: async () => {
          record.stopped += 1;
          return true;
        },
      };
    };
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const scheduler = createScheduler();
    const { runtime } = createRuntime({
      spawner: { spawn: spawner, processes, spawnCount: () => calls },
      feed,
      probe,
      scheduler,
    });

    await runtime.ensure();
    processes[0]!.exit();
    await waitFor(() => calls === 2);
    await Bun.sleep(5);
    await runtime.ensure();
    expect(calls).toBe(3);
  });

  it('keeps restarting toward the budget after a failed restart leaves no client', async () => {
    let calls = 0;
    const processes: FakeProcessRecord[] = [];
    let nextPid = 7_000;
    const spawner: KiloProcessSpawner = async () => {
      calls += 1;
      if (calls >= 2) throw new Error('spawn failed');
      const pid = nextPid++;
      const deferred = Promise.withResolvers<void>();
      const record: FakeProcessRecord = { pid, stopped: 0, exit: () => deferred.resolve() };
      processes.push(record);
      return {
        pid,
        url: `http://127.0.0.1:${pid}`,
        exited: deferred.promise,
        stop: async () => {
          record.stopped += 1;
          return true;
        },
      };
    };
    const feed = createFeedFactory();
    const probe = createProbe(true);
    const scheduler = createScheduler();
    const { runtime, unavailable } = createRuntime({
      spawner: { spawn: spawner, processes, spawnCount: () => calls },
      feed,
      probe,
      scheduler,
    });

    await runtime.ensure();
    expect(calls).toBe(1);
    // The restart fails, so `stopProcess` has cleared the client and the failed
    // start leaves no exit hook; only the watchdog can restart it.
    processes[0]!.exit();
    await waitFor(() => calls === 2);
    await waitFor(() => !runtime.isRestarting());

    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => calls === 3);
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => calls === 4);
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => runtime.isUnavailable());
    expect(unavailable()).toBe(1);
  });

  it('creates the Kilo home, auth file, runtime dir and worktree before spawn', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilo-fs-'));
    try {
      const dataHome = path.join(root, 'data');
      const runtimeDir = path.join(root, 'run');
      const worktree = path.join(root, 'worktree');
      const spawner = createSpawner();
      const scheduler = createScheduler();
      const feed = createFeedFactory();
      const probe = createProbe(true);
      const { runtime } = createRuntime({
        spawner,
        feed,
        probe,
        scheduler,
        directory: worktree,
        env: {
          XDG_DATA_HOME: dataHome,
          XDG_RUNTIME_DIR: runtimeDir,
          KILO_AUTH_CONTENT: '{"token":"x"}',
        },
      });

      await runtime.ensure();

      const authDirectory = path.join(dataHome, 'kilo');
      expect(await fsp.readFile(path.join(authDirectory, 'auth.json'), 'utf8')).toBe(
        '{"token":"x"}'
      );
      expect((await fsp.stat(authDirectory)).mode & 0o777).toBe(0o700);
      expect((await fsp.stat(path.join(authDirectory, 'auth.json'))).mode & 0o777).toBe(0o600);
      expect((await fsp.stat(runtimeDir)).mode & 0o777).toBe(0o700);
      await fsp.access(worktree);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe('Kilo hang restart under memory pressure', () => {
  const LIMIT = 11 * 1024 * 1024 * 1024;

  /** The workload parent sits at its cap and keeps hitting it, as during reclaim. */
  function reclaimingAtCap() {
    let maxEvents = 0;
    return () => ({ currentBytes: LIMIT - 4096, limitBytes: LIMIT, maxEvents: (maxEvents += 1) });
  }

  function holdPhases(
    nativeDiagnostics: Array<{ event: string; fields: ControlDiagnosticFields }>
  ) {
    return nativeDiagnostics
      .map(record => record.fields)
      .filter(fields => String(fields.phase).startsWith('kilo_memory_hold'))
      .map(fields => [fields.phase, fields.memoryHoldOutcome]);
  }

  it('keeps a silent Kilo running while reclaiming and resumes it without a restart', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const memoryHolds: boolean[] = [];
    const { runtime, restarts, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      sampleMemory: reclaimingAtCap(),
      memoryHolds,
    });

    await runtime.ensure();
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => memoryHolds.length === 1);
    // Each check probes again, so a Kilo that recovers is seen within one check.
    scheduleTick(scheduler, TEST_TIMERS);
    await waitFor(() => probe.calls.count === 2);
    // Let the second decision settle; a check during an in-flight probe is skipped.
    await Bun.sleep(5);
    expect(restarts).toEqual([]);
    expect(runtime.isSuspected()).toBe(true);

    probe.set(true);
    scheduleTick(scheduler, TEST_TIMERS);
    await waitFor(() => feed.feeds.length === 2);
    feed.feeds[1]!.callbacks.onEvent({
      type: 'server.heartbeat',
      properties: {},
      nativeRuntimeId: 'r',
    });
    // The next check sees Kilo delivering events and observable, and ends the hold.
    scheduleTick(scheduler, TEST_TIMERS);
    await waitFor(() => memoryHolds.length === 2);

    expect(spawner.spawnCount()).toBe(1);
    expect(restarts).toEqual([]);
    expect(memoryHolds).toEqual([true, false]);
    expect(holdPhases(nativeDiagnostics)).toEqual([
      ['kilo_memory_hold_started', undefined],
      ['kilo_memory_hold_ended', 'recovered'],
    ]);
    await runtime.shutdown();
  });

  it('restarts Kilo once the hold reaches kiloMemoryHoldMs', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const memoryHolds: boolean[] = [];
    const activeTimers = timers({ sseSilenceMs: 100, kiloMemoryHoldMs: 1_000 });
    const { runtime, restarts, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      timers: activeTimers,
      sampleMemory: reclaimingAtCap(),
      memoryHolds,
    });

    await runtime.ensure();
    scheduleSilence(scheduler, activeTimers);
    await waitFor(() => memoryHolds.length === 1);
    scheduler.advance(1_000);
    scheduler.fire();
    await waitFor(() => spawner.spawnCount() === 2);

    expect(restarts).toEqual([{ reason: 'hang', outcomeReason: 'sandbox_out_of_memory' }]);
    expect(memoryHolds).toEqual([true, false]);
    expect(holdPhases(nativeDiagnostics)).toEqual([
      ['kilo_memory_hold_started', undefined],
      ['kilo_memory_hold_ended', 'expired'],
    ]);
    await runtime.shutdown();
  });

  it('holds failed activity observation once, then restarts at kiloMemoryHoldMs', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const memoryHolds: boolean[] = [];
    const activeTimers = timers({
      sseSilenceMs: 100,
      sseReconnectWindowMs: 1_000,
      kiloMemoryHoldMs: 3_000,
    });
    const snapshots = { fail: false };
    const { runtime, restarts, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe: createProbe(true),
      scheduler,
      timers: activeTimers,
      sampleMemory: reclaimingAtCap(),
      memoryHolds,
      readSnapshot: async () => {
        if (snapshots.fail) throw new Error('Kilo activity request timed out');
        return [];
      },
    });
    /** The feed stays alive: Kilo heartbeats while its snapshot reads time out. */
    async function heartbeatAndAdvance(ms: number) {
      scheduler.advance(ms);
      feed.feeds.at(-1)!.callbacks.onEvent({
        type: 'server.heartbeat',
        properties: {},
        nativeRuntimeId: 'r',
      });
      scheduler.fire();
      await Bun.sleep(1);
    }

    await runtime.ensure();
    snapshots.fail = true;
    await heartbeatAndAdvance(SESSION_SNAPSHOT_INTERVAL_MS);
    await heartbeatAndAdvance(1_000);
    expect(memoryHolds).toEqual([true]);
    for (let elapsed = 0; elapsed < 2_500; elapsed += 500) await heartbeatAndAdvance(500);
    expect(restarts).toEqual([]);
    expect(memoryHolds).toEqual([true]);

    await heartbeatAndAdvance(500);
    await waitFor(() => spawner.spawnCount() === 2);
    expect(restarts).toEqual([{ reason: 'hang', outcomeReason: 'sandbox_out_of_memory' }]);
    expect(holdPhases(nativeDiagnostics)).toEqual([
      ['kilo_memory_hold_started', undefined],
      ['kilo_memory_hold_ended', 'expired'],
    ]);
    await runtime.shutdown();
  });

  it('ends an observation hold as recovered when a snapshot succeeds again', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const memoryHolds: boolean[] = [];
    const activeTimers = timers({
      sseSilenceMs: 100,
      sseReconnectWindowMs: 1_000,
      kiloMemoryHoldMs: 60_000,
    });
    const snapshots = { fail: false };
    const { runtime, restarts, nativeDiagnostics } = createRuntime({
      spawner,
      feed,
      probe: createProbe(true),
      scheduler,
      timers: activeTimers,
      sampleMemory: reclaimingAtCap(),
      memoryHolds,
      readSnapshot: async () => {
        if (snapshots.fail) throw new Error('Kilo activity request timed out');
        return [];
      },
    });
    async function heartbeatAndAdvance(ms: number) {
      scheduler.advance(ms);
      feed.feeds.at(-1)!.callbacks.onEvent({
        type: 'server.heartbeat',
        properties: {},
        nativeRuntimeId: 'r',
      });
      scheduler.fire();
      await Bun.sleep(1);
    }

    await runtime.ensure();
    snapshots.fail = true;
    await heartbeatAndAdvance(SESSION_SNAPSHOT_INTERVAL_MS);
    await heartbeatAndAdvance(1_000);
    expect(memoryHolds).toEqual([true]);

    snapshots.fail = false;
    await heartbeatAndAdvance(SESSION_SNAPSHOT_INTERVAL_MS);
    await heartbeatAndAdvance(500);

    expect(spawner.spawnCount()).toBe(1);
    expect(restarts).toEqual([]);
    expect(memoryHolds).toEqual([true, false]);
    expect(holdPhases(nativeDiagnostics)).toEqual([
      ['kilo_memory_hold_started', undefined],
      ['kilo_memory_hold_ended', 'recovered'],
    ]);
    await runtime.shutdown();
  });

  it('restarts at once when the cap is full of idle page cache', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const memoryHolds: boolean[] = [];
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      sampleMemory: () => ({ currentBytes: LIMIT, limitBytes: LIMIT, maxEvents: 7 }),
      memoryHolds,
    });

    await runtime.ensure();
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => spawner.spawnCount() === 2);

    expect(restarts).toEqual([{ reason: 'hang' }]);
    expect(memoryHolds).toEqual([]);
    await runtime.shutdown();
  });
});

describe('kilo-runtime hang-rule ownership', () => {
  it('does not import the legacy sandbox-control-runtime module', async () => {
    const source = await fsp.readFile(path.join(import.meta.dir, 'kilo-runtime.ts'), 'utf8');
    expect(source).not.toContain('sandbox-control-runtime');
  });
});

describe('kilo runtime phase mapping', () => {
  it('maps silence to suspected, not restarting or unavailable', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    // Hold the probe so the runtime stays in the silence episode while asserting.
    probe.set(() => new Promise(() => {}));
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => runtime.isSuspected());

    expect(runtime.isSuspected()).toBe(true);
    expect(runtime.isRestarting()).toBe(false);
    expect(runtime.isUnavailable()).toBe(false);
    await runtime.shutdown();
  });

  it('maps a restart to restarting while Kilo is replaced', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const duringRestart: Array<{ restarting: boolean; unavailable: boolean; suspected: boolean }> =
      [];
    let spawnCalls = 0;
    const baseSpawn = spawner.spawn;
    const runtimeRef: { current?: ReturnType<typeof createKiloRuntime> } = {};
    const { runtime, restarts } = createRuntime({
      spawner,
      feed,
      probe,
      scheduler,
      spawnKilo: input => {
        spawnCalls += 1;
        if (spawnCalls > 1) {
          duringRestart.push({
            restarting: runtimeRef.current!.isRestarting(),
            unavailable: runtimeRef.current!.isUnavailable(),
            suspected: runtimeRef.current!.isSuspected(),
          });
        }
        return baseSpawn(input);
      },
    });
    runtimeRef.current = runtime;

    await runtime.ensure();
    spawner.processes[0]!.exit();
    await waitFor(() => restarts.length === 1);

    expect(duringRestart).toEqual([{ restarting: true, unavailable: false, suspected: true }]);
    expect(runtime.isRestarting()).toBe(false);
    await runtime.shutdown();
  });

  it('maps spending the crash budget to unavailable', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime, unavailable } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      scheduleSilence(scheduler, TEST_TIMERS);
      await waitFor(() => spawner.spawnCount() === attempt + 2);
    }
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => runtime.isUnavailable());

    expect(runtime.isUnavailable()).toBe(true);
    expect(runtime.isSuspected()).toBe(true);
    expect(runtime.isRestarting()).toBe(false);
    expect(unavailable()).toBe(1);
    await runtime.shutdown();
  });

  it('maps a deliberate stop to stopped', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const { runtime } = createRuntime({ spawner, feed, probe, scheduler });

    await runtime.ensure();
    await runtime.shutdown();

    let failure: unknown;
    try {
      await runtime.ensure();
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error ? failure.message : String(failure)).toContain('shutting down');
    expect(runtime.isSuspected()).toBe(false);
    expect(runtime.isRestarting()).toBe(false);
    expect(runtime.isUnavailable()).toBe(false);
    expect(spawner.spawnCount()).toBe(1);
  });
});

describe('createKiloRuntimes', () => {
  it('replaces an unavailable runtime on the next ensure so the budget is fresh', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const runtimes = createKiloRuntimes({
      readSnapshot: async () => [],
      timers: TEST_TIMERS,
      pidfileDirectory: '/tmp/kilo-runtimes-test-pids',
      scheduler: scheduler.scheduler,
      spawnKilo: spawner.spawn,
      openFeed: feed.openFeed,
      probeHealth: probe.probe,
      readProcessStartTime: () => undefined,
      log: () => undefined,
    });
    await runtimes.ensure({ key: 'dir', directory: '/tmp/dir', env: {} });
    const first = runtimes.get('dir');
    expect(first).toBeDefined();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      spawner.processes[attempt]!.exit();
      await waitFor(() => spawner.spawnCount() === attempt + 2);
    }
    spawner.processes[3]!.exit();
    await waitFor(() => first!.isUnavailable());
    expect(runtimes.unavailable()).toBe(true);

    await runtimes.ensure({ key: 'dir', directory: '/tmp/dir', env: {} });
    expect(runtimes.get('dir')).not.toBe(first);
    expect(runtimes.unavailable()).toBe(false);
  });

  it('carries the runtime key into onRestart, onUnavailable and onMemoryHold', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const restarts: Array<{ directory: string; reason: string; key: string }> = [];
    const unavailable: Array<{ directory: string; key: string }> = [];
    const memoryHolds: Array<{ directory: string; held: boolean; key: string }> = [];
    let captured: KiloRuntimeOptions | undefined;
    const runtimes = createKiloRuntimes({
      readSnapshot: async () => [],
      timers: TEST_TIMERS,
      pidfileDirectory: '/tmp/kilo-runtimes-key-test-pids',
      scheduler: scheduler.scheduler,
      spawnKilo: spawner.spawn,
      openFeed: feed.openFeed,
      probeHealth: probe.probe,
      readProcessStartTime: () => undefined,
      log: () => undefined,
      onRestart: info => restarts.push(info),
      onUnavailable: (directory, key) => unavailable.push({ directory, key }),
      onMemoryHold: info => memoryHolds.push(info),
      createRuntime: options => {
        captured = options;
        return createKiloRuntime(options);
      },
    });
    await runtimes.ensure({ key: 'session-a', directory: '/tmp/dir', env: {} });
    expect(captured).toBeDefined();

    captured!.onRestart?.({ directory: '/tmp/dir', reason: 'hang' });
    captured!.onUnavailable?.('/tmp/dir');
    captured!.onMemoryHold?.({ directory: '/tmp/dir', held: true });
    expect(restarts).toEqual([{ directory: '/tmp/dir', reason: 'hang', key: 'session-a' }]);
    expect(unavailable).toEqual([{ directory: '/tmp/dir', key: 'session-a' }]);
    expect(memoryHolds).toEqual([{ directory: '/tmp/dir', held: true, key: 'session-a' }]);
    await runtimes.shutdown();
  });

  it('removes an unavailable runtime from the map before its shutdown completes', async () => {
    const shutdownStarted = Promise.withResolvers<void>();
    const releaseShutdown = Promise.withResolvers<void>();
    let unavailable = false;
    let firstEnsureCalls = 0;
    let created = 0;
    const runtimes = createKiloRuntimes({
      readSnapshot: async () => [],
      timers: TEST_TIMERS,
      pidfileDirectory: '/tmp/kilo-runtimes-retire-test-pids',
      createRuntime: () => {
        created += 1;
        const isFirst = created === 1;
        return {
          directory: '/tmp/dir',
          env: {},
          client: {},
          ensure: async () => {
            if (!isFirst) return {};
            firstEnsureCalls += 1;
            // The real runtime reports `stopped`, so `ensure` on the retired
            // instance throws; a concurrent ensure must never reach it.
            if (firstEnsureCalls > 1) throw new Error('Kilo runtime is shutting down');
            return {};
          },
          installCredentials: async () => undefined,
          applyPendingCredentials: async () => false,
          isSuspected: () => false,
          isRestarting: () => false,
          isUnavailable: () => (isFirst ? unavailable : false),
          shutdown: async () => {
            if (!isFirst) return;
            shutdownStarted.resolve();
            await releaseShutdown.promise;
          },
        } as unknown as KiloRuntime;
      },
    });

    await runtimes.ensure({ key: 'dir', directory: '/tmp/dir', env: {} });
    const first = runtimes.get('dir');
    expect(first).toBeDefined();

    // Retire the unavailable runtime, holding its shutdown open.
    unavailable = true;
    const retire = runtimes.ensure({ key: 'dir', directory: '/tmp/dir', env: {} });
    await shutdownStarted.promise;

    expect(runtimes.get('dir')).toBeUndefined();
    const concurrent = await runtimes.ensure({ key: 'dir', directory: '/tmp/dir', env: {} });
    expect(concurrent).toBeDefined();
    expect(firstEnsureCalls).toBe(1);

    releaseShutdown.resolve();
    await retire;
    expect(runtimes.get('dir')).not.toBe(first);
  });

  it('summary counts a suspected runtime as suspected only', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const runtimes = createKiloRuntimes({
      readSnapshot: async () => [],
      timers: TEST_TIMERS,
      pidfileDirectory: '/tmp/kilo-runtimes-summary-pids',
      scheduler: scheduler.scheduler,
      spawnKilo: spawner.spawn,
      openFeed: feed.openFeed,
      probeHealth: probe.probe,
      readProcessStartTime: () => undefined,
      log: () => undefined,
    });
    await runtimes.ensure({ key: 'dir', directory: '/tmp/dir', env: {} });
    expect(runtimes.summary()).toEqual({
      runtimeCount: 1,
      suspectedCount: 0,
      restartingCount: 0,
      unavailableCount: 0,
    });

    probe.set(() => new Promise(() => {}));
    scheduleSilence(scheduler, TEST_TIMERS);
    await waitFor(() => runtimes.get('dir')?.phase() === 'suspected');
    expect(runtimes.summary()).toEqual({
      runtimeCount: 1,
      suspectedCount: 1,
      restartingCount: 0,
      unavailableCount: 0,
    });
    await runtimes.shutdown();
  });

  it('summary counts a restarting runtime as restarting, not suspected', async () => {
    const spawner = createSpawner();
    const scheduler = createScheduler();
    const feed = createFeedFactory();
    const probe = createProbe(false);
    const duringRestart: Array<ReturnType<KiloRuntimes['summary']>> = [];
    const holder: { runtimes?: KiloRuntimes } = {};
    let spawnCalls = 0;
    const baseSpawn = spawner.spawn;
    const runtimes = createKiloRuntimes({
      readSnapshot: async () => [],
      timers: TEST_TIMERS,
      pidfileDirectory: '/tmp/kilo-runtimes-summary-restart-pids',
      scheduler: scheduler.scheduler,
      spawnKilo: input => {
        spawnCalls += 1;
        if (spawnCalls > 1 && holder.runtimes) duringRestart.push(holder.runtimes.summary());
        return baseSpawn(input);
      },
      openFeed: feed.openFeed,
      probeHealth: probe.probe,
      readProcessStartTime: () => undefined,
      log: () => undefined,
    });
    holder.runtimes = runtimes;
    await runtimes.ensure({ key: 'dir', directory: '/tmp/dir', env: {} });
    spawner.processes[0]!.exit();
    await waitFor(() => spawnCalls >= 2);
    expect(duringRestart).toEqual([
      { runtimeCount: 1, suspectedCount: 0, restartingCount: 1, unavailableCount: 0 },
    ]);
    await runtimes.shutdown();
  });

  it('reuses a warm runtime for the same MCP config and rejects drift', async () => {
    let created = 0;
    const runtimes = createKiloRuntimes({
      readSnapshot: async () => [],
      timers: TEST_TIMERS,
      pidfileDirectory: '/tmp/kilo-runtimes-mcp-test-pids',
      createRuntime: options => {
        created += 1;
        return {
          directory: options.directory,
          env: options.env,
          client: {},
          ensure: async () => ({}),
          installCredentials: async () => undefined,
          applyPendingCredentials: async () => false,
          isSuspected: () => false,
          isRestarting: () => false,
          isUnavailable: () => false,
          shutdown: async () => undefined,
        } as unknown as KiloRuntime;
      },
    });
    const config = (mcp: unknown, token = 'alias-a') => ({
      KILO_CONFIG_CONTENT: JSON.stringify({ auth: { token }, mcp }),
    });
    const input = (mcp: unknown, token?: string) => ({
      key: 'session-a',
      directory: '/tmp/dir',
      env: config(mcp, token),
    });

    await runtimes.ensure(input({ a: 1 }));
    await runtimes.ensure(input({ a: 1 }));
    expect(created).toBe(1);

    // A credential rotation changes the Kilo alias, not the MCP set: reuse.
    await runtimes.ensure(input({ a: 1 }, 'alias-b'));
    expect(created).toBe(1);

    let drift: unknown;
    try {
      await runtimes.ensure(input({ a: 2 }));
    } catch (error) {
      drift = error;
    }
    expect(drift).toBeInstanceOf(KiloWorktreeMcpMismatchError);
    // Drift must not silently recreate the runtime with the changed servers.
    expect(created).toBe(1);
  });
});

/** Advances the fake clock by one silence window, then runs the watchdog tick. */
function scheduleSilence(scheduler: FakeScheduler, activeTimers: ControlPlaneTimers): void {
  scheduler.advance(activeTimers.wrapper.sseSilenceMs);
  scheduler.fire();
}

/** Advances one watchdog tick, matching the runtime's `sseSilenceMs / 6` cadence. */
function scheduleTick(scheduler: FakeScheduler, activeTimers: ControlPlaneTimers): void {
  scheduler.advance(Math.max(1, Math.floor(activeTimers.wrapper.sseSilenceMs / 6)));
  scheduler.fire();
}
