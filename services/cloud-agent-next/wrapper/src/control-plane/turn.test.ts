import { describe, expect, it } from 'bun:test';
import type {
  ControlPlanePromptPayload,
  ControlPlaneRouteSpec,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import type { ControlDiagnosticFields } from '../../../src/shared/control-diagnostics.js';
import type { KiloFeedEvent } from '../control/worktree-feed.js';
import { runtimeKey } from './prepare.js';
import {
  createTurnManager,
  type TurnKiloRuntime,
  type TurnManagerDeps,
  type TurnScheduler,
} from './turn.js';

const DIRECTORY = '/workspace/session';
const KILO_SESSION = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_ID = 'workspace_test';
const runningState = {
  sessionId: KILO_SESSION,
  directory: DIRECTORY,
  nativeRuntimeId: 'rt',
  execution: 1,
  startedAt: 0,
  progressed: true,
  activity: 'running' as const,
};

const SESSION_TIMERS = {
  heartbeatIntervalMs: 1000,
  heartbeatAckTimeoutMs: 3000,
  heartbeatNegotiationMs: 100,
  cloneMs: 1000,
  restoreMs: 1000,
  captureMs: 1000,
  kiloRuntimeStartMs: 1000,
  kiloSessionMs: 1000,
  sseSilenceMs: 1000,
  healthRequestMs: 1000,
  sseReconnectLimit: 6,
  sseReconnectWindowMs: 1000,
  kiloRestartLimit: 3,
  kiloRestartWindowMs: 1000,
  noProgressMs: 20 * 60_000,
  turnHardCapMs: CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs,
  reconnectBackoffMinMs: 10,
  reconnectBackoffMaxMs: 100,
};

type PromptCall = {
  sessionId: string;
  messageId: string;
  prompt?: string;
  parts?: unknown[];
  model?: { providerID?: string; modelID: string };
  signal?: AbortSignal;
};
type SummaryCall = { sessionId: string; model: { modelID: string }; auto?: boolean };
type CommandCall = { sessionId: string; command: string; messageId?: string; args?: string };
type QuestionCall = { questionId: string; answers: string[][]; directory?: string };
type RejectCall = { questionId: string; directory?: string };
type PermissionCall = {
  permissionId: string;
  response: string;
  message?: string;
  directory?: string;
  interactive?: boolean;
};

type FakeClient = ReturnType<typeof createFakeClient>;

function createFakeClient(onDispatch: (id: string) => void = () => undefined) {
  const prompts: PromptCall[] = [];
  const summaries: SummaryCall[] = [];
  const commands: CommandCall[] = [];
  const aborts: string[] = [];
  const questionAnswers: QuestionCall[] = [];
  const questionRejections: RejectCall[] = [];
  const permissionAnswers: PermissionCall[] = [];
  let promptImpl: (opts: PromptCall) => Promise<void> = async () => undefined;
  let commandImpl: (opts: CommandCall) => Promise<unknown> = async () => ({});
  let summaryImpl: (opts: SummaryCall) => Promise<boolean> = async () => true;
  let probeImpl: WrapperKiloClient['probeMessagePart'];
  let permissionImpl: () => Promise<boolean> = async () => true;
  const client = {
    sendPromptAsync: async (opts: PromptCall) => {
      prompts.push(opts);
      onDispatch(opts.sessionId);
      await promptImpl(opts);
    },
    summarizeSession: async (opts: SummaryCall) => {
      summaries.push(opts);
      onDispatch(opts.sessionId);
      return summaryImpl(opts);
    },
    sendCommand: async (opts: CommandCall) => {
      commands.push(opts);
      onDispatch(opts.sessionId);
      return commandImpl(opts);
    },
    abortSession: async (opts: { sessionId: string }) => {
      aborts.push(opts.sessionId);
      return true;
    },
    answerQuestion: async (questionId: string, answers: string[][], directory?: string) => {
      questionAnswers.push({ questionId, answers, directory });
      return true;
    },
    rejectQuestion: async (questionId: string, directory?: string) => {
      questionRejections.push({ questionId, directory });
      return true;
    },
    answerPermission: async (
      permissionId: string,
      response: string,
      message?: string,
      interactive?: boolean,
      directory?: string
    ) => {
      permissionAnswers.push({
        permissionId,
        response,
        message,
        directory,
        ...(interactive !== undefined ? { interactive } : {}),
      });
      return permissionImpl();
    },
    listCommands: async () => ({
      commands: [{ name: 'compact', description: 'Compact the conversation' }],
      dropped: 0,
      overLimit: false,
    }),
    probeMessagePart: (...args: Parameters<NonNullable<WrapperKiloClient['probeMessagePart']>>) =>
      probeImpl?.(...args) ?? Promise.resolve(null),
  } as unknown as WrapperKiloClient;
  return {
    client,
    prompts,
    summaries,
    commands,
    aborts,
    questionAnswers,
    questionRejections,
    permissionAnswers,
    setPermissionImpl: (impl: () => Promise<boolean>) => {
      permissionImpl = impl;
    },
    setPromptImpl: (impl: (opts: PromptCall) => Promise<void>) => {
      promptImpl = impl;
    },
    setCommandImpl: (impl: (opts: CommandCall) => Promise<unknown>) => {
      commandImpl = impl;
    },
    setSummaryImpl: (impl: (opts: SummaryCall) => Promise<boolean>) => {
      summaryImpl = impl;
    },
    setProbeImpl: (impl: NonNullable<WrapperKiloClient['probeMessagePart']>) => {
      probeImpl = impl;
    },
  };
}

function routeSpec(overrides: Partial<ControlPlaneRouteSpec> = {}): ControlPlaneRouteSpec {
  return {
    sessionId: SESSION_ID,
    kiloSessionId: KILO_SESSION,
    directory: DIRECTORY,
    attemptId: 'attempt-1',
    ...overrides,
  };
}

type FinalizationExtra = {
  finalization?: { autoCommit?: boolean; condenseOnComplete?: boolean };
};

function promptPayload(
  messageId: string,
  extra: FinalizationExtra = {}
): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
    ...extra,
  };
}

function commandPayload(
  messageId: string,
  command: string,
  extra: FinalizationExtra = {}
): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'command', command, arguments: '' },
    agent: { mode: 'code', model: 'test/model' },
    ...extra,
  };
}

function kiloEvent(
  type: string,
  properties: Record<string, unknown>,
  runtimeKey?: string
): KiloFeedEvent {
  return {
    type,
    properties,
    nativeRuntimeId: 'rt',
    ...(runtimeKey === undefined ? {} : { runtimeKey }),
  };
}

function completedKiloTurn(): KiloFeedEvent {
  return kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason: 'completed' });
}

type Flags = { restarting?: boolean; suspected?: boolean; unavailable?: boolean };

