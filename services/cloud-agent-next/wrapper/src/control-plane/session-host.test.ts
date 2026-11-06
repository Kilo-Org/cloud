import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { createControlPlaneFrameDispatcher, createControlPlaneSessionHost } from './main.js';
import type { KiloFeedCallbacks } from './kilo-runtime.js';
import type { KiloEventFeedSource } from './kilo-event-feed.js';
import type { SessionObservation } from './session-supervisor.js';
import { createControlPlaneTerminals } from './terminals.js';
import { git } from '../utils.js';
import type { TurnManagerDeps } from './turn.js';

async function settle() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
  await Bun.sleep(5);
}

async function hostFixture(turn: Pick<TurnManagerDeps, 'runAutoCommit'> = {}) {
  let now = Date.now();
  let preparing = false;
  let abortReply: () => Promise<boolean> = async () => true;
  let summaryReply: () => Promise<boolean> = async () => true;
  const frames: ControlPlaneWrapperFrame[] = [];
  const aborts: Array<{ path: string; scope: unknown }> = [];
  const prompts: string[] = [];
  const summaries: string[] = [];
  const summaryRequested = Promise.withResolvers<void>();
  const promptRequested = Promise.withResolvers<void>();
  const autoCommitReported = Promise.withResolvers<void>();
  const abortRequested = Promise.withResolvers<void>();
  const feeds: Array<{ source: KiloEventFeedSource; callbacks: KiloFeedCallbacks }> = [];
  const intervals = new Map<symbol, () => void>();
  const stopped: number[] = [];
  let terminalSocket: Bun.ServerWebSocket<string> | undefined;
  const server = Bun.serve<string>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, instance) {
      const url = new URL(request.url);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (instance.upgrade(request, { data: url.pathname })) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      if (url.pathname === '/pty') {
        return Response.json({
          id: 'pty_terminal',
          title: 'Terminal',
          command: '/bin/sh',
          args: [],
          cwd: '/workspace',
          status: 'running',
          pid: 73,
        });
      }
      if (url.pathname.startsWith('/pty/') && request.method === 'DELETE') {
        return Response.json(true);
      }
      if (url.pathname.endsWith('/abort')) {
        aborts.push({ path: url.pathname, scope: url.searchParams.get('scope') });
        abortRequested.resolve();
        return Response.json(await abortReply());
      }
      if (url.pathname.endsWith('/prompt_async')) {
        prompts.push(url.pathname);
        promptRequested.resolve();
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/summarize')) {
        summaries.push(url.pathname);
        summaryRequested.resolve();
        return Response.json(await summaryReply());
      }
      if (url.pathname === '/command') return Response.json([]);
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) {
        if (socket.data.startsWith('/sandbox-terminal/')) terminalSocket = socket;
      },
      message() {},
    },
  });
  let pid = 10_000;
  let snapshot: SessionObservation[] = [];
  const host = createControlPlaneSessionHost({
    runtime: {
      timers: CONTROL_PLANE_TIMERS,
      log: () => undefined,
      prepareFilesystem: async () => undefined,
      readProcessStartTime: () => undefined,
      readSnapshot: async () => snapshot,
      scheduler: {
        now: () => now,
        setInterval(handler) {
          const id = Symbol();
          intervals.set(id, handler);
          return id;
        },
        clearInterval(handle) {
          intervals.delete(handle as symbol);
        },
      },
      spawnKilo: async () => {
        const id = pid++;
        return {
          pid: id,
          url: server.url.toString(),
          authorization: 'Basic test',
          exited: new Promise<void>(() => undefined),
          stop: async () => {
            stopped.push(id);
            return true;
          },
        };
      },
      openFeed(source, callbacks) {
        feeds.push({ source, callbacks });
        return {
          async open() {
            callbacks.onEvent({
              type: 'server.connected',
              properties: {},
              nativeRuntimeId: source.nativeRuntimeId,
            });
          },
          close() {},
        };
      },
    },
    turn: {
      ...turn,
      emit: frame => {
        frames.push(frame);
        if (
          frame.type === 'session.events' &&
          frame.events.some(event => event.type === 'autocommit_completed')
        )
          autoCommitReported.resolve();
      },
      now: () => now,
      log: () => undefined,
    },
    isPreparing: () => preparing,
    isWorkspaceBusy: () => terminals.hasActivePty(),
  });
  const terminals = createControlPlaneTerminals({
    controlUrl: server.url.toString(),
    wrapperId: 'wrapper_test',
    runtimes: host.runtimes,
  });
  const fixture = {
    host,
    terminals,
    terminalSocket: () => terminalSocket,
    now: () => now,
    frames,
    feeds,
    aborts,
    prompts,
    summaries,
    summaryRequested: summaryRequested.promise,
    promptRequested: promptRequested.promise,
    autoCommitReported: autoCommitReported.promise,
    abortRequested: abortRequested.promise,
    stopped,
    async runtime(key: string, directory = '/workspace', env: Record<string, string> = {}) {
      await host.runtimes.ensure({ key, directory, env });
      await host.runtimes.get(key)?.refreshActivity();
      return feeds.length - 1;
    },
    event(feed: number, type: string, properties: Record<string, unknown>) {
      const { source, callbacks } = feeds[feed];
      callbacks.onEvent({
        type,
        properties,
        directory: source.directory,
        nativeRuntimeId: source.nativeRuntimeId,
      });
    },
    async advance(ms: number) {
      now += ms;
      for (let index = 0; index < feeds.length; index++)
        fixture.event(index, 'server.heartbeat', {});
      for (const handler of [...intervals.values()]) handler();
      await settle();
    },
    setAbort(reply: typeof abortReply) {
      abortReply = reply;
    },
    setSummary(reply: typeof summaryReply) {
      summaryReply = reply;
    },
    setSnapshot(observations: SessionObservation[]) {
      snapshot = observations;
    },
    prepare(value: boolean) {
      preparing = value;
    },
    async dispose() {
      host.turns.shutdown();
      terminals.shutdown();
      await host.runtimes.shutdown();
      await server.stop(true);
    },
  };
  return fixture;
}

