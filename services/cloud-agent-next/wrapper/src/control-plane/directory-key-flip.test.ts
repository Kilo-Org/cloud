import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CONTROL_PLANE_TIMERS,
  type ControlPlaneTimers,
} from '../../../src/shared/control-plane-timers.js';
import type {
  ControlPlanePromptPayload,
  ControlPlaneRouteSpec,
  ControlPlaneSessionCredentialsPayload,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { KiloEventFeedSource } from './kilo-event-feed.js';
import {
  createKiloRuntimes,
  liveRuntimeClient,
  type KiloFeedCallbacks,
  type KiloProcess,
  type KiloProcessSpawner,
  type KiloRuntimes,
  type KiloRuntimeScheduler,
} from './kilo-runtime.js';
import { createPreparationManager, runtimeKey, type PreparationManager } from './prepare.js';
import { createTurnManager, type TurnManager } from './turn.js';
import { createControlPlaneTerminals, type ControlPlaneTerminalRuntime } from './terminals.js';
import { createControlPlaneFrameDispatcher } from './main.js';

const TEST_TIMERS: ControlPlaneTimers = {
  ...CONTROL_PLANE_TIMERS,
  wrapper: {
    ...CONTROL_PLANE_TIMERS.wrapper,
    kiloRuntimeStartMs: 5_000,
    cloneMs: 5_000,
    kiloSessionMs: 5_000,
    sseSilenceMs: 60_000,
  },
};

const DIRECTORY = '/workspace/directory-key-flip';
const SCOPE_ID = 'worktree_directory_key_flip';
const HOME_ROOT = '/tmp/directory-key-flip-homes';

const TARGETS = {
  backendBaseUrl: 'https://backend.test',
  providerBaseUrl: 'https://provider.test',
  sessionIngestBaseUrl: 'https://ingest.test',
};

function proxyHandle(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aud: 'cloud-agent-next:runtime-credential-proxy',
      exp: expSeconds,
      iat: expSeconds - 3_600,
    })
  ).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

const EXP_NOW = Math.floor(Date.now() / 1_000) + 3_600;

function routeSpec(
  sessionId: string,
  kiloSessionId: string,
  overrides: Partial<ControlPlaneRouteSpec> = {}
): ControlPlaneRouteSpec {
  return {
    sessionId,
    kiloSessionId,
    directory: DIRECTORY,
    attemptId: `${sessionId}-requested`,
    kilo: { scopeId: SCOPE_ID, token: proxyHandle(EXP_NOW), targets: TARGETS },
    ...overrides,
  };
}

function credentialsFor(sessionId: string, handle: string): ControlPlaneSessionCredentialsPayload {
  return { sessionId, kilo: { token: handle }, proxy: { handle, targets: TARGETS } };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await Bun.sleep(1);
  }
}

function createSpawner(): {
  spawn: KiloProcessSpawner;
  processes: Array<{ pid: number; stopped: number }>;
  spawnCount(): number;
} {
  let nextPid = 5_000;
  const processes: Array<{ pid: number; stopped: number }> = [];
  const spawn: KiloProcessSpawner = async () => {
    const pid = nextPid++;
    const record = { pid, stopped: 0 };
    processes.push(record);
    const process: KiloProcess = {
      pid,
      url: `http://127.0.0.1:${pid}`,
      authorization: 'Basic test',
      exited: new Promise<void>(() => undefined),
      stop: async () => {
        record.stopped += 1;
        return true;
      },
    };
    return process;
  };
  return { spawn, processes, spawnCount: () => processes.length };
}

function createFeedFactory(): {
  openFeed: (
    source: KiloEventFeedSource,
    callbacks: KiloFeedCallbacks
  ) => { open(): Promise<void>; close(): void };
} {
  return {
    openFeed: (source, callbacks) => ({
      open: async () => {
        callbacks.onEvent({
          type: 'server.connected',
          properties: {},
          nativeRuntimeId: source.nativeRuntimeId,
        });
      },
      close: () => undefined,
    }),
  };
}

function createScheduler(): KiloRuntimeScheduler {
  return {
    now: () => Date.now(),
    setInterval: () => Symbol('interval'),
    clearInterval: () => undefined,
  };
}