function createHarness(
  options: {
    runCondense?: TurnManagerDeps['runCondense'];
    runAutoCommit?: TurnManagerDeps['runAutoCommit'];
    materializeAttachments?: (
      message: { prompt?: string; parts?: unknown[] },
      deps?: { signal?: AbortSignal }
    ) => Promise<{ prompt?: string; parts?: unknown[] }>;
  } = {}
) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const logs: string[] = [];
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const nativeDiagnostics: Array<{ event: string; fields: ControlDiagnosticFields }> = [];
  const clients = new Map<string, FakeClient>();
  const flags = new Map<string, Flags>();
  const runtimes = new Map<string, TurnKiloRuntime>();
  const envs = new Map<string, Record<string, string>>();
  const retiredClients = new WeakSet<WrapperKiloClient>();
  const timeouts: Array<{ handler: () => void; ms: number; cancelled: boolean }> = [];
  const states = new Map<string, ReturnType<TurnKiloRuntime['sessionState']>>();
  let clock = 0;
  let materializeCalls = 0;

  const scheduler: TurnScheduler = {
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    setTimeout: (handler, ms) => {
      const handle = { handler, ms, cancelled: false };
      timeouts.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: handle => {
      (handle as unknown as { cancelled: boolean }).cancelled = true;
    },
  };

  const manager = createTurnManager({
    timers: { wrapper: SESSION_TIMERS } as never,
    emit: frame => frames.push(frame),
    runtimes: { get: key => runtimes.get(key) },
    log: message => logs.push(message),
    onDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    onNativeDiagnostic: (event, fields) => nativeDiagnostics.push({ event, fields }),
    now: () => clock,
    scheduler,
    materializeAttachments: (async (
      message: { prompt?: string; parts?: unknown[] },
      deps?: { signal?: AbortSignal }
    ) => {
      materializeCalls += 1;
      return options.materializeAttachments
        ? options.materializeAttachments(message, deps)
        : { prompt: message.prompt, parts: message.parts };
    }) as never,
    runCondense:
      options.runCondense ?? (async () => ({ wasAborted: false, success: true }) as never),
    runAutoCommit: options.runAutoCommit ?? ((async () => ({ success: true })) as never),
  });

  function ensureRuntime(spec: ControlPlaneRouteSpec): void {
    const key = runtimeKey(spec);
    if (clients.has(key)) return;
    const fake = createFakeClient(id =>
      manager.observeKiloEvent(kiloEvent('session.turn.open', { sessionID: id }))
    );
    clients.set(key, fake);
    flags.set(key, {});
    envs.set(key, {});
    runtimes.set(key, {
      directory: spec.directory,
      env: envs.get(key) as Record<string, string>,
      get client() {
        return clients.get(key)!.client;
      },
      ensure: async () => clients.get(key)!.client,
      sessionState: id => states.get(id),
      refreshActivity: async () => undefined,
      isRetiredClient: client => retiredClients.has(client),
      isSuspected: () => flags.get(key)?.suspected ?? false,
      isRestarting: () => flags.get(key)?.restarting ?? false,
      isUnavailable: () => flags.get(key)?.unavailable ?? false,
    });
  }

  return {
    manager,
    setState(id: string, state: ReturnType<TurnKiloRuntime['sessionState']>) {
      states.set(id, state);
    },
    frames,
    logs,
    diagnostics,
    nativeDiagnostics,
    scheduler,
    timeouts,
    setClock: (value: number) => {
      clock = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    materializeCalls: () => materializeCalls,
    registerRoute(spec: ControlPlaneRouteSpec, withRuntime = true): void {
      if (withRuntime) ensureRuntime(spec);
      manager.registerRoute(spec);
    },
    client(spec: ControlPlaneRouteSpec): FakeClient {
      const fake = clients.get(runtimeKey(spec));
      if (fake === undefined) throw new Error('no client');
      return fake;
    },
    setFlags(spec: ControlPlaneRouteSpec, next: Flags): void {
      flags.set(runtimeKey(spec), { ...flags.get(runtimeKey(spec)), ...next });
    },
    retireClient(spec: ControlPlaneRouteSpec): void {
      const key = runtimeKey(spec);
      retiredClients.add(clients.get(key)!.client);
      clients.set(
        key,
        createFakeClient(id =>
          manager.observeKiloEvent(kiloEvent('session.turn.open', { sessionID: id }))
        )
      );
    },
    setEnv(spec: ControlPlaneRouteSpec, env: Record<string, string>): void {
      envs.set(runtimeKey(spec), env);
      const runtime = runtimes.get(runtimeKey(spec));
      if (runtime !== undefined) Object.assign(runtime, { env });
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function outcomeFrames(frames: ControlPlaneWrapperFrame[]) {
  return frames.flatMap(frame => (frame.type === 'session.outcome' ? [frame] : []));
}

function eventFrames(frames: ControlPlaneWrapperFrame[]) {
  return frames.flatMap(frame => (frame.type === 'session.events' ? frame.events : []));
}

describe('turn manager submission', () => {
  it('bounds attachment delivery and fences late materialization without calling it native inactivity', async () => {
    const materialized = Promise.withResolvers<{ prompt: string }>();
    const h = createHarness({ materializeAttachments: () => materialized.promise });
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(h.manager.hasPendingWork()).toBe(true);
    h.advance(120_000 - 1);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toEqual([]);
    h.advance(1);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toMatchObject([
      { status: 'failed', reason: 'prompt_failed', lastMessageId: 'm1' },
    ]);
    expect(h.manager.hasPendingWork()).toBe(false);
    materialized.resolve({ prompt: 'late attachment' });
    await settle();
    expect(h.client(routeSpec()).prompts).toEqual([]);
    expect(h.client(routeSpec()).aborts).toEqual([]);
    expect(outcomeFrames(h.frames)).toHaveLength(1);
  });
  it('submits a prompt with its messageId and completes on a completed turn-close', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const client = h.client(routeSpec());
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toMatchObject({ sessionId: KILO_SESSION, messageId: 'm1' });

    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-1', type: 'text' },
      })
    );
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
  });

  it('completes when the same messageId is delivered twice', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(client.prompts).toHaveLength(1);

    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
  });

  it('routes /compact without auto and fails when summarize returns false', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    client.setSummaryImpl(async () => false);
    h.manager.submit(SESSION_ID, commandPayload('c1', 'compact'));
    await settle();
    expect(client.summaries).toHaveLength(1);
    expect(client.summaries[0].auto).toBeUndefined();
    expect(client.prompts).toHaveLength(0);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({
      status: 'failed',
      reason: 'prompt_failed',
    });
  });

  it('routes other command turns to sendCommand', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, commandPayload('c2', 'init'));
    await settle();
    const client = h.client(routeSpec());
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toMatchObject({ sessionId: KILO_SESSION, command: 'init' });
  });

  it('drains the inbox when a heartbeat arrives after Kilo recovers', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.setFlags(routeSpec(), { restarting: true, suspected: true });
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(client.prompts).toHaveLength(0);

    h.setFlags(routeSpec(), { restarting: false, suspected: false });
    h.manager.observeKiloEvent(kiloEvent('server.heartbeat', {}));
    await settle();
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toMatchObject({ messageId: 'm1' });
  });

  it('fails agent_unavailable at once when the runtime is missing', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec(), false);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({
      status: 'failed',
      reason: 'agent_unavailable',
    });
  });

  it('publishes the command catalog after a prepare resolves', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    await h.manager.publishCommands(SESSION_ID);
    const available = eventFrames(h.frames).find(event => event.type === 'commands.available');
    expect(available).toBeDefined();
    expect(available?.properties.commands).toEqual([
      { name: 'compact', description: 'Compact the conversation' },
    ]);
  });
});