describe('production session host composition', () => {
  it('keeps preparation active without native compute or pending work', async () => {
    const f = await hostFixture();
    try {
      expect(f.host.runtimes.needsCompute()).toBe(false);
      expect(f.host.turns.hasPendingWork()).toBe(false);
      expect(f.host.getHeartbeat().active).toBe(false);
      f.prepare(true);
      expect(f.host.getHeartbeat().active).toBe(true);
      f.prepare(false);
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('keeps pending delivery and finalization active without native compute', async () => {
    const f = await hostFixture();
    const summary = Promise.withResolvers<boolean>();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory: '/workspace',
        attemptId: 'a',
      });
      f.setSummary(() => summary.promise);
      f.host.turns.submit('workspace_chat', {
        messageId: 'm1',
        turn: { type: 'prompt', prompt: 'test' },
        agent: { mode: 'code', model: 'test/model' },
        finalization: { condenseOnComplete: true },
      });
      await f.promptRequested;
      await settle();
      expect(f.host.runtimes.needsCompute()).toBe(false);
      expect(f.host.turns.hasPendingWork()).toBe(true);
      expect(f.host.getHeartbeat().active).toBe(true);

      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await f.summaryRequested;
      expect(f.host.runtimes.needsCompute()).toBe(false);
      expect(f.host.turns.hasPendingWork()).toBe(true);
      expect(f.host.getHeartbeat().active).toBe(true);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);

      summary.resolve(true);
      await settle();
      expect(f.host.turns.hasPendingWork()).toBe(false);
      expect(f.host.getHeartbeat().active).toBe(false);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm1' },
      ]);
    } finally {
      summary.resolve(true);
      await f.dispose();
    }
  });

  it('blocks workspace capture for a terminal without extending compute activity', async () => {
    const f = await hostFixture();
    const session = {
      sessionId: 'workspace_terminal',
      kiloSessionId: 'ses_terminal',
      directory: '/workspace',
    };
    try {
      await f.runtime('/workspace');
      f.terminals.rememberAttachedSession(session, '/workspace');
      expect(
        await f.terminals.handle({
          type: 'terminal.create',
          requestId: 'create',
          session,
          payload: { operationId: crypto.randomUUID() },
        })
      ).toMatchObject({ ok: true, result: { pty: { id: 'pty_terminal' } } });
      expect(
        await f.terminals.handle({
          type: 'terminal.connect',
          requestId: 'connect',
          session,
          payload: {
            ownerId: 'user_1',
            ptyId: 'pty_terminal',
            bridgeGeneration: crypto.randomUUID(),
            capability: 'a'.repeat(64),
          },
        })
      ).toMatchObject({ ok: true, result: { connected: true } });
      expect(f.terminals.recentInputCount()).toBe(0);
      expect(f.host.getHeartbeat().active).toBe(false);
      expect(f.host.getHeartbeat().workspaceBusy).toBe(true);

      const socket = f.terminalSocket();
      if (!socket) throw new Error('terminal socket was not opened');
      socket.send('keystroke');
      await settle();
      expect(f.terminals.recentInputCount()).toBe(1);
      expect(f.host.runtimes.needsCompute()).toBe(false);
      expect(f.host.turns.hasPendingWork()).toBe(false);
      expect(f.host.getHeartbeat().active).toBe(false);
      expect(f.host.getHeartbeat().workspaceBusy).toBe(true);
      await f.terminals.forgetSession(session.sessionId);
      expect(f.host.getHeartbeat().workspaceBusy).toBe(false);
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      await f.terminals.forgetSession(session.sessionId);
      await f.dispose();
    }
  });

  it.each([
    ['response-first', 0, 'after-open'],
    ['response-first', 1, 'after-open'],
    ['close-first', 0, 'after-open'],
    ['close-first', 1, 'after-open'],
    ['response-first', 1, 'before-open'],
    ['close-first', 1, 'before-open'],
    ['response-first', 1, 'after-response'],
    ['response-first', 1, 'snapshot-before-close'],
    ['response-first', 1, 'idle-dropped'],
  ])(
    'does not complete a compact follow-up before it runs with %s delivery, %i ms elapsed and %s receipt',
    async (order, elapsed, receipt) => {
      const f = await hostFixture();
      const summary = Promise.withResolvers<boolean>();
      try {
        const feed = await f.runtime('/workspace');
        f.host.turns.registerRoute({
          sessionId: 'workspace_chat',
          kiloSessionId: 'ses_root',
          directory: '/workspace',
          attemptId: 'a',
        });
        f.setSummary(() => summary.promise);
        f.host.turns.submit('workspace_chat', {
          messageId: 'c1',
          turn: { type: 'command', command: 'compact', arguments: '' },
          agent: { mode: 'code', model: 'test/model' },
        });
        await f.summaryRequested;
        expect(f.summaries).toEqual(['/session/ses_root/summarize']);
        const submitFollowup = () =>
          f.host.turns.submit('workspace_chat', {
            messageId: 'm1',
            turn: { type: 'prompt', prompt: 'follow-up' },
            agent: { mode: 'code', model: 'test/model' },
          });
        if (receipt === 'before-open') {
          submitFollowup();
          await f.advance(elapsed);
        }
        if (receipt !== 'after-response') {
          f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
          if (receipt !== 'idle-dropped')
            f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
        }
        if (receipt !== 'before-open') {
          await f.advance(elapsed);
          submitFollowup();
        }
        await settle();
        expect(f.prompts).toEqual([]);

        if (order === 'response-first') {
          summary.resolve(true);
          await settle();
          expect(f.prompts).toEqual([]);
        }
        if (receipt === 'after-response') {
          f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
          f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
        }
        if (receipt === 'snapshot-before-close') {
          f.setSnapshot([
            {
              id: 'ses_root',
              directory: '/workspace',
              status: 'idle',
              messages: [],
              interactions: [],
            },
          ]);
          await f.host.runtimes.get('/workspace')?.refreshActivity();
          await settle();
          expect(f.prompts).toEqual([]);
        }
        f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
        await settle();
        expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
        expect(f.host.getHeartbeat().active).toBe(true);
        if (receipt === 'idle-dropped') {
          expect(f.prompts).toEqual([]);
          f.setSnapshot([
            {
              id: 'ses_root',
              directory: '/workspace',
              status: 'idle',
              messages: [],
              interactions: [],
            },
          ]);
          await f.host.runtimes.get('/workspace')?.refreshActivity();
        }
        summary.resolve(true);
        await f.promptRequested;
        await settle();
        expect(f.prompts).toEqual(['/session/ses_root/prompt_async']);

        f.event(feed, 'message.updated', {
          info: { id: 'm1', sessionID: 'ses_root', role: 'user' },
        });
        f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
        f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
        f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
        await settle();
        expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
          { status: 'completed', lastMessageId: 'm1' },
        ]);
        expect(f.host.getHeartbeat().active).toBe(false);
      } finally {
        summary.resolve(true);
        await f.dispose();
      }
    }
  );

  it('bounds a follow-up waiting for a missing compact close', async () => {
    const f = await hostFixture();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory: '/workspace',
        attemptId: 'a',
      });
      f.host.turns.submit('workspace_chat', {
        messageId: 'c1',
        turn: { type: 'command', command: 'compact', arguments: '' },
        agent: { mode: 'code', model: 'test/model' },
      });
      await f.summaryRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.host.turns.submit('workspace_chat', {
        messageId: 'm1',
        turn: { type: 'prompt', prompt: 'follow-up' },
        agent: { mode: 'code', model: 'test/model' },
      });
      await settle();
      expect(f.prompts).toEqual([]);
      f.setSnapshot([
        { id: 'ses_root', directory: '/workspace', status: 'idle', messages: [], interactions: [] },
      ]);
      await f.host.runtimes.get('/workspace')?.refreshActivity();
      await f.advance(120_000 - 1);
      f.host.turns.tick();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      expect(f.host.getHeartbeat().active).toBe(true);

      await f.advance(1);
      f.host.turns.tick();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'prompt_failed', lastMessageId: 'm1' },
      ]);
      expect(f.host.getHeartbeat().active).toBe(false);
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.prompts).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it('recovers an unconfirmed abort through the runtime owner and reports interrupted autonomous siblings', async () => {
    const f = await hostFixture();
    try {
      const feed = await f.runtime('/workspace');
      for (const [sessionId, kiloSessionId] of [
        ['workspace_a', 'ses_root'],
        ['workspace_b', 'ses_sibling'],
      ]) {
        f.host.turns.registerRoute({
          sessionId,
          kiloSessionId,
          directory: '/workspace',
          attemptId: 'a',
        });
      }
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      await f.advance(10 * 60_000);
      f.event(feed, 'session.turn.open', { sessionID: 'ses_sibling' });
      f.setAbort(async () => false);
      await f.advance(10 * 60_000);
      await settle();
      expect(f.stopped).toHaveLength(1);
      expect(f.feeds).toHaveLength(2);
      const errors = f.frames.flatMap(frame =>
        frame.type === 'session.events'
          ? frame.events
              .filter(event => event.type === 'session.error')
              .map(event => ({ sessionId: frame.sessionId, reason: event.properties.reason }))
          : []
      );
      expect(errors).toEqual([
        { sessionId: 'workspace_a', reason: 'no_progress' },
        { sessionId: 'workspace_b', reason: 'agent_unresponsive' },
      ]);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      expect(f.host.getHeartbeat().active).toBe(false);
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      expect(f.host.getHeartbeat().active).toBe(false);
      f.event(1, 'session.turn.open', { sessionID: 'ses_root' });
      expect(f.host.getHeartbeat().active).toBe(true);
    } finally {
      await f.dispose();
    }
  });
  it('feeds autonomous activity into allocation leases beyond idleMs, then permits the normal idle stop', async () => {
    // Worker contracts are checked by the service tsconfig. A computed import keeps
    // Cloudflare's ambient types out of this Bun wrapper compilation.
    const allocationModule = new URL(
      '../../../src/control-plane/sandbox/allocation.ts',
      import.meta.url
    );
    const { initialAllocationState, reduceAllocation } = await import(allocationModule.pathname);
    const f = await hostFixture();
    try {
      const feed = await f.runtime('/workspace');
      let allocation = {
        ...initialAllocationState(),
        kind: 'connected',
        allocationId: 'allocation',
        connectionId: 'socket',
        providerRef: 'provider',
        wrapperId: 'wrapper',
        lastActivityAt: f.now(),
        lastFrameAt: f.now(),
      };
      const heartbeat = () => {
        const result = reduceAllocation(
          allocation,
          {
            type: 'heartbeat',
            at: f.now(),
            allocationId: 'allocation',
            connectionId: 'socket',
            active: f.host.getHeartbeat().active,
          },
          CONTROL_PLANE_TIMERS.sandbox
        );
        allocation = result.state;
        return result.effects;
      };
      const alarm = () => {
        const result = reduceAllocation(
          allocation,
          {
            type: 'tick',
            at: f.now(),
            nextAllocationId: 'next',
            retryAllowed: false,
          },
          CONTROL_PLANE_TIMERS.sandbox
        );
        allocation = result.state;
        return result.effects;
      };
      f.event(feed, 'session.turn.open', { sessionID: 'ses_autonomous' });
      for (let elapsed = 0; elapsed < 11 * 60_000; elapsed += 5_000) {
        await f.advance(5_000);
        expect(heartbeat().some((effect: { type: string }) => effect.type === 'lease')).toBe(true);
        alarm();
        expect(allocation.kind).toBe('connected');
      }
      f.event(feed, 'session.status', { sessionID: 'ses_autonomous', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_autonomous', reason: 'completed' });
      for (let elapsed = 5_000; elapsed < CONTROL_PLANE_TIMERS.sandbox.idleMs; elapsed += 5_000) {
        await f.advance(5_000);
        expect(heartbeat().some((effect: { type: string }) => effect.type === 'lease')).toBe(false);
        alarm();
        expect(allocation.kind).toBe('connected');
      }
      await f.advance(5_000);
      heartbeat();
      alarm();
      expect(allocation.kind).toBe('stopping');
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  it('renews activity for native continuations after Cloud completion and keeps isolated siblings independent', async () => {
    const f = await hostFixture();
    try {
      const first = await f.runtime('/workspace');
      const second = await f.runtime('isolated');
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory: '/workspace',
        attemptId: 'a',
      });
      f.host.turns.submit('workspace_chat', {
        messageId: 'm1',
        turn: { type: 'prompt', prompt: 'test' },
        agent: { mode: 'code', model: 'test/model' },
      });
      await settle();
      f.event(first, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(first, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(first, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm1' },
      ]);
      expect(f.host.getHeartbeat().active).toBe(false);
      f.event(first, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(second, 'session.turn.open', { sessionID: 'ses_unrouted' });
      expect(f.host.turns.activeTurnCount()).toBe(0);
      expect(f.host.getHeartbeat().active).toBe(true);
      await f.advance(11 * 60_000);
      expect(f.host.getHeartbeat().active).toBe(true);
      expect(f.aborts).toEqual([]);
      await f.host.runtimes.retireDirectory('/different');
      f.host.runtimes.remove('/workspace');
      expect(f.host.getHeartbeat().active).toBe(true);
      // A callback retained by the old feed cannot revive its retired process.
      f.event(first, 'session.status', { sessionID: 'ses_root', status: { type: 'busy' } });
      f.event(second, 'session.status', { sessionID: 'ses_unrouted', status: { type: 'idle' } });
      f.event(second, 'session.turn.close', { sessionID: 'ses_unrouted', reason: 'completed' });
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('commits and pushes dirty work to a real remote after an execution-limit interruption', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deadline-auto-commit-'));
    const directory = path.join(temporary, 'worktree');
    const remote = path.join(temporary, 'remote.git');
    const home = path.join(temporary, 'home');
    await fs.mkdir(directory);
    await fs.mkdir(home);
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const run = (args: string[]) => git(args, { cwd: directory, env, inheritEnv: false });
    const f = await hostFixture();
    const stopped = Promise.withResolvers<boolean>();
    try {
      for (const args of [
        ['init', '--bare', remote],
        ['init', '--initial-branch=kilo/interrupted'],
        ['config', 'user.name', 'Test'],
        ['config', 'user.email', 'test@example.com'],
        ['config', 'commit.gpgsign', 'false'],
        ['remote', 'add', 'origin', remote],
      ])
        expect((await run(args)).exitCode).toBe(0);
      await fs.writeFile(path.join(directory, 'changes.txt'), 'preserved after the time limit\n');
      const feed = await f.runtime(directory, directory, env);
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory,
        attemptId: 'a',
      });
      f.host.turns.submit('workspace_chat', {
        messageId: 'm1',
        turn: { type: 'prompt', prompt: 'test' },
        agent: { mode: 'code', model: 'test/model' },
        finalization: { autoCommit: true, condenseOnComplete: true },
      });
      await settle();
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.setAbort(() => stopped.promise);
      await f.advance(CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'execution_limit', lastMessageId: 'm1' },
      ]);
      expect(
        (await run(['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/kilo/interrupted']))
          .exitCode
      ).not.toBe(0);
      expect(f.host.getHeartbeat().active).toBe(true);
      stopped.resolve(true);
      await f.autoCommitReported;
      await settle();
      const saved = await run([
        '--git-dir',
        remote,
        'show',
        'refs/heads/kilo/interrupted:changes.txt',
      ]);
      expect(saved.exitCode).toBe(0);
      expect(saved.stdout).toBe('preserved after the time limit\n');
      expect((await run(['status', '--porcelain'])).stdout).toBe('');
      expect(f.summaries).toEqual([]);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toHaveLength(1);
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      stopped.resolve(true);
      await f.dispose();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  it('keeps heartbeat active and follow-ups parked until interruption auto-commit finishes', async () => {
    const committed = Promise.withResolvers<{ success: boolean }>();
    const f = await hostFixture({ runAutoCommit: () => committed.promise });
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory: '/workspace',
        attemptId: 'a',
      });
      const submit = (id: string, autoCommit = false) =>
        f.host.turns.submit('workspace_chat', {
          messageId: id,
          turn: { type: 'prompt', prompt: 'test' },
          agent: { mode: 'code', model: 'test/model' },
          finalization: { autoCommit },
        });
      submit('m1', true);
      await settle();
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      await f.advance(CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs);
      expect(f.host.runtimes.needsCompute()).toBe(false);
      expect(f.host.getHeartbeat().active).toBe(true);
      submit('m2');
      await settle();
      expect(f.prompts).toHaveLength(1);
      await f.advance(120_001);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toHaveLength(1);
      committed.resolve({ success: true });
      await settle();
      expect(f.prompts).toHaveLength(2);
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'execution_limit', lastMessageId: 'm1' },
        { status: 'completed', lastMessageId: 'm2' },
      ]);
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      committed.resolve({ success: true });
      await f.dispose();
    }
  });

  it.each(['worktree.prepareDeletion', 'worktree.delete'] as const)(
    'cancels and awaits interruption auto-commit before handling %s',
    async type => {
      const committed = Promise.withResolvers<{ success: boolean }>();
      let signal: AbortSignal | undefined;
      let deleted = false;
      const f = await hostFixture({
        runAutoCommit: input => {
          signal = input.signal;
          return committed.promise;
        },
      });
      try {
        const feed = await f.runtime('/workspace');
        f.host.turns.registerRoute({
          sessionId: 'workspace_chat',
          kiloSessionId: 'ses_root',
          directory: '/workspace',
          attemptId: 'a',
        });
        f.host.turns.submit('workspace_chat', {
          messageId: 'm1',
          turn: { type: 'prompt', prompt: 'test' },
          agent: { mode: 'code', model: 'test/model' },
          finalization: { autoCommit: true },
        });
        await settle();
        f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
        await f.advance(CONTROL_PLANE_TIMERS.wrapper.turnHardCapMs);
        expect(signal).toBeDefined();
        const dispatch = createControlPlaneFrameDispatcher({
          preparation: {},
          turns: { current: f.host.turns },
          terminals: {},
          worktreeChanges: {},
          worktreeDeletion: {
            current: {
              handle: async () => {
                deleted = true;
              },
            },
          },
          kiloRequests: {},
          send: () => undefined,
          log: () => undefined,
        });
        dispatch({
          type,
          requestId: 'delete-request',
          payload: {
            worktreeId: 'worktree_test',
            directory: '/workspace',
            sessionIds: ['ses_root'],
          },
        });
        await settle();
        expect(signal?.aborted).toBe(true);
        expect(deleted).toBe(false);
        committed.resolve({ success: false });
        await settle();
        expect(deleted).toBe(true);
      } finally {
        committed.resolve({ success: false });
        await f.dispose();
      }
    }
  );

  it('settles a deadline once, retains compute through abort, and fences cancellation from a newly accepted prompt', async () => {
    const f = await hostFixture();
    const stop = Promise.withResolvers<boolean>();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory: '/workspace',
        attemptId: 'a',
      });
      const submit = (id: string) =>
        f.host.turns.submit('workspace_chat', {
          messageId: id,
          turn: { type: 'prompt', prompt: 'test' },
          agent: { mode: 'code', model: 'test/model' },
        });
      submit('m1');
      await settle();
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.setAbort(() => stop.promise);
      await f.advance(CONTROL_PLANE_TIMERS.wrapper.noProgressMs);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'no_progress', lastMessageId: 'm1' },
      ]);
      expect(f.aborts).toEqual([{ path: '/session/ses_root/abort', scope: 'tree' }]);
      expect(f.host.getHeartbeat().active).toBe(true);
      submit('m2');
      await settle();
      expect(f.prompts).toHaveLength(1);
      stop.resolve(true);
      await settle();
      f.host.turns.tick();
      await settle();
      expect(f.prompts).toHaveLength(2);
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.error', {
        sessionID: 'ses_root',
        error: { name: 'MessageAbortedError' },
      });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'interrupted' });
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toHaveLength(1);
      expect(
        f.frames
          .flatMap(frame => (frame.type === 'session.events' ? frame.events : []))
          .filter(event => event.type === 'session.error')
      ).toEqual([]);
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'no_progress', lastMessageId: 'm1' },
        { status: 'completed', lastMessageId: 'm2' },
      ]);
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      stop.resolve(true);
      await f.dispose();
    }
  });

  it('emits a routed autonomous error without inventing an outcome and keeps a progressing sibling awake', async () => {
    const f = await hostFixture();
    const stop = Promise.withResolvers<boolean>();
    try {
      const feed = await f.runtime('/workspace');
      f.setAbort(() => stop.promise);
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory: '/workspace',
        attemptId: 'a',
      });
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      await f.advance(10 * 60_000);
      f.event(feed, 'session.turn.open', { sessionID: 'ses_other' });
      await f.advance(10 * 60_000);
      await f.abortRequested;
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      expect(f.frames.filter(frame => frame.type === 'session.events')).toContainEqual({
        type: 'session.events',
        sessionId: 'workspace_chat',
        events: [
          {
            type: 'session.error',
            properties: {
              sessionID: 'ses_root',
              reason: 'no_progress',
              error:
                'Execution stopped because it made no progress. You can continue in this chat.',
            },
          },
        ],
      });
      expect(f.aborts).toHaveLength(1);
      expect(f.host.getHeartbeat().active).toBe(true);
      const runtime = f.host.runtimes.get('/workspace');
      expect(runtime?.sessionState('ses_root')?.activity).toBe('stopping');
      stop.resolve(true);
      const deadline = Date.now() + 2_000;
      while (runtime?.sessionState('ses_root') !== undefined && Date.now() < deadline) {
        await Bun.sleep(1);
      }
      expect(runtime?.sessionState('ses_root')).toBeUndefined();
      expect(f.host.getHeartbeat().active).toBe(true);
      f.event(feed, 'session.status', { sessionID: 'ses_other', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_other', reason: 'completed' });
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      stop.resolve(true);
      await f.dispose();
    }
  });

  it('completes a Cloud turn when a completed close is deferred and reconciliation clears the execution', async () => {
    const f = await hostFixture();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute({
        sessionId: 'workspace_chat',
        kiloSessionId: 'ses_root',
        directory: '/workspace',
        attemptId: 'a',
      });
      f.host.turns.submit('workspace_chat', {
        messageId: 'm1',
        turn: { type: 'prompt', prompt: 'test' },
        agent: { mode: 'code', model: 'test/model' },
      });
      await settle();
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      // The idle/status event is dropped, so the supervisor keeps the execution
      // busy and the completed close is held instead of settling the turn.
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);

      f.setSnapshot([
        { id: 'ses_root', directory: '/workspace', status: 'idle', messages: [], interactions: [] },
      ]);
      await f.host.runtimes.get('/workspace')?.refreshActivity();
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm1' },
      ]);
    } finally {
      await f.dispose();
    }
  });
});