function createHarness() {
  const frames: ControlPlaneWrapperFrame[] = [];
  const send = (frame: ControlPlaneWrapperFrame): void => {
    frames.push(frame);
  };
  const spawner = createSpawner();
  const feed = createFeedFactory();
  let idle = true;

  const turnsRef: { current?: TurnManager } = {};
  const preparationRef: { current?: PreparationManager } = {};
  const terminalsRef: { current?: ControlPlaneTerminalRuntime } = {};

  const runtimes: KiloRuntimes = createKiloRuntimes({
    timers: TEST_TIMERS,
    readSnapshot: async () => [],
    log: () => undefined,
    scheduler: createScheduler(),
    spawnKilo: spawner.spawn,
    openFeed: feed.openFeed,
    probeHealth: async () => true,
    prepareFilesystem: async () => undefined,
    readProcessStartTime: () => undefined,
    isIdle: async () => idle,
    onEvent: event => turnsRef.current?.observeKiloEvent(event),
    onRestart: info => turnsRef.current?.onRuntimeRestart(info),
    onUnavailable: (directory, key) => turnsRef.current?.onRuntimeUnavailable(directory, key),
  });

  const terminals = createControlPlaneTerminals({
    controlUrl: 'https://control.test',
    wrapperId: 'wrapper_test',
    runtimes,
  });
  terminalsRef.current = terminals;

  const turns = createTurnManager({
    timers: TEST_TIMERS,
    emit: send,
    runtimes: { get: key => runtimes.get(key) },
    log: () => undefined,
  });
  turnsRef.current = turns;

  const preparation = createPreparationManager({
    timers: TEST_TIMERS,
    emit: send,
    allocationId: 'alloc_directory_key_flip',
    runtimes: {
      ensure: async input => {
        const harness = await runtimes.ensure(input);
        harness.open = async () => true;
        return harness;
      },
      installCredentials: async (key, nextEnv) => {
        await runtimes.get(key)?.installCredentials(nextEnv);
        turns.credentialsInstalled(key);
      },
      isUnavailable: key => {
        const runtime = runtimes.get(key);
        return !runtime || runtime.isUnavailable();
      },
      getLiveClient: key => liveRuntimeClient(runtimes.get(key)),
      remove: key => runtimes.remove(key),
      release: key => runtimes.remove(key),
    },
    log: () => undefined,
    inheritedEnv: {},
    mkdir: async () => undefined,
    hasGit: async () => false,
    runSetup: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    homeRoot: HOME_ROOT,
  });
  preparationRef.current = preparation;

  const dispatcher = createControlPlaneFrameDispatcher({
    preparation: preparationRef,
    turns: turnsRef,
    terminals: terminalsRef,
    capture: { current: undefined },
    worktreeChanges: { current: undefined },
    worktreeDeletion: { current: undefined },
    kiloRequests: { current: undefined },
    send,
    log: () => undefined,
  });

  return {
    dispatcher,
    frames,
    spawner,
    runtimes,
    turns,
    terminals,
    preparation,
    set idle(value: boolean) {
      idle = value;
    },
  };
}