describe('turn resubmission', () => {
  it.each(['before-recovery', 'after-recovery'])(
    'preserves a retired-client native application failure %s',
    async order => {
      const h = createHarness();
      const spec = routeSpec();
      h.registerRoute(spec);
      const result = Promise.withResolvers<void>();
      h.client(spec).setPromptImpl(() => result.promise);
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      await settle();
      h.retireClient(spec);
      if (order === 'after-recovery') {
        h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
        await settle();
      }
      result.reject(
        new Error('Native application rejected input', {
          cause: { message: 'fetch failed', code: 'invalid_model' },
        })
      );
      await settle();
      expect(outcomeFrames(h.frames)).toEqual([
        {
          type: 'session.outcome',
          sessionId: SESSION_ID,
          status: 'failed',
          reason: 'prompt_failed',
          lastMessageId: 'm1',
        },
      ]);
      const calls = h.client(spec).prompts.length;
      h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
      await settle();
      expect(h.client(spec).prompts).toHaveLength(calls);
    }
  );

  it.each(['abort', 'release'])(
    'fences a retired submission result after %s and a newer turn',
    async action => {
      const h = createHarness();
      const spec = routeSpec();
      h.registerRoute(spec);
      const result = Promise.withResolvers<void>();
      h.client(spec).setPromptImpl(() => result.promise);
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      await settle();
      h.retireClient(spec);
      h.manager[action](SESSION_ID);
      if (action === 'release') h.registerRoute(spec);
      h.manager.submit(SESSION_ID, promptPayload('m2'));
      await settle();
      result.reject(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
      await settle();
      expect(h.client(spec).prompts.map(call => call.messageId)).toEqual(['m2']);
      expect(outcomeFrames(h.frames).filter(frame => frame.status === 'failed')).toEqual([]);
      h.manager.observeKiloEvent(completedKiloTurn());
      await settle();
      expect(outcomeFrames(h.frames).at(-1)).toMatchObject({
        status: 'completed',
        lastMessageId: 'm2',
      });
    }
  );

  it('fails a retired held submission with real progress as agent_restarted, not prompt_failed', async () => {
    const h = createHarness();
    const spec = routeSpec();
    h.registerRoute(spec);
    const result = Promise.withResolvers<void>();
    h.client(spec).setPromptImpl(() => result.promise);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.setState(KILO_SESSION, runningState);
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant', type: 'tool' },
      })
    );
    h.retireClient(spec);
    result.reject(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([]);
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(h.client(spec).prompts).toEqual([]);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({
      status: 'failed',
      reason: 'agent_restarted',
    });
  });

  it('fails attachment errors without dispatch or restart recovery', async () => {
    const h = createHarness({
      materializeAttachments: async () => {
        throw new Error('Attachment unavailable');
      },
    });
    const spec = routeSpec();
    h.registerRoute(spec);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(h.client(spec).prompts).toEqual([]);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'prompt_failed' });
  });

  it.each(['before-recovery', 'after-recovery'])(
    'recovers a held retired-client transport rejection %s without prompt_failed',
    async order => {
      const h = createHarness();
      const spec = routeSpec();
      h.registerRoute(spec);
      const rejected = Promise.withResolvers<void>();
      h.client(spec).setPromptImpl(() => rejected.promise);
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      await settle();
      h.manager.submit(SESSION_ID, promptPayload('m2'));
      h.setFlags(spec, { restarting: true });
      h.retireClient(spec);
      if (order === 'before-recovery') {
        rejected.reject(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
        await settle();
        expect(outcomeFrames(h.frames)).toEqual([]);
      }
      h.setFlags(spec, { restarting: false });
      h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
      await settle();
      expect(h.client(spec).prompts.map(call => call.messageId)).toEqual(['m1', 'm2']);
      if (order === 'after-recovery') {
        rejected.reject(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
        await settle();
      }
      expect(outcomeFrames(h.frames)).toEqual([]);
      h.manager.observeKiloEvent(completedKiloTurn());
      await settle();
      expect(outcomeFrames(h.frames)).toEqual([
        {
          type: 'session.outcome',
          sessionId: SESSION_ID,
          status: 'completed',
          lastMessageId: 'm2',
        },
      ]);
    }
  );

  it('resubmits a prompt whose in-flight dispatch the restart cancelled, without prompt_failed', async () => {
    const h = createHarness();
    const spec = routeSpec();
    h.registerRoute(spec);
    h.client(spec).setPromptImpl(
      opts =>
        new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () => reject(new Error('Async prompt failed', { cause: opts.signal?.reason })),
            { once: true }
          );
        })
    );
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.retireClient(spec);
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(h.client(spec).prompts.map(call => call.messageId)).toEqual(['m1']);
    expect(outcomeFrames(h.frames)).toEqual([]);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([
      {
        type: 'session.outcome',
        sessionId: SESSION_ID,
        status: 'completed',
        lastMessageId: 'm1',
      },
    ]);
  });

  it.each(['hang', 'credentials'] as const)(
    'does not spend recovery on the first dispatch of a prompt received during %s restart',
    async reason => {
      const h = createHarness();
      const spec = routeSpec();
      h.registerRoute(spec);
      h.setFlags(spec, { restarting: true });
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      h.setFlags(spec, { restarting: false });
      h.manager.onRuntimeRestart({ directory: DIRECTORY, reason, key: DIRECTORY });
      await settle();
      expect(h.client(spec).prompts.map(call => call.messageId)).toEqual(['m1']);
      h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
      await settle();
      expect(h.client(spec).prompts.map(call => call.messageId)).toEqual(['m1', 'm1']);
      expect(outcomeFrames(h.frames)).toEqual([]);
      h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
      await settle();
      expect(outcomeFrames(h.frames)).toEqual([
        {
          type: 'session.outcome',
          sessionId: SESSION_ID,
          status: 'failed',
          reason: 'agent_restarted',
          lastMessageId: 'm1',
        },
      ]);
    }
  );

  it('keeps credential restart eligibility independent for MCP-isolated runtime keys', async () => {
    const h = createHarness();
    const specA = routeSpec({
      sessionId: 'workspace_a',
      kiloSessionId: 'ses_a',
      runtimeIsolation: 'per-session',
    });
    const specB = routeSpec({
      sessionId: 'workspace_b',
      kiloSessionId: 'ses_b',
      runtimeIsolation: 'per-session',
    });
    h.registerRoute(specA);
    h.registerRoute(specB);
    h.manager.submit(specA.sessionId, promptPayload('m1'));
    await settle();
    expect(h.manager.canRestartRuntime(runtimeKey(specA))).toBe(false);
    expect(h.manager.canRestartRuntime(runtimeKey(specB))).toBe(true);
  });

  it('ignores the user prompt echo and resubmits the same messageIds once', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    expect(client.prompts).toHaveLength(2);

    // Kilo stores each user part with the prompt's messageID; not progress.
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'm1', type: 'text' },
      })
    );
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(client.prompts.map(call => call.messageId)).toEqual(['m1', 'm2', 'm1', 'm2']);
    expect(eventFrames(h.frames).some(event => event.type === 'commands.available')).toBe(true);

    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(1);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({
      status: 'failed',
      reason: 'agent_restarted',
      lastMessageId: 'm2',
    });
  });

  it('resubmits without re-materializing attachments', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(h.materializeCalls()).toBe(1);
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(h.materializeCalls()).toBe(1);
  });

  it('preserves an unfinished attachment materialization across a runtime restart', async () => {
    let releaseMaterialize: (() => void) | undefined;
    let materializeSignal: AbortSignal | undefined;
    const h = createHarness({
      materializeAttachments: (_message, deps) => {
        materializeSignal = deps?.signal;
        return new Promise((resolve, reject) => {
          releaseMaterialize = () => resolve({ prompt: 'hello', parts: [] });
          deps?.signal?.addEventListener(
            'abort',
            () => reject(deps.signal?.reason ?? new Error('aborted')),
            { once: true }
          );
        });
      },
    });
    const spec = routeSpec();
    h.registerRoute(spec);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(h.materializeCalls()).toBe(1);
    expect(h.client(spec).prompts).toEqual([]);

    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(materializeSignal?.aborted).toBe(false);
    expect(h.materializeCalls()).toBe(1);

    releaseMaterialize?.();
    await settle();
    expect(h.client(spec).prompts.map(call => call.messageId)).toEqual(['m1']);
    expect(outcomeFrames(h.frames)).toEqual([]);

    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({
      status: 'completed',
      lastMessageId: 'm1',
    });
  });

  it('still cancels an unfinished attachment materialization on Stop', async () => {
    let materializeSignal: AbortSignal | undefined;
    const h = createHarness({
      materializeAttachments: (_message, deps) => {
        materializeSignal = deps?.signal;
        return new Promise((_resolve, reject) => {
          deps?.signal?.addEventListener(
            'abort',
            () => reject(deps.signal?.reason ?? new Error('aborted')),
            { once: true }
          );
        });
      },
    });
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.abort(SESSION_ID);
    await settle();
    expect(materializeSignal?.aborted).toBe(true);
    expect(outcomeFrames(h.frames)).toEqual([
      { type: 'session.outcome', sessionId: SESSION_ID, status: 'cancelled', lastMessageId: 'm1' },
    ]);
  });

  it('completes after a no-progress restart when the resubmitted turn closes completed', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(client.prompts).toHaveLength(1);

    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(client.prompts).toHaveLength(2);

    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
  });

  it('does not retain a native queue snapshot across a restart', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.queue.changed', { sessionID: KILO_SESSION, queued: ['m2'] })
    );
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(h.client(routeSpec()).prompts.map(call => call.messageId)).toEqual([
      'm1',
      'm2',
      'm1',
      'm2',
    ]);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'completed', lastMessageId: 'm2' });
  });

  it('does not let a child turn-close complete the root', async () => {
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.manager.observeKiloEvent(
      kiloEvent('session.turn.close', { sessionID: childId, reason: 'completed' })
    );
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
  });

  it('retains child routing across turns, but drops it on deletion or root release', async () => {
    const h = createHarness();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    h.frames.length = 0;
    const childEvent = kiloEvent('message.updated', {
      info: { id: 'child-message', sessionID: childId, role: 'assistant' },
    });
    h.manager.observeKiloEvent(childEvent);
    expect(h.frames.some(frame => frame.type === 'session.events')).toBe(true);
    h.manager.observeKiloEvent(kiloEvent('session.deleted', { info: { id: childId } }));
    h.frames.length = 0;
    h.manager.observeKiloEvent(childEvent);
    expect(h.frames).toEqual([]);
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.manager.release(SESSION_ID);
    h.registerRoute(routeSpec());
    h.frames.length = 0;
    h.manager.observeKiloEvent(childEvent);
    expect(h.frames).toEqual([]);
  });

  it('attributes a descendant to the runtime route that emitted it, not its reported parent', async () => {
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const routeB = routeSpec({
      sessionId: 'workspace_b',
      kiloSessionId: 'ses_cccccccccccccccccccccccccc',
      runtimeIsolation: 'per-session',
    });
    const h = createHarness();
    h.registerRoute(routeSpec({ runtimeIsolation: 'per-session' }));
    h.registerRoute(routeB);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    h.manager.submit(routeB.sessionId, promptPayload('m2'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent(
        'session.created',
        { info: { id: childId, parentID: KILO_SESSION } },
        routeB.sessionId
      )
    );
    h.frames.length = 0;
    h.manager.observeKiloEvent(
      kiloEvent(
        'message.updated',
        { info: { id: 'child-message', sessionID: childId, role: 'assistant' } },
        routeB.sessionId
      )
    );
    const frames = h.frames.filter(frame => frame.type === 'session.events');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ sessionId: routeB.sessionId });
  });

  it('preserves the reported parent when sibling turns share a runtime', async () => {
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const routeB = routeSpec({
      sessionId: 'workspace_b',
      kiloSessionId: 'ses_cccccccccccccccccccccccccc',
    });
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.registerRoute(routeB);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    h.manager.submit(routeB.sessionId, promptPayload('m2'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent(
        'session.created',
        { info: { id: childId, parentID: routeB.kiloSessionId } },
        DIRECTORY
      )
    );
    h.frames.length = 0;
    h.manager.observeKiloEvent(
      kiloEvent(
        'message.updated',
        { info: { id: 'child-message', sessionID: childId, role: 'assistant' } },
        DIRECTORY
      )
    );
    const frames = h.frames.filter(frame => frame.type === 'session.events');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ sessionId: routeB.sessionId });
  });

  it('attributes an unknown descendant to the only active turn in a shared runtime', async () => {
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.registerRoute(routeSpec({ sessionId: 'workspace_b', kiloSessionId: 'ses_other' }));
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: 'ses_unknown' } }, DIRECTORY)
    );
    h.frames.length = 0;
    h.manager.observeKiloEvent(
      kiloEvent(
        'message.updated',
        { info: { id: 'child-message', sessionID: childId, role: 'assistant' } },
        DIRECTORY
      )
    );
    const frames = h.frames.filter(frame => frame.type === 'session.events');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ sessionId: SESSION_ID });
  });

  it('fails agent_restarted after real tool progress', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.setState(KILO_SESSION, runningState);
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-1', type: 'tool', tool: 'bash' },
      })
    );
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(client.prompts).toHaveLength(1);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'agent_restarted' });
  });

  it('reports the runtime-supplied memory reason instead of agent_restarted', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.setState(KILO_SESSION, runningState);
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-1', type: 'tool', tool: 'bash' },
      })
    );
    h.manager.onRuntimeRestart({
      directory: DIRECTORY,
      reason: 'hang',
      key: DIRECTORY,
      outcomeReason: 'sandbox_out_of_memory',
    });
    await settle();
    expect(client.prompts).toHaveLength(1);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'sandbox_out_of_memory' });
  });

  it('resubmits only the restarted per-session runtime, not its sibling', async () => {
    const h = createHarness();
    const specA = routeSpec({
      sessionId: 'session-a',
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      runtimeIsolation: 'per-session',
    });
    const specB = routeSpec({
      sessionId: 'session-b',
      kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      runtimeIsolation: 'per-session',
    });
    h.registerRoute(specA);
    h.registerRoute(specB);
    h.manager.submit('session-a', promptPayload('m1'));
    h.manager.submit('session-b', promptPayload('m2'));
    await settle();
    expect(h.client(specA).prompts).toHaveLength(1);
    expect(h.client(specB).prompts).toHaveLength(1);

    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: 'session-a' });
    await settle();
    expect(h.client(specA).prompts).toHaveLength(2);
    expect(h.client(specB).prompts).toHaveLength(1);
    expect(outcomeFrames(h.frames)).toHaveLength(0);
  });

  it('fails busy turns agent_unavailable for the spent runtime key only', async () => {
    const h = createHarness();
    const specA = routeSpec({
      sessionId: 'session-a',
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      runtimeIsolation: 'per-session',
    });
    const specB = routeSpec({
      sessionId: 'session-b',
      kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      runtimeIsolation: 'per-session',
    });
    h.registerRoute(specA);
    h.registerRoute(specB);
    h.manager.submit('session-a', promptPayload('m1'));
    h.manager.submit('session-b', promptPayload('m2'));
    await settle();
    h.manager.onRuntimeUnavailable(DIRECTORY, 'session-a');
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ reason: 'agent_unavailable', sessionId: 'session-a' });
    expect(h.frames.filter(frame => frame.type === 'session.failed')).toEqual([
      { type: 'session.failed', sessionId: 'session-a', reason: 'agent_unavailable' },
    ]);
  });

  it('fails a ready route with no turn so the next message prepares again', () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.onRuntimeUnavailable(DIRECTORY, DIRECTORY);
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.frames.filter(frame => frame.type === 'session.failed')).toEqual([
      { type: 'session.failed', sessionId: SESSION_ID, reason: 'agent_unavailable' },
    ]);
  });
});

