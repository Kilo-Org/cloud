import { describe, expect, it } from 'bun:test';
import type {
  ControlPlanePromptPayload,
  ControlPlaneRouteSpec,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import type { KiloFeedEvent } from '../control/worktree-feed.js';
import { runtimeKey } from './prepare.js';
import {
  createTurnManager,
  noProgressElapsedMs,
  turnDeadlineAction,
  turnPausedMs,
  type TurnKiloRuntime,
  type TurnManagerDeps,
  type TurnScheduler,
} from './turn.js';

const DIRECTORY = '/workspace/session';
const KILO_SESSION = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_ID = 'workspace_test';

const SESSION_TIMERS = {
  heartbeatIntervalMs: 1000,
  heartbeatAckTimeoutMs: 3000,
  heartbeatNegotiationMs: 100,
  cloneMs: 1000,
  kiloRuntimeStartMs: 1000,
  kiloSessionMs: 1000,
  sseSilenceMs: 1000,
  healthRequestMs: 1000,
  sseReconnectLimit: 6,
  sseReconnectWindowMs: 1000,
  kiloRestartLimit: 3,
  kiloRestartWindowMs: 1000,
  noProgressMs: 7 * 60_000,
  turnHardCapMs: 60 * 60_000,
  reconnectBackoffMinMs: 10,
  reconnectBackoffMaxMs: 100,
};

type PromptCall = {
  sessionId: string;
  messageId: string;
  prompt?: string;
  parts?: unknown[];
  model?: { providerID?: string; modelID: string };
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
};

type FakeClient = ReturnType<typeof createFakeClient>;

function createFakeClient() {
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
  const client = {
    sendPromptAsync: async (opts: PromptCall) => {
      prompts.push(opts);
      await promptImpl(opts);
    },
    summarizeSession: async (opts: SummaryCall) => {
      summaries.push(opts);
      return summaryImpl(opts);
    },
    sendCommand: async (opts: CommandCall) => {
      commands.push(opts);
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
      _interactive?: boolean,
      directory?: string
    ) => {
      permissionAnswers.push({ permissionId, response, message, directory });
      return true;
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

function kiloEvent(type: string, properties: Record<string, unknown>): KiloFeedEvent {
  return { type, properties, nativeRuntimeId: 'rt' };
}

function completedKiloTurn(): KiloFeedEvent {
  return kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason: 'completed' });
}

type Flags = { restarting?: boolean; suspected?: boolean; unavailable?: boolean };

function createHarness(
  options: {
    runCondense?: TurnManagerDeps['runCondense'];
    runAutoCommit?: TurnManagerDeps['runAutoCommit'];
    materializeAttachments?: (message: {
      prompt?: string;
      parts?: unknown[];
    }) => Promise<{ prompt?: string; parts?: unknown[] }>;
  } = {}
) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const logs: string[] = [];
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const clients = new Map<string, FakeClient>();
  const flags = new Map<string, Flags>();
  const runtimes = new Map<string, TurnKiloRuntime>();
  const envs = new Map<string, Record<string, string>>();
  const retiredClients = new WeakSet<WrapperKiloClient>();
  const timeouts: Array<{ handler: () => void; ms: number; cancelled: boolean }> = [];
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
    now: () => clock,
    scheduler,
    materializeAttachments: (async (message: { prompt?: string; parts?: unknown[] }) => {
      materializeCalls += 1;
      return options.materializeAttachments
        ? options.materializeAttachments(message)
        : { prompt: message.prompt, parts: message.parts };
    }) as never,
    runCondense:
      options.runCondense ?? (async () => ({ wasAborted: false, success: true }) as never),
    runAutoCommit: options.runAutoCommit ?? ((async () => ({ success: true })) as never),
  });

  function ensureRuntime(spec: ControlPlaneRouteSpec): void {
    const key = runtimeKey(spec);
    if (clients.has(key)) return;
    const fake = createFakeClient();
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
      isRetiredClient: client => retiredClients.has(client),
      isSuspected: () => flags.get(key)?.suspected ?? false,
      isRestarting: () => flags.get(key)?.restarting ?? false,
      isUnavailable: () => flags.get(key)?.unavailable ?? false,
    });
  }

  return {
    manager,
    frames,
    logs,
    diagnostics,
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
      clients.set(key, createFakeClient());
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

  it('fails agent_restarted after real tool progress', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
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
  it('starts the 7-minute real-progress clock at the first submission', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.setClock(1);
    h.advance(SESSION_TIMERS.noProgressMs - 2);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.advance(2);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'failed', reason: 'no_progress' });
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
  });

  it('records deadline and native tool metadata without recording tool content', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    let nativeStatus = 'running';
    h.client(routeSpec()).setProbeImpl(async () => ({ status: nativeStatus }));
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: {
          id: 'part_1',
          sessionID: KILO_SESSION,
          messageID: 'assistant_1',
          type: 'tool',
          tool: 'bash',
          state: { status: 'running', input: { command: 'sensitive command' } },
        },
      })
    );
    h.advance(SESSION_TIMERS.noProgressMs - 60_000);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    nativeStatus = 'completed';
    h.advance(60_000);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'no_progress' });
    expect(h.diagnostics).toEqual([
      {
        event: 'session.execution',
        fields: expect.objectContaining({
          phase: 'freshness',
          probeStage: 'pre_deadline',
          probeStatus: 'found',
          toolStatus: 'running',
        }),
      },
      {
        event: 'session.execution',
        fields: expect.objectContaining({
          phase: 'deadline_expired',
          reason: 'no_progress',
          kiloSessionId: KILO_SESSION,
          eventType: 'message.part.updated',
          messageId: 'assistant_1',
          partId: 'part_1',
          toolStatus: 'running',
          elapsedMs: SESSION_TIMERS.noProgressMs,
        }),
      },
      {
        event: 'session.execution',
        fields: expect.objectContaining({
          phase: 'freshness',
          probeStage: 'deadline',
          probeStatus: 'found',
          toolStatus: 'completed',
          partId: 'part_1',
        }),
      },
    ]);
    expect(JSON.stringify(h.diagnostics)).not.toContain('sensitive command');
  });

  it('still aborts at seven minutes when the diagnostic probe throws', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.client(routeSpec()).setProbeImpl(() => {
      throw new Error('probe failed');
    });
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: {
          id: 'part_1',
          sessionID: KILO_SESSION,
          messageID: 'assistant_1',
          type: 'tool',
          state: { status: 'running' },
        },
      })
    );
    h.advance(SESSION_TIMERS.noProgressMs);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'no_progress' });
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(h.diagnostics.at(-1)?.fields).toMatchObject({ probeStatus: 'unavailable' });
  });

  it('pauses the no-progress clock while waiting on the user', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(kiloEvent('question.asked', { sessionID: KILO_SESSION, id: 'q1' }));
    h.advance(SESSION_TIMERS.noProgressMs * 2);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    h.manager.observeKiloEvent(
      kiloEvent('question.replied', { sessionID: KILO_SESSION, requestID: 'q1' })
    );
    h.advance(SESSION_TIMERS.noProgressMs - 1);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.advance(1);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'no_progress' });
  });

  it('keeps the turn inactive and the clock paused while the pending question reports progress', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(kiloEvent('question.asked', { sessionID: KILO_SESSION, id: 'q1' }));
    // The question's own tool part is a tool event; it must not end the wait.
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-1', type: 'tool' },
      })
    );
    expect(h.manager.isActive()).toBe(false);
    h.advance(SESSION_TIMERS.noProgressMs * 2);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
  });

  it('does not spend a long question wait as no-progress credit after the answer', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(kiloEvent('question.asked', { sessionID: KILO_SESSION, id: 'q1' }));
    h.advance(30 * 60_000);
    h.manager.observeKiloEvent(
      kiloEvent('question.replied', { sessionID: KILO_SESSION, requestID: 'q1' })
    );
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-1', type: 'text' },
      })
    );
    h.advance(SESSION_TIMERS.noProgressMs);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'failed', reason: 'no_progress' });
  });

  it('pauses the clock for a subagent question in the root tree', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.manager.observeKiloEvent(kiloEvent('question.asked', { sessionID: childId, id: 'q1' }));
    h.advance(SESSION_TIMERS.noProgressMs * 2);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.manager.observeKiloEvent(
      kiloEvent('question.replied', { sessionID: childId, requestID: 'q1' })
    );
    h.advance(SESSION_TIMERS.noProgressMs + 1);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'no_progress' });
  });

  it('refreshes the root deadline on descendant progress and expires after descendant silence', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    // Two descendant progress events just before the original deadline.
    h.advance(SESSION_TIMERS.noProgressMs - 2);
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: childId, messageID: 'child-assistant-1', type: 'text' },
      })
    );
    h.advance(1);
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: childId, messageID: 'child-assistant-1', type: 'tool' },
      })
    );
    // No per-event logging: only the expiry line is written.
    expect(h.logs).toHaveLength(0);

    // At the original deadline the descendant progress has refreshed the clock,
    // so the turn is still running.
    h.advance(1);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    // One no-progress window after the last descendant progress it expires.
    h.advance(SESSION_TIMERS.noProgressMs - 2);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.advance(1);
    h.manager.tick();
    await settle();

    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'failed', reason: 'no_progress' });
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(h.logs).toEqual([
      `turn: no_progress aborting session ${KILO_SESSION} descendantProgressEvents=2`,
    ]);
  });

  it.each(['completed', 'error', 'interrupted', 'superseded'] as const)(
    'does not let a descendant turn-close (%s) settle or refresh the root',
    async reason => {
      const h = createHarness();
      h.registerRoute(routeSpec());
      h.manager.submit(SESSION_ID, promptPayload('m1'));
      await settle();
      const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
      h.manager.observeKiloEvent(
        kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
      );
      // The descendant terminal close lands just before the original deadline.
      h.advance(SESSION_TIMERS.noProgressMs - 1);
      h.manager.observeKiloEvent(kiloEvent('session.turn.close', { sessionID: childId, reason }));
      await settle();
      expect(outcomeFrames(h.frames)).toHaveLength(0);
      // It did not refresh the clock: the root still expires at its own deadline.
      h.advance(1);
      h.manager.tick();
      await settle();
      expect(outcomeFrames(h.frames)[0]).toMatchObject({
        status: 'failed',
        reason: 'no_progress',
      });
    }
  );

  it('does not let a descendant session.error settle or refresh the root', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.advance(SESSION_TIMERS.noProgressMs - 1);
    h.manager.observeKiloEvent(
      kiloEvent('session.error', { sessionID: childId, error: { message: 'child boom' } })
    );
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.advance(1);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'failed', reason: 'no_progress' });
  });

  it('does not let another root session refresh the target root', async () => {
    const h = createHarness();
    const specA = routeSpec();
    const specB = routeSpec({
      sessionId: 'workspace_other',
      kiloSessionId: 'ses_cccccccccccccccccccccccccc',
    });
    h.registerRoute(specA);
    h.registerRoute(specB);
    h.manager.submit(specA.sessionId, promptPayload('m1'));
    h.manager.submit(specB.sessionId, promptPayload('m2'));
    await settle();
    // The other root makes progress near A's deadline; A must not be refreshed.
    h.advance(SESSION_TIMERS.noProgressMs - 1);
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: specB.kiloSessionId, messageID: 'b-assistant-1', type: 'tool' },
      })
    );
    h.advance(1);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)).toEqual([
      {
        type: 'session.outcome',
        sessionId: specA.sessionId,
        status: 'failed',
        reason: 'no_progress',
        lastMessageId: 'm1',
      },
    ]);
  });

  it('does not refresh the root on excluded non-progress descendant events', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.advance(SESSION_TIMERS.noProgressMs - 1);
    // A text delta and a text part carrying the retained root prompt's messageId
    // are the user's own prompt, not progress.
    h.manager.observeKiloEvent(
      kiloEvent('message.part.delta', { sessionID: childId, messageID: 'm1', delta: 'hi' })
    );
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: childId, messageID: 'm1', type: 'text' },
      })
    );
    // Idle, queue, assistant message metadata and heartbeat are not progress.
    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: childId }));
    h.manager.observeKiloEvent(
      kiloEvent('session.queue.changed', { sessionID: childId, queued: ['x'] })
    );
    h.manager.observeKiloEvent(
      kiloEvent('message.updated', {
        info: { id: 'child-assistant-1', sessionID: childId, role: 'assistant' },
      })
    );
    h.manager.observeKiloEvent(kiloEvent('server.heartbeat', {}));
    h.advance(1);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'failed', reason: 'no_progress' });
    expect(h.logs).toEqual([
      `turn: no_progress aborting session ${KILO_SESSION} descendantProgressEvents=0`,
    ]);
  });

  it('keeps a user wait paused while a descendant progresses, then resumes the clock', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.manager.observeKiloEvent(kiloEvent('question.asked', { sessionID: KILO_SESSION, id: 'q1' }));
    // A descendant progresses while the root waits on the user; the wait must
    // stay paused and the turn inactive.
    h.advance(60_000);
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: childId, messageID: 'child-assistant-1', type: 'tool' },
      })
    );
    expect(h.manager.isActive()).toBe(false);
    h.advance(SESSION_TIMERS.noProgressMs * 2);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);

    // The answer resumes the wait; the clock restarts from the answer/progress.
    h.manager.observeKiloEvent(
      kiloEvent('question.replied', { sessionID: KILO_SESSION, requestID: 'q1' })
    );
    h.advance(SESSION_TIMERS.noProgressMs - 1);
    h.manager.tick();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    h.advance(1);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'no_progress' });
  });

  it('fails agent_restarted after descendant real tool progress', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: childId, messageID: 'child-assistant-1', type: 'tool', tool: 'bash' },
      })
    );
    h.manager.onRuntimeRestart({ directory: DIRECTORY, reason: 'hang', key: DIRECTORY });
    await settle();
    expect(client.prompts).toHaveLength(1);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'agent_restarted' });
  });

  it('reports zero descendant progress for a genuinely silent turn', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.advance(SESSION_TIMERS.noProgressMs);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'no_progress' });
    expect(h.logs).toEqual([
      `turn: no_progress aborting session ${KILO_SESSION} descendantProgressEvents=0`,
    ]);
  });

  it('does not count a descendant user-prompt text part as progress', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    // A text part carrying the pending root prompt's messageId is the user's own
    // prompt, not progress, and must not be counted.
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: childId, messageID: 'm1', type: 'text' },
      })
    );
    h.advance(SESSION_TIMERS.noProgressMs);
    h.manager.tick();
    await settle();
    expect(h.logs).toEqual([
      `turn: no_progress aborting session ${KILO_SESSION} descendantProgressEvents=0`,
    ]);
  });

  it('caps the turn at 60 minutes even after progress', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('message.part.updated', {
        part: { sessionID: KILO_SESSION, messageID: 'assistant-1', type: 'text' },
      })
    );
    h.advance(SESSION_TIMERS.turnHardCapMs);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ reason: 'execution_limit' });
  });

  it('caps the turn at 60 minutes even with continuous descendant progress', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    const childId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    h.manager.observeKiloEvent(
      kiloEvent('session.created', { info: { id: childId, parentID: KILO_SESSION } })
    );
    // Continuous descendant progress resets the no-progress clock, but it must
    // not buy the turn past the 60-minute hard cap.
    const stepMs = SESSION_TIMERS.noProgressMs - 60_000;
    let elapsed = 0;
    while (elapsed + stepMs < SESSION_TIMERS.turnHardCapMs) {
      h.advance(stepMs);
      elapsed += stepMs;
      h.manager.observeKiloEvent(
        kiloEvent('message.part.updated', {
          part: { sessionID: childId, messageID: 'child-assistant-1', type: 'tool' },
        })
      );
      h.manager.tick();
      expect(outcomeFrames(h.frames)).toHaveLength(0);
    }
    h.advance(SESSION_TIMERS.turnHardCapMs - elapsed);
    h.manager.tick();
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'failed', reason: 'execution_limit' });
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
  });

  it('ignores idle until Kilo explicitly completes its turn', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.isActive()).toBe(true);
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
    expect(h.manager.isActive()).toBe(true);

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
    expect(h.manager.isActive()).toBe(true);

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

  it('does not treat a superseded close as completion even after the queue drains', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(
      kiloEvent('session.turn.close', { sessionID: KILO_SESSION, reason: 'superseded' })
    );
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.isActive()).toBe(true);
  });

  it('aborts the Kilo session on an explicit abort and reports cancelled', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.abort(SESSION_ID);
    await settle();
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'cancelled', lastMessageId: 'm1' });
  });

  it('forwards abort to an existing Kilo route without an active turn', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.abort(SESSION_ID);
    await settle();
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(h.frames)).toHaveLength(0);
  });

  it('forwards abort after completion without changing the terminal outcome', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    h.manager.abort(SESSION_ID);
    await settle();
    expect(h.client(routeSpec()).aborts).toEqual([KILO_SESSION]);
    expect(outcomeFrames(h.frames)).toEqual([
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

  it('does not complete while a received prompt has not been dispatched', async () => {
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
    await settle();
    // m1's Kilo call is still in flight, so m2 is received but not dispatched.
    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.isActive()).toBe(true);

    releaseM1?.();
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    const outcomes = outcomeFrames(h.frames);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'completed', lastMessageId: 'm2' });
  });

  it('does not count a prompt as dispatched until its attachments materialize', async () => {
    let releaseMaterialize: (() => void) | undefined;
    const h = createHarness({
      materializeAttachments: () =>
        new Promise(resolve => {
          releaseMaterialize = () => resolve({ prompt: 'hello', parts: [] });
        }),
    });
    h.registerRoute(routeSpec());
    const client = h.client(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    // m1 has not reached Kilo yet, so an idle cannot complete the turn.
    expect(client.prompts).toHaveLength(0);
    h.manager.observeKiloEvent(kiloEvent('session.idle', { sessionID: KILO_SESSION }));
    await settle();
    expect(outcomeFrames(h.frames)).toHaveLength(0);
    expect(h.manager.isActive()).toBe(true);

    releaseMaterialize?.();
    await settle();
    expect(client.prompts).toHaveLength(1);
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(outcomeFrames(h.frames)[0]).toMatchObject({ status: 'completed', lastMessageId: 'm1' });
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
    expect(h.manager.isActive()).toBe(true);

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

  it('falls back to the user message ID, passes runtime env and aborts auto-commit on abort', async () => {
    const autoCommitCalls: Array<{ env?: unknown; signal?: AbortSignal; messageId?: string }> = [];
    const h = createHarness({
      runAutoCommit: (async (opts: { env?: unknown; signal?: AbortSignal }) => {
        autoCommitCalls.push(opts);
        return new Promise(() => undefined);
      }) as never,
    });
    const spec = routeSpec();
    h.registerRoute(spec);
    h.setEnv(spec, { FOO: 'bar' });
    h.manager.submit(SESSION_ID, promptPayload('m1', { finalization: { autoCommit: true } }));
    await settle();
    h.manager.observeKiloEvent(completedKiloTurn());
    await settle();
    expect(autoCommitCalls).toHaveLength(1);
    expect(autoCommitCalls[0].messageId).toBe('m1');
    expect(autoCommitCalls[0].env).toEqual({ FOO: 'bar' });
    h.manager.abort(SESSION_ID);
    expect(autoCommitCalls[0].signal?.aborted).toBe(true);
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

  it('resumes the no-progress clock once the answer is delivered', async () => {
    const h = createHarness();
    h.registerRoute(routeSpec());
    h.manager.submit(SESSION_ID, promptPayload('m1'));
    await settle();
    h.manager.observeKiloEvent(kiloEvent('question.asked', { id: 'q1', sessionID: KILO_SESSION }));
    await h.manager.answer(SESSION_ID, {
      action: 'answer',
      questionId: 'q1',
      answers: [['yes']],
    });
    h.advance(SESSION_TIMERS.noProgressMs);
    h.manager.tick();
    await settle();
    expect(outcomeFrames(h.frames).at(-1)).toMatchObject({
      status: 'failed',
      reason: 'no_progress',
    });
  });
});

describe('turn clock helpers', () => {
  it('computes paused and no-progress time independently of the cap', () => {
    const base = {
      startedAt: 0,
      lastProgressAt: 100,
      pausedMs: 50,
      waitingSince: null as number | null,
    };
    expect(turnPausedMs(base, 1000)).toBe(50);
    expect(noProgressElapsedMs(base, 1000)).toBe(850);
    expect(turnPausedMs({ ...base, waitingSince: 900 }, 1000)).toBe(150);
    expect(turnDeadlineAction(base, 1000, SESSION_TIMERS)).toBeNull();
    expect(turnDeadlineAction(base, SESSION_TIMERS.turnHardCapMs, SESSION_TIMERS)).toBe(
      'execution_limit'
    );
  });

  it('derives the runtime key from the isolation mode', () => {
    expect(runtimeKey(routeSpec())).toBe(DIRECTORY);
    expect(runtimeKey({ ...routeSpec(), runtimeIsolation: 'per-session' })).toBe(SESSION_ID);
  });
});