describe('directory-key flip (production dispatcher)', () => {
  it('serves two sibling modern routes in one directory from one runtime', async () => {
    const h = createHarness();
    try {
      const specA = routeSpec('ses_a', 'ses_kilo_a');
      const specB = routeSpec('ses_b', 'ses_kilo_b');
      const handle = proxyHandle(EXP_NOW);

      h.dispatcher({
        type: 'session.prepare',
        spec: specA,
        credentials: credentialsFor('ses_a', handle),
      });
      h.dispatcher({
        type: 'session.prepare',
        spec: specB,
        credentials: credentialsFor('ses_b', handle),
      });
      await waitFor(() => h.frames.filter(frame => frame.type === 'session.ready').length === 2);

      expect(h.spawner.spawnCount()).toBe(1);
      expect(runtimeKey(specA)).toBe(runtimeKey(specB));
      const ready = h.frames.filter(frame => frame.type === 'session.ready');
      expect(
        ready.map(frame => (frame.type === 'session.ready' ? frame.sessionId : '')).sort()
      ).toEqual(['ses_a', 'ses_b']);

      const runtime = h.runtimes.get(DIRECTORY);
      expect(runtime).toBeDefined();
      // Siblings share one HOME keyed by the worktree scope and directory.
      expect(runtime!.env.HOME).toBe(
        path.join(
          HOME_ROOT,
          createHash('sha256').update(SCOPE_ID).update('\0').update(DIRECTORY).digest('hex')
        )
      );
      const client = runtime!.client;
      const prompts: string[] = [];
      const aborts: string[] = [];
      const answers: string[] = [];
      let ptySeq = 0;
      client.submit = async opts => {
        prompts.push(opts.sessionId);
        h.turns.observeKiloEvent({
          type: 'session.turn.open',
          properties: { sessionID: opts.sessionId },
          nativeRuntimeId: 'rt',
        });
      };
      client.interrupt = async opts => {
        aborts.push(opts.sessionId);
        return true;
      };
      client.answer = async ({ reply, directory }) => {
        if (reply.action === 'answer') answers.push(`${reply.questionId}@${directory}`);
        return true;
      };
      client.terminals.createPty = async input => ({
        id: `pty_${(ptySeq += 1)}`,
        title: 'Terminal',
        command: '/bin/sh',
        args: [],
        cwd: input.cwd,
        status: 'running',
        pid: 1,
      });
      client.terminals.deletePty = async () => true;

      h.dispatcher({ type: 'session.prompt', sessionId: 'ses_a', payload: promptPayload('m1') });
      h.dispatcher({ type: 'session.prompt', sessionId: 'ses_b', payload: promptPayload('m2') });
      await waitFor(() => prompts.length === 2);
      expect(prompts.sort()).toEqual(['ses_kilo_a', 'ses_kilo_b']);

      h.dispatcher({ type: 'session.abort', sessionId: 'ses_a' });
      await waitFor(() => aborts.length === 1);
      expect(aborts).toEqual(['ses_kilo_a']);

      h.dispatcher({
        type: 'session.answer',
        sessionId: 'ses_b',
        reply: { action: 'answer', questionId: 'q1', answers: [['yes']] },
      });
      await waitFor(() => answers.length === 1);
      expect(answers).toEqual(['q1@/workspace/directory-key-flip']);

      for (const sessionId of ['ses_a', 'ses_b']) {
        h.dispatcher({
          type: 'terminal.create',
          requestId: `req_${sessionId}`,
          session: {
            sessionId,
            kiloSessionId: `ses_kilo_${sessionId.slice(-1)}`,
            directory: DIRECTORY,
          },
          payload: { operationId: crypto.randomUUID() },
        });
      }
      await waitFor(() => h.frames.filter(frame => frame.type === 'terminal.result').length === 2);
      const results = h.frames.filter(frame => frame.type === 'terminal.result');
      expect(results.every(frame => frame.type === 'terminal.result' && frame.ok)).toBe(true);
      expect(h.spawner.spawnCount()).toBe(1);

      // A sibling cannot close another session's PTY: it is not the owner.
      const created = results.find(
        frame => frame.type === 'terminal.result' && frame.requestId === 'req_ses_a' && frame.ok
      );
      const ptyId = (created as { result?: { pty?: { id?: string } } } | undefined)?.result?.pty
        ?.id;
      expect(ptyId).toBeDefined();
      h.dispatcher({
        type: 'terminal.close',
        requestId: 'close_from_sibling',
        session: { sessionId: 'ses_b', kiloSessionId: 'ses_kilo_b', directory: DIRECTORY },
        payload: { ptyId: ptyId as string },
      });
      await waitFor(() =>
        h.frames.some(
          frame => frame.type === 'terminal.result' && frame.requestId === 'close_from_sibling'
        )
      );
      expect(
        h.frames.find(
          frame => frame.type === 'terminal.result' && frame.requestId === 'close_from_sibling'
        )
      ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    } finally {
      await h.runtimes.shutdown();
    }
  });

  it('keeps legacy sibling runtimes and HOME separate across credential refresh and release', async () => {
    const h = createHarness();
    try {
      const first = routeSpec('ses_a', 'ses_kilo_a', { runtimeIsolation: 'per-session' });
      const second = routeSpec('ses_b', 'ses_kilo_b', { runtimeIsolation: 'per-session' });
      for (const spec of [first, second]) {
        h.dispatcher({
          type: 'session.prepare',
          spec,
          credentials: credentialsFor(spec.sessionId, proxyHandle(EXP_NOW)),
        });
      }
      await waitFor(() => h.frames.filter(frame => frame.type === 'session.ready').length === 2);
      expect(h.spawner.spawnCount()).toBe(2);
      const firstRuntime = h.runtimes.get(first.sessionId);
      const secondRuntime = h.runtimes.get(second.sessionId);
      expect(firstRuntime).toBeDefined();
      expect(secondRuntime).toBeDefined();
      expect(firstRuntime!.env.HOME).toBe(
        path.join(
          HOME_ROOT,
          createHash('sha256').update(first.sessionId).update('\0').update(DIRECTORY).digest('hex')
        )
      );
      expect(firstRuntime!.env.HOME).not.toBe(secondRuntime!.env.HOME);
      h.dispatcher({
        type: 'session.prepare',
        spec: { ...second, attemptId: 'retry' },
        credentials: credentialsFor(second.sessionId, proxyHandle(EXP_NOW)),
      });
      await waitFor(() => h.frames.filter(frame => frame.type === 'session.ready').length === 3);
      expect(h.spawner.spawnCount()).toBe(2);
      h.dispatcher({ type: 'session.release', sessionId: first.sessionId });
      await waitFor(() => h.runtimes.get(first.sessionId) === undefined);
      expect(h.runtimes.get(second.sessionId)).toBe(secondRuntime);
    } finally {
      await h.runtimes.shutdown();
    }
  });

  it('keys shared HOME by worktree scope and directory', async () => {
    const h = createHarness();
    try {
      const first = routeSpec('ses_a', 'ses_kilo_a', {
        directory: `${DIRECTORY}/one`,
      });
      const second = routeSpec('ses_b', 'ses_kilo_b', {
        directory: `${DIRECTORY}/two`,
        kilo: { scopeId: SCOPE_ID, token: proxyHandle(EXP_NOW), targets: TARGETS },
      });
      h.dispatcher({
        type: 'session.prepare',
        spec: first,
        credentials: credentialsFor('ses_a', proxyHandle(EXP_NOW)),
      });
      h.dispatcher({
        type: 'session.prepare',
        spec: second,
        credentials: credentialsFor('ses_b', proxyHandle(EXP_NOW)),
      });
      await waitFor(() => h.frames.filter(frame => frame.type === 'session.ready').length === 2);

      // The two routes are distinct runtimes (distinct directories), so read each
      // HOME from the runtime the preparation built.
      const homeFor = (key: string, directory: string): string =>
        path.join(
          HOME_ROOT,
          createHash('sha256').update(key).update('\0').update(directory).digest('hex')
        );
      const firstRuntime = h.runtimes.get(`${DIRECTORY}/one`);
      const secondRuntime = h.runtimes.get(`${DIRECTORY}/two`);
      expect(firstRuntime?.env.HOME).toBe(homeFor(SCOPE_ID, `${DIRECTORY}/one`));
      expect(secondRuntime?.env.HOME).toBe(homeFor(SCOPE_ID, `${DIRECTORY}/two`));
      // Same scope, different directory: HOME differs (directory is hashed in).
      expect(firstRuntime?.env.HOME).not.toBe(secondRuntime?.env.HOME);
    } finally {
      await h.runtimes.shutdown();
    }
  });

  it('restarts once at idle for a later handle and releases the runtime only on the last route', async () => {
    const h = createHarness();
    try {
      const specA = routeSpec('ses_a', 'ses_kilo_a');
      const specB = routeSpec('ses_b', 'ses_kilo_b');
      h.dispatcher({
        type: 'session.prepare',
        spec: specA,
        credentials: credentialsFor('ses_a', proxyHandle(EXP_NOW)),
      });
      h.dispatcher({
        type: 'session.prepare',
        spec: specB,
        credentials: credentialsFor('ses_b', proxyHandle(EXP_NOW)),
      });
      await waitFor(() => h.frames.filter(frame => frame.type === 'session.ready').length === 2);
      expect(h.spawner.spawnCount()).toBe(1);

      const retiredAborts: string[] = [];
      const retiredClient = h.runtimes.get(DIRECTORY)!.client;
      retiredClient.submit = async opts => {
        h.turns.observeKiloEvent({
          type: 'session.turn.open',
          properties: { sessionID: opts.sessionId },
          nativeRuntimeId: 'rt',
        });
      };
      // If release cleanup used this retired client, these would record it.
      retiredClient.release = async input => {
        retiredAborts.push(`abort:${input.sessionId}`);
        retiredAborts.push(`stop:${input.sessionId}`);
        return { ok: true, sessions: 1, failures: 0, elapsedMs: 0 };
      };

      h.dispatcher({ type: 'session.prompt', sessionId: 'ses_a', payload: promptPayload('m1') });
      await Bun.sleep(5);

      // A later handle arrives for BOTH siblings while the turn is busy: it must
      // be deferred once for the shared runtime, not once per route.
      const laterHandle = proxyHandle(EXP_NOW + 3_600);
      for (const sessionId of ['ses_a', 'ses_b']) {
        h.dispatcher({
          type: 'session.credentials',
          sessionId,
          kilo: { token: laterHandle },
          proxy: { handle: laterHandle, targets: TARGETS },
        });
      }
      await Bun.sleep(20);
      expect(h.spawner.spawnCount()).toBe(1);

      // At idle the deferred handle yields exactly one restart.
      h.turns.observeKiloEvent({
        type: 'session.turn.close',
        properties: { sessionID: 'ses_kilo_a', reason: 'completed' },
        nativeRuntimeId: 'rt',
      });
      await waitFor(() => h.spawner.spawnCount() === 2);
      await Bun.sleep(20);
      expect(h.spawner.spawnCount()).toBe(2);

      // The restart replaced the process AND its client on a new port. Stub
      // cleanup on the CURRENT client; the retired one must never be used.
      const currentClient = h.runtimes.get(DIRECTORY)!.client;
      expect(currentClient).not.toBe(retiredClient);
      const cleaned: string[] = [];
      currentClient.submit = async () => undefined;
      currentClient.release = async input => {
        cleaned.push(`abort:${input.sessionId}`);
        cleaned.push(`stop:${input.sessionId}`);
        return { ok: true, sessions: 1, failures: 0, elapsedMs: 0 };
      };

      // Releasing one route cleans up only that route's tree, never the sibling's.
      h.dispatcher({ type: 'session.release', sessionId: 'ses_a' });
      await waitFor(() => cleaned.includes('abort:ses_kilo_a'));
      expect(cleaned).toContain('abort:ses_kilo_a');
      expect(cleaned.some(entry => entry.endsWith('ses_kilo_b'))).toBe(false);
      expect(retiredAborts).toHaveLength(0);
      await Bun.sleep(10);
      expect(h.spawner.processes[1]!.stopped).toBe(0);
      expect(h.runtimes.get(DIRECTORY)).toBeDefined();

      // Releasing the last route releases the runtime.
      h.dispatcher({ type: 'session.release', sessionId: 'ses_b' });
      await waitFor(() => h.spawner.processes[1]!.stopped === 1);
      expect(h.runtimes.get(DIRECTORY)).toBeUndefined();
    } finally {
      await h.runtimes.shutdown();
    }
  });

  it('releases a sibling during a restart without throwing and still forgets its terminal', async () => {
    const h = createHarness();
    try {
      const specA = routeSpec('ses_a', 'ses_kilo_a');
      const specB = routeSpec('ses_b', 'ses_kilo_b');
      h.dispatcher({
        type: 'session.prepare',
        spec: specA,
        credentials: credentialsFor('ses_a', proxyHandle(EXP_NOW)),
      });
      h.dispatcher({
        type: 'session.prepare',
        spec: specB,
        credentials: credentialsFor('ses_b', proxyHandle(EXP_NOW)),
      });
      await waitFor(() => h.frames.filter(frame => frame.type === 'session.ready').length === 2);

      const runtime = h.runtimes.get(DIRECTORY)!;
      const aborts: string[] = [];
      const client = runtime.client;
      client.release = async input => {
        aborts.push(input.sessionId);
        return { ok: true, sessions: 1, failures: 0, elapsedMs: 0 };
      };
      // The shared runtime is mid-restart: liveRuntimeClient reports no client.
      Object.assign(runtime, { isRestarting: () => true });
      const forgotten: string[] = [];
      h.terminals.forgetSession = async sessionId => {
        forgotten.push(sessionId);
      };

      // Must not throw out of the dispatcher, skip no-op cleanup, and still run
      // the terminal forget that follows preparation.release.
      expect(() => h.dispatcher({ type: 'session.release', sessionId: 'ses_a' })).not.toThrow();
      await waitFor(() => forgotten.includes('ses_a'));
      expect(forgotten).toContain('ses_a');
      expect(aborts).toHaveLength(0);
    } finally {
      await h.runtimes.shutdown();
    }
  });
});

function promptPayload(messageId: string): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}