describe('turn outcome rules', () => {
  it('does not settle on idle or a superseded close without an explicit completion', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    h.manager.observeKiloEvent(
      kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason: 'superseded' })
    );
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.activeTurnCount() > 0).toBe(true);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
  });

  it('keeps a dispatched native follow-up active across the superseded turn idle', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    expect(h.client(routeSpec()).prompts.map(call => call.messageId)).toEqual(['m1', 'm2']);

    h.manager.observeKiloEvent(
      kiloEvent('session.queue.changed', { sessionID: KILO_SESSION, queued: ['m2'] })
    );
    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.activeTurnCount() > 0).toBe(true);

    h.manager.observeKiloEvent(
      kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason: 'superseded' })
    );
    h.manager.observeKiloEvent(
      kiloEvent('session.queue.changed', { sessionID: KILO_SESSION, queued: [] })
    );
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-2', type: 'tool' },
      })
    );
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.activeTurnCount() > 0).toBe(true);

    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    h.manager.observeKiloEvent(
      kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason: 'completed' })
    );
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([
      { type: 'session.outcome', sessionId: SESSION_ID, status: 'completed', lastMessageId: 'm2' },
    ]);
  });

  it('can still abort native queued work after an intermediate idle', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.queue.changed', { sessionID: KILO_SESSION, queued: ['m2'] })
    );
    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    await settle();
    h.manager.abort(SESSION_ID);
    await settle();
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(h.frames)).toEqual([
      { type: 'session.outcome', sessionId: SESSION_ID, status: 'cancelled', lastMessageId: 'm2' },
    ]);
  });

  it('forwards abort to the Kilo route and only cancels an active turn', async () => {
    const active = createHarness();
    active.registerRoute(routeSpec());
    active.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    active.manager.abort(SESSION_ID);
    await settle();
    expect(active.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(active.frames)[0]).toMatchObject({
      status: 'cancelled',
      lastMessageId: 'm1',
    });

    const idle = createHarness();
    idle.registerRoute(routeSpec());
    idle.manager.abort(SESSION_ID);
    await settle();
    expect(idle.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(idle.frames)).toHaveLength(0);

    const completed = createHarness();
    completed.registerRoute(routeSpec());
    completed.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    completed.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    completed.manager.abort(SESSION_ID);
    await settle();
    expect(completed.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(completed.frames)).toEqual([
      { type: 'session.outcome', sessionId: SESSION_ID, status: 'completed', lastMessageId: 'm1' },
    ]);
  });

  it.each([
    ['interrupted', 'cancelled'],
    ['error', 'failed'],
  ])('settles a native %s close as %s, never completed', async (reason, status) => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason })
    );
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status, lastMessageId: 'm1' });
  });

  it('fails with the classified reason on a final Kilo error', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.error', {
        sessionID: KILO_SESSION,
        error: { name: 'ProviderAuthError', message: 'bad key' },
      })
    );
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({
      status: 'failed',
      assistantReason: 'provider_authentication',
    });
  });

  it('does not complete while a prompt has not been dispatched or materialized', async () => {
    let releaseMaterialize: (() => void) | undefined;
    const materializing = createHarness({
      materializeAttachments: () =>
        new Promise(resolve => {
          releaseMaterialize = () => resolve({ prompt: 'hello', parts: [] });
        }),
    });
    materializing.registerRoute(routeSpec());
    const materializeClient = materializing.client(routeSpec());
    materializing.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(materializeClient.prompts).toHaveLength(0);
    materializing.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    await settle();
    expect(outcomeFrames(materializing.frames)).toHaveLength(0);
    expect(materializing.manager.activeTurnCount() > 0).toBe(true);

    releaseMaterialize?.();
    await settle();
    expect(materializeClient.prompts).toHaveLength(1);
    materializing.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(materializing.frames)[0]).toMatchObject({
      status: 'completed',
      lastMessageId: 'm1',
    });

    const queued = createHarness();
    queued.registerRoute(routeSpec());
    const queuedClient = queued.client(routeSpec());
    let releaseM1: (() => void) | undefined;
    queuedClient.setPromptImpl(opts =>
      opts.messageId === 'm1' ? new Promise<void>(r => (releaseM1 = r)) : Promise.resolve()
    );
    queued.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    queued.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    queued.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    await settle();
    expect(outcomeFrames(queued.frames)).toHaveLength(0);
    expect(queued.manager.activeTurnCount() > 0).toBe(true);

    releaseM1?.();
    await settle();
    queued.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const outcomes = outcomeFrames(queued.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm2' });
  });

  it('does not send a queued prompt after the turn was aborted', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    let releaseM1: (() => void) | undefined;
    client.setPromptImpl(opts =>
      opts.messageId === 'm1' ? new Promise<void>(r => (releaseM1 = r)) : Promise.resolve()
    );
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    h.manager.abort(SESSION_ID);
    releaseM1?.();
    await settle();
    expect(client.prompts.map(call => call.messageId)).toEqual(['m1']);
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'cancelled', lastMessageId: 'm2' });
  });

  it('reports a failed dispatch with its own messageId', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    client.setPromptImpl(opts =>
      opts.messageId === 'm2' ? Promise.reject(new Error('boom')) : Promise.resolve()
    );
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: 'failed',
      reason: 'prompt_failed',
      lastMessageId: 'm2',
    });
  });
});

describe('turn deferred completion', () => {
  it('completes a deferred native close once reconciliation clears the execution', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();

    h.setState(KILO_SESSION, runningState);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([]);
    expect(h.manager.activeTurnCount()).toBe(1);

    h.setState(KILO_SESSION, undefined);
    h.manager.refreshActivity(DIRECTORY);
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([
      { type: 'session.outcome', sessionId: SESSION_ID, status: 'completed', lastMessageId: 'm1' },
    ]);
  });

  it('does not settle a newer submission with a deferred close for an earlier one', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.setState(KILO_SESSION, runningState);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();

    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    h.setState(KILO_SESSION, undefined);
    h.manager.refreshActivity(DIRECTORY);
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([]);

    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([
      { type: 'session.outcome', sessionId: SESSION_ID, status: 'completed', lastMessageId: 'm2' },
    ]);
  });

  it('discards a deferred close for an execution replaced by newer native work', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.setState(KILO_SESSION, runningState);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();

    h.setState(KILO_SESSION, { ...runningState, execution: 2, nativeRuntimeId: 'rt2' });
    h.manager.refreshActivity(DIRECTORY);
    await settle();
    h.setState(KILO_SESSION, undefined);
    h.manager.refreshActivity(DIRECTORY);
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([]);
  });

  it('does not complete from a deferred close after Stop', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.setState(KILO_SESSION, runningState);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();

    h.manager.abort(SESSION_ID);
    await settle();
    h.setState(KILO_SESSION, undefined);
    h.manager.refreshActivity(DIRECTORY);
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([
      { type: 'session.outcome', sessionId: SESSION_ID, status: 'cancelled', lastMessageId: 'm1' },
    ]);
  });
});

describe('turn finalization', () => {
  it.each(['interrupted', 'error', 'session.error'])(
    'keeps completed user work completed when condense emits %s',
    async reason => {
      let release:
        | ((result: { wasAborted: boolean; success: boolean; error?: string }) => void)
        | undefined;
      const h = createHarness({
        runCondense: () => new Promise(resolve => (release = resolve)),
      });
      h.registerRoute(routeSpec());
      h.manager.submit(
        SESSION_ID,
        promptPayload('m1', { finalization: { condenseOnComplete: true } })
      );
      await settle();
      h.manager.observeKiloEvent(completedKiloTurn());
      await settle();
      h.manager.observeKiloEvent(
        reason === 'session.error'
          ? kiloEvent('session.error', {
              sessionID: KILO_SESSION,
              error: { message: 'condense failed' },
            })
          : kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason })
      );
      await settle();
      expect(outcomeFrames(h.frames)).toHaveLength(0);
      release?.({ wasAborted: false, success: false, error: 'condense failed' });
      await settle();
      expect(outcomeFrames(h.frames)).toEqual([
        {
          type: 'session.outcome',
          sessionId: SESSION_ID,
          status: 'completed',
          lastMessageId: 'm1',
        },
      ]);
      expect(
        eventFrames(h.frames).some(
          frame => frame.type === 'error' && frame.properties.fatal === false
        )
      ).toBe(true);
    }
  );

  it('does not hide a newer prompt failure during auto-commit', async () => {
    let release: ((result: { success: boolean }) => void) | undefined;
    const h = createHarness({
      runAutoCommit: () => new Promise(resolve => (release = resolve)),
    });
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1', { finalization: { autoCommit: true } }));
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason: 'error' })
    );
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'failed', lastMessageId: 'm2' });
    release?.({ success: true });
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(1);
  });

  it('does not finalize on idle or queue snapshots before a completed close', async () => {
    let release: ((value: { wasAborted: boolean; success: boolean }) => void) | undefined;
    const h = createHarness({
      runCondense: () => new Promise(resolve => (release = resolve)),
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    const idle = kiloEvent('session.idle', { sessionID: KILO_SESSION });
    h.manager.observeKiloEvent(idle);
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.queue.changed', { sessionID: KILO_SESSION, queued: ['native-follow-up'] })
    );
    release?.({ wasAborted: false, success: true });
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.activeTurnCount() > 0).toBe(true);

    h.manager.observeKiloEvent(
      kiloEvent('session.queue.changed', { sessionID: KILO_SESSION, queued: [] })
    );
    h.manager.observeKiloEvent(idle);
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    release?.({ wasAborted: false, success: true });
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
  });

  it('sends the finalizing event first and does not abort on condense failure', async () => {
    const h = createHarness({
      runCondense: (async () => ({
        wasAborted: false,
        success: false,
        error: 'condense boom',
      })) as never,
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();

    const finalizingIndex = h.frames.findIndex(
      frame =>
        frame.type === 'session.events' &&
        frame.events.some(event => event.type === 'wrapper_finalizing')
    );
    const outcomeIndex = h.frames.findIndex(frame => frame.type === 'session.outcome');
    expect(finalizingIndex).toBeGreaterThanOrEqual(0);
    expect(outcomeIndex).toBeGreaterThan(finalizingIndex);
    expect(h.frames[outcomeIndex]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
    expect(h.client(routeSpec()).aborts).toHaveLength(0);
    expect(
      eventFrames(h.frames).some(
        event => event.type === 'error' && event.properties.fatal === false
      )
    ).toBe(true);
  });

  it('finalizes again when a completed close arrives during finalization', async () => {
    let firstCondense: ((value: { wasAborted: boolean; success: boolean }) => void) | undefined;
    let condenseCalls = 0;
    const h = createHarness({
      runCondense: (() => {
        condenseCalls += 1;
        if (condenseCalls === 1) {
          return new Promise(resolve => {
            firstCondense = resolve;
          });
        }
        return Promise.resolve({ wasAborted: false, success: true });
      }) as never,
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    firstCondense?.({ wasAborted: false, success: true });
    await settle();

    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm2' });

    h.advance(SESSION_TIMERS.noProgressMs + 1);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(1);
  });

  it('waits for the next completed close when a prompt is submitted during finalization', async () => {
    let release: ((value: { wasAborted: boolean; success: boolean }) => void) | undefined;
    let condenseCalls = 0;
    const h = createHarness({
      runCondense: (() => {
        condenseCalls += 1;
        if (condenseCalls === 1) return new Promise(resolve => (release = resolve));
        return Promise.resolve({ wasAborted: false, success: true });
      }) as never,
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    // m2 is submitted during finalization and no idle for it arrives during the
    // pass: the pass must not settle it before it runs.
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    release?.({ wasAborted: false, success: true });
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm2' });
  });

  it('does not let a completed close seen before a newer prompt settle it', async () => {
    let release: ((value: { wasAborted: boolean; success: boolean }) => void) | undefined;
    let condenseCalls = 0;
    const h = createHarness({
      runCondense: (() => {
        condenseCalls += 1;
        if (condenseCalls === 1) return new Promise(resolve => (release = resolve));
        return Promise.resolve({ wasAborted: false, success: true });
      }) as never,
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    release?.({ wasAborted: false, success: true });
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm2' });
  });

  it('fails agent_restarted when a restart follows an undispatched prompt during finalization', async () => {
    let release: ((value: { wasAborted: boolean; success: boolean }) => void) | undefined;
    const h = createHarness({
      runCondense: (() => new Promise(resolve => (release = resolve))) as never,
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    // While Kilo restarts, m2 waits in the inbox; it is received after the
    // finalization pass started and was never handed to Kilo.
    h.setFlags(routeSpec(), { restarting: true, suspected: true });
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'failed', reason: 'agent_restarted' });
    release?.({ wasAborted: false, success: true });
  });

  it('lets a finalizing turn finish across a restart', async () => {
    let release: ((value: { wasAborted: boolean; success: boolean }) => void) | undefined;
    const h = createHarness({
      runCondense: (() => new Promise(resolve => (release = resolve))) as never,
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    release?.({ wasAborted: false, success: true });
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'completed' });
  });

  it('fails agent_restarted when a restart interrupts a finalization follow-up', async () => {
    let release: ((value: { wasAborted: boolean; success: boolean }) => void) | undefined;
    const h = createHarness({
      runCondense: (() => new Promise(resolve => (release = resolve))) as never,
    });
    h.registerRoute(routeSpec());
    h.manager.submit(
      SESSION_ID,
      promptPayload('m1', { finalization: { condenseOnComplete: true } })
    );
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'failed', reason: 'agent_restarted' });
    release?.({ wasAborted: false, success: true });
  });

  it('anchors auto-commit events to the latest root assistant message', async () => {
    const h = createHarness({
      runAutoCommit: async opts => {
        opts.onEvent({
          streamEventType: 'autocommit_started',
          timestamp: '2026-09-30T09:00:00.000Z',
          data: { messageId: opts.messageId, message: 'Committing changes...' },
        });
        opts.onEvent({
          streamEventType: 'autocommit_completed',
          timestamp: '2026-09-30T09:00:01.000Z',
          data: {
            messageId: opts.messageId,
            userMessageId: opts.userMessageId,
            success: true,
            commitHash: 'abc123',
            commitMessage: 'Fix bug',
          },
        });
        return { success: true };
      },
    });
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1', { finalization: { autoCommit: true } }));
    await settle();
    h.manager.submit(SESSION_ID, promptPayload('m2'));
    await settle();
    for (const info of [
      { id: 'a1', sessionID: KILO_SESSION, role: 'assistant' },
      { id: 'a2', sessionID: KILO_SESSION, role: 'assistant' },
      { id: 'm2', sessionID: KILO_SESSION, role: 'user' },
    ]) {
      h.manager.observeKiloEvent(kiloEvent('message.updated', { info }));
    }
    h.manager.observeKiloEvent(
      kiloEvent('session.created', {
        info: { id: 'child', parentID: KILO_SESSION },
      })
    );
    h.manager.observeKiloEvent(
      kiloEvent('message.updated', {
        info: { id: 'child-assistant', sessionID: 'child', role: 'assistant' },
      })
    );
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const events = h.frames.flatMap(frame => (frame.type === 'session.events' ? frame.events : []));
    expect(events.find(event => event.type === 'autocommit_started')?.properties).toMatchObject({
      messageId: 'a2',
    });
    expect(events.find(event => event.type === 'autocommit_completed')?.properties).toMatchObject({
      messageId: 'a2',
      userMessageId: 'm2',
      success: true,
      commitHash: 'abc123',
      commitMessage: 'Fix bug',
    });
  });

  it('falls back to the user message ID, passes runtime env and named secret keys, and aborts auto-commit on abort', async () => {
    const autoCommitCalls: Array<{
      env?: unknown;
      secretEnvKeys?: unknown;
      signal?: AbortSignal;
      messageId?: string;
    }> = [];
    const h = createHarness({
      runAutoCommit: (async (opts: { env?: unknown; signal?: AbortSignal }) => {
        autoCommitCalls.push(opts);
        return new Promise(() => undefined);
      }) as never,
    });
    const spec = routeSpec({ secretEnvKeys: ['DATABASE_URL'] });
    h.registerRoute(spec);
    h.setEnv(spec, { FOO: 'bar', DATABASE_URL: 'db-secret' });
    h.manager.submit(SESSION_ID, promptPayload('m1', { finalization: { autoCommit: true } }));
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(autoCommitCalls).toHaveLength(1);
    expect(autoCommitCalls[0].messageId).toBe('m1');
    expect(autoCommitCalls[0].env).toEqual({ FOO: 'bar', DATABASE_URL: 'db-secret' });
    expect(autoCommitCalls[0].secretEnvKeys).toEqual(['DATABASE_URL']);
    h.manager.abort(SESSION_ID);
    expect(autoCommitCalls[0].signal?.aborted).toBe(true);
  });
});

describe('automatic permissions', () => {
  it('retries a transient permission reply failure without prompting the user', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    let attempts = 0;
    h.client(routeSpec()).setPermissionImpl(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary reply failure');
      return true;
    });
    h.manager.observeKiloEvent(
      kiloEvent('permission.asked', { sessionID: KILO_SESSION, id: 'p1' })
    );
    await settle();
    expect(attempts).toBe(2);
    expect(eventFrames(h.frames).filter(event => event.type === 'permission.asked')).toEqual([]);
  });

  it.each([KILO_SESSION, 'ses_child'])(
    'auto-approves owned permissions from %s without pausing or forwarding a prompt',
    async kiloSessionId => {
      const h = createHarness();
      h.registerRoute(routeSpec());
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      await settle();
      h.manager.observeKiloEvent(
        kiloEvent('session.created', { info: { id: 'ses_child', parentID: KILO_SESSION } })
      );
      const event = kiloEvent('permission.asked', {
        sessionID: kiloSessionId,
        id: 'p1',
        permission: 'read',
        patterns: ['apps/web/.env.test'],
      });
      h.manager.observeKiloEvent(event);
      h.manager.observeKiloEvent(event);
      await settle();

      expect(h.client(routeSpec()).permissionAnswers).toEqual([
        { permissionId: 'p1', response: 'always', message: undefined, directory: DIRECTORY },
      ]);

      expect(eventFrames(h.frames).filter(event => event.type === 'permission.asked')).toEqual([]);
      h.manager.observeKiloEvent(
        kiloEvent('permission.replied', { sessionID: kiloSessionId, requestID: 'p1' })
      );
      h.manager.observeKiloEvent(completedKiloTurn());
      await settle();
      expect(outcomeFrames(h.frames)).toMatchObject([{ status: 'completed' }]);
    }
  );

  it('does not answer unrelated permissions or user questions, or resume a question on an automatic permission reply', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('permission.asked', { sessionID: 'ses_unrelated', id: 'p_other' })
    );
    h.manager.observeKiloEvent(kiloEvent('question.asked', { sessionID: KILO_SESSION, id: 'q1' }));
    h.manager.observeKiloEvent(
      kiloEvent('permission.asked', { sessionID: KILO_SESSION, id: 'p1' })
    );
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('permission.replied', { sessionID: KILO_SESSION, requestID: 'p1' })
    );

    expect(h.client(routeSpec()).permissionAnswers.map(answer => answer.permissionId)).toEqual([
      'p1',
    ]);
    expect(h.client(routeSpec()).questionAnswers).toEqual([]);
    expect(h.client(routeSpec()).questionRejections).toEqual([]);
    expect(eventFrames(h.frames).filter(event => event.type === 'question.asked')).toHaveLength(1);

    await h.manager.answer(SESSION_ID, { action: 'answer', questionId: 'q1', answers: [['yes']] });
  });

  it.each(['skillShell', 'sandboxEscalation'])(
    'keeps CLI-enforced %s human approvals interactive',
    async flag => {
      const h = createHarness();
      h.registerRoute(routeSpec());
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      await settle();
      h.manager.observeKiloEvent(
        kiloEvent('permission.asked', {
          sessionID: KILO_SESSION,
          id: 'p1',
          metadata: { [flag]: true },
        })
      );
      await settle();
      expect(h.client(routeSpec()).permissionAnswers).toEqual([]);
      expect(eventFrames(h.frames).filter(event => event.type === 'permission.asked')).toHaveLength(
        1
      );
    }
  );

  it('surfaces a failed auto-approval instead of hiding the pending permission', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.client(routeSpec()).setPermissionImpl(async () => {
      throw new Error('reply unavailable');
    });
    h.manager.observeKiloEvent(
      kiloEvent('permission.asked', { sessionID: KILO_SESSION, id: 'p1' })
    );
    await settle();
    expect(eventFrames(h.frames).filter(event => event.type === 'permission.asked')).toHaveLength(
      1
    );

    expect(h.client(routeSpec()).permissionAnswers).toHaveLength(2);
    h.client(routeSpec()).setPermissionImpl(async () => true);
    await h.manager.answer(SESSION_ID, {
      action: 'permission',
      permissionId: 'p1',
      response: 'reject',
    });

    expect(h.logs.some(log => log.includes('automatic permission reply failed'))).toBe(true);
  });

  it('does not publish a stale permission after release while its reply was in flight', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    let rejectReply: ((error: Error) => void) | undefined;
    h.client(routeSpec()).setPermissionImpl(
      () =>
        new Promise((_resolve, reject) => {
          rejectReply = reject;
        })
    );
    h.manager.observeKiloEvent(
      kiloEvent('permission.asked', { sessionID: KILO_SESSION, id: 'p1' })
    );
    h.manager.release(SESSION_ID);
    rejectReply?.(new Error('reply unavailable'));
    await settle();
    expect(eventFrames(h.frames).filter(event => event.type === 'permission.asked')).toEqual([]);
  });

  it.each([KILO_SESSION, 'ses_child'])(
    'rejects code-review permissions from %s without approving or forwarding them',
    async kiloSessionId => {
      const h = createHarness();
      const spec = routeSpec({ createdOnPlatform: 'code-review' });
      h.registerRoute(spec);
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      await settle();
      h.manager.observeKiloEvent(
        kiloEvent('session.created', { info: { id: 'ses_child', parentID: KILO_SESSION } })
      );
      h.manager.observeKiloEvent(
        kiloEvent('permission.asked', {
          sessionID: kiloSessionId,
          id: 'p1',
          permission: 'edit',
          metadata: { skillShell: true },
        })
      );
      await settle();
      expect(h.client(spec).permissionAnswers).toMatchObject([
        {
          permissionId: 'p1',
          response: 'reject',
          directory: DIRECTORY,
          message: expect.stringContaining('code-review non-interactive mode'),
        },
      ]);
      expect(eventFrames(h.frames).filter(event => event.type === 'permission.asked')).toEqual([]);
    }
  );

  it('fails closed if a code-review permission cannot be rejected', async () => {
    const h = createHarness();
    const spec = routeSpec({ createdOnPlatform: 'code-review' });
    h.registerRoute(spec);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.client(spec).setPermissionImpl(async () => {
      throw new Error('reply unavailable');
    });
    h.manager.observeKiloEvent(
      kiloEvent('permission.asked', { sessionID: KILO_SESSION, id: 'p1' })
    );
    await settle();
    expect(h.client(spec).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(h.frames)).toMatchObject([
      { status: 'failed', reason: 'Code-review permission rejection failed' },
    ]);
    expect(eventFrames(h.frames).filter(event => event.type === 'permission.asked')).toEqual([]);
  });
});

describe('turn answers', () => {
  it('delivers a question answer to the Kilo client for the route directory', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    await h.manager.answer(SESSION_ID, {
      action: 'answer',
      questionId: 'q1',
      answers: [['yes']],
    });
    expect(h.client(routeSpec()).questionAnswers).toEqual([
      { questionId: 'q1', answers: [['yes']], directory: DIRECTORY },
    ]);
  });

  it('delivers a question rejection and a permission reply', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    await h.manager.answer(SESSION_ID, { action: 'reject', questionId: 'q2' });
    await h.manager.answer(SESSION_ID, {
      action: 'permission',
      permissionId: 'p1',
      response: 'always',
      message: 'ok',
    });
    expect(h.client(routeSpec()).questionRejections).toEqual([
      { questionId: 'q2', directory: DIRECTORY },
    ]);
    expect(h.client(routeSpec()).permissionAnswers).toEqual([
      { permissionId: 'p1', response: 'always', message: 'ok', directory: DIRECTORY },
    ]);
  });

  it('ignores an answer for an unknown route', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    await h.manager.answer('workspace_other', {
      action: 'answer',
      questionId: 'q1',
      answers: [['yes']],
    });
    expect(h.client(routeSpec()).questionAnswers).toEqual([]);
  });
});

describe('turn route identity', () => {
  it('derives the runtime key from the isolation mode', () => {
    expect(runtimeKey(routeSpec())).toBe(DIRECTORY);
    expect(runtimeKey({ ...routeSpec(), runtimeIsolation: 'per-session' })).toBe(SESSION_ID);
  });
});

describe('native session outcome transitions', () => {
  it('projects a completed outcome once, matching the socket frame', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-1', type: 'text' },
      })
    );
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();

    expect(h.nativeDiagnostics.filter(entry => entry.fields.phase === 'session_outcome')).toEqual([
      {
        event: 'wrapper.lifecycle',
        fields: { phase: 'session_outcome', status: 'completed', sessionId: SESSION_ID },
      },
    ]);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'completed' });
  });

  it('projects a cancelled outcome once and leaves the socket frame unchanged', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.abort(SESSION_ID);
    await settle();

    expect(h.nativeDiagnostics.filter(entry => entry.fields.phase === 'session_outcome')).toEqual([
      {
        event: 'wrapper.lifecycle',
        fields: { phase: 'session_outcome', status: 'cancelled', sessionId: SESSION_ID },
      },
    ]);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'cancelled' });
  });

  it('projects a no_progress failure with the parsed outcomeReason', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.onNativeDeadline(
      { sessionId: KILO_SESSION, directory: DIRECTORY, nativeRuntimeId: 'rt', execution: 1 },
      'no_progress',
      runtimeKey(routeSpec())
    );
    await settle();

    const native = h.nativeDiagnostics.find(entry => entry.fields.phase === 'session_outcome');
    expect(native?.fields.status).toBe('failed');
    expect(native?.fields.outcomeReason).toBe('no_progress');
  });

  it('never copies a Kilo assistant safeMessage into outcomeReason', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.error', {
        sessionID: KILO_SESSION,
        error: { name: 'ProviderAuthError', message: 'bad key' },
      })
    );
    await settle();

    const native = h.nativeDiagnostics.find(entry => entry.fields.phase === 'session_outcome');
    expect(native?.fields.status).toBe('failed');
    expect(native?.fields).not.toHaveProperty('outcomeReason');
    expect(JSON.stringify(native?.fields)).not.toContain('bad key');
  });

  it('activeTurnCount excludes a turn waiting on the user', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    expect(h.manager.activeTurnCount()).toBe(0);
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    expect(h.manager.activeTurnCount()).toBe(1);
    expect(h.manager.activeTurnCount() > 0).toBe(true);

    h.setState(KILO_SESSION, {
      sessionId: KILO_SESSION,
      directory: DIRECTORY,
      nativeRuntimeId: 'rt',
      execution: 1,
      startedAt: 0,
      progressed: false,
      activity: 'waiting',
    });
    h.manager.observeKiloEvent(kiloEvent('question.asked', { sessionID: KILO_SESSION, id: 'q1' }));
    expect(h.manager.activeTurnCount()).toBe(0);
    expect(h.manager.activeTurnCount() > 0).toBe(false);

    h.manager.observeKiloEvent(
      kiloEvent('question.replied', { sessionID: KILO_SESSION, requestID: 'q1' })
    );
    h.setState(KILO_SESSION, undefined);
    expect(h.manager.activeTurnCount()).toBe(1);
  });
});
