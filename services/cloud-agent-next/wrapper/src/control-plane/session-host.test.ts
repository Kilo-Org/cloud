import { describe, expect, it } from 'bun:test';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { createControlPlaneSessionHost } from './main.js';
import type { KiloFeedCallbacks } from './kilo-runtime.js';
import type { KiloEventFeedSource } from './kilo-event-feed.js';
import type { SessionObservation } from './session-supervisor.js';
import type { TurnManagerDeps } from './turn.js';
import { createControlPlaneTerminals } from './terminals.js';

async function settle() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
  await Bun.sleep(5);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !predicate(); index++) await settle();
}

async function hostFixture(
  turn: Pick<TurnManagerDeps, 'materializeAttachments' | 'runCondense' | 'scheduler'> = {}
) {
  let now = Date.now();
  let preparing = false;
  let abortReply: () => Promise<boolean> = async () => true;
  let drainReply: () => Promise<boolean> = async () => true;
  let summaryReply: () => Promise<boolean> = async () => true;
  const frames: ControlPlaneWrapperFrame[] = [];
  const aborts: Array<{ path: string; scope: unknown }> = [];
  const drains: string[] = [];
  const prompts: string[] = [];
  const summaries: string[] = [];
  const summaryRequested = Promise.withResolvers<void>();
  const promptRequested = Promise.withResolvers<void>();
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
        return Response.json(await abortReply());
      }
      if (url.pathname.endsWith('/drain')) {
        drains.push(url.pathname);
        const body = (await request.json()) as { token: string };
        const result = await drainReply();
        // Kilo publishes the marker on the stream that is open when the drain ends.
        const source = feeds.findLast(
          feed => feed.source.server.authorization === request.headers.get('authorization')
        );
        if (result && source)
          source.callbacks.onEvent({
            type: 'session.drained',
            nativeRuntimeId: source.source.nativeRuntimeId,
            directory: source.source.directory,
            properties: { sessionID: url.pathname.split('/').at(-2), token: body.token },
          });
        return Response.json(result);
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
  let snapshotReply: () => Promise<SessionObservation[]> = async () => snapshot;
  const host = createControlPlaneSessionHost({
    runtime: {
      timers: CONTROL_PLANE_TIMERS,
      log: () => undefined,
      prepareFilesystem: async () => undefined,
      readProcessStartTime: () => undefined,
      readSnapshot: () => snapshotReply(),
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
          authorization: `Basic test-${id}`,
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
    turn: { emit: frame => frames.push(frame), now: () => now, log: () => undefined, ...turn },
    isPreparing: () => preparing,
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
    drains,
    prompts,
    summaries,
    summaryRequested: summaryRequested.promise,
    promptRequested: promptRequested.promise,
    stopped,
    async runtime(key: string) {
      await host.runtimes.ensure({ key, directory: '/workspace', env: {} });
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
    setDrain(reply: typeof drainReply) {
      drainReply = reply;
    },
    setSummary(reply: typeof summaryReply) {
      summaryReply = reply;
    },
    setSnapshot(observations: SessionObservation[]) {
      snapshot = observations;
    },
    setSnapshotReply(reply: typeof snapshotReply) {
      snapshotReply = reply;
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
      await waitFor(() => !f.host.turns.hasPendingWork());
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

  it('does not make a heartbeat active for an open terminal, even with recent input', async () => {
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

      const socket = f.terminalSocket();
      if (!socket) throw new Error('terminal socket was not opened');
      socket.send('keystroke');
      await settle();
      expect(f.terminals.recentInputCount()).toBe(1);
      expect(f.host.runtimes.needsCompute()).toBe(false);
      expect(f.host.turns.hasPendingWork()).toBe(false);
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
        await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
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
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
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
      await waitFor(() => f.frames.filter(frame => frame.type === 'session.outcome').length === 2);
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
    try {
      const feed = await f.runtime('/workspace');
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
      f.event(feed, 'session.status', { sessionID: 'ses_other', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_other', reason: 'completed' });
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it('requires native paired proof after a completed close and idle reconciliation', async () => {
    const f = await hostFixture();
    try {
      const http = Promise.withResolvers<boolean>();
      f.setDrain(() => http.promise);
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
      // A missing idle/status event leaves supervision busy. Drain still owns completion.
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);

      f.setSnapshot([
        { id: 'ses_root', directory: '/workspace', status: 'idle', messages: [], interactions: [] },
      ]);
      await f.host.runtimes.get('/workspace')?.refreshActivity();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      http.resolve(true);
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm1' },
      ]);
    } finally {
      await f.dispose();
    }
  });
});

describe('completion feed continuity and idle allocation', () => {
  const route = {
    sessionId: 'workspace_chat',
    kiloSessionId: 'ses_root',
    directory: '/workspace',
    attemptId: 'a',
  };
  const prompt = (messageId: string) => ({
    messageId,
    turn: { type: 'prompt' as const, prompt: 'test' },
    agent: { mode: 'code', model: 'test/model' },
  });

  const rootObservation = (status: 'busy' | 'idle') => ({
    id: 'ses_root',
    directory: '/workspace',
    status,
    messages: [],
    interactions: [],
  });

  it('keeps work whose root execution is still live after the reconnect, then completes it', async () => {
    const f = await hostFixture();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, prompt('m1'));
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.setSnapshot([rootObservation('busy')]);
      f.feeds[feed].callbacks.onFailure();
      await waitFor(() => f.feeds.length === 2);
      await f.host.runtimes.get('/workspace')?.refreshActivity();
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      f.event(1, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(1, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm1' },
      ]);
      expect(f.drains).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it('fails dispatched work only after the reconnect snapshot shows its root ended in the gap', async () => {
    const stale = Promise.withResolvers<void>();
    let reads = 0;
    const f = await hostFixture();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, prompt('m1'));
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      // A snapshot that began before the loss shows the root live; it must not settle the gap.
      f.setSnapshotReply(async () => {
        reads++;
        if (reads === 1) {
          await stale.promise;
          return [rootObservation('busy')];
        }
        return [rootObservation('idle')];
      });
      const inFlight = f.host.runtimes.get('/workspace')?.refreshActivity();
      f.feeds[feed].callbacks.onFailure();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      await waitFor(() => f.feeds.length === 2);
      stale.resolve();
      await inFlight;
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(reads).toBe(2);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'no_outcome', lastMessageId: 'm1' },
      ]);
      f.event(1, 'session.drained', { sessionID: 'ses_root', token: 'unrelated' });
      f.event(1, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toHaveLength(1);
      expect(f.prompts).toHaveLength(1);
      expect(f.drains).toEqual([]);
      expect(
        f.frames.some(
          frame =>
            frame.type === 'session.events' &&
            frame.events.some(
              event =>
                event.type === 'error' &&
                String(event.properties.error).includes('history is incomplete')
            )
        )
      ).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('fails observed work whose root a snapshot ended before the gap without a seen close', async () => {
    const f = await hostFixture();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, prompt('m1'));
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.setSnapshot([rootObservation('idle')]);
      await f.host.runtimes.get('/workspace')?.refreshActivity();
      expect(f.host.runtimes.get('/workspace')?.liveTreeExecutions('ses_root')).toEqual([]);
      f.feeds[feed].callbacks.onFailure();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'no_outcome', lastMessageId: 'm1' },
      ]);
    } finally {
      await f.dispose();
    }
  });

  it('keeps a held drain across a gap after a failed periodic snapshot, then completes it', async () => {
    const child = (status: 'busy' | 'idle') => ({
      ...rootObservation(status),
      id: 'ses_child',
      parentID: 'ses_root',
    });
    const drain = Promise.withResolvers<boolean>();
    const f = await hostFixture();
    try {
      f.setDrain(() => drain.promise);
      const feed = await f.runtime('/workspace');
      const runtime = f.host.runtimes.get('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, prompt('m1'));
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.setSnapshot([rootObservation('busy'), child('busy')]);
      await runtime?.refreshActivity();
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.drains.length === 1);
      // Kilo stalls: the periodic snapshot times out while the feed is still open.
      f.setSnapshotReply(async () => {
        throw new Error('Kilo activity request timed out');
      });
      await runtime?.refreshActivity();
      expect(runtime?.liveTreeExecutions('ses_root')).toHaveLength(1);
      f.setSnapshotReply(async () => [rootObservation('idle'), child('busy')]);
      f.feeds[feed].callbacks.onFailure();
      await waitFor(() => f.feeds.length === 2);
      await runtime?.refreshActivity();
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      f.event(1, 'session.status', { sessionID: 'ses_child', status: { type: 'idle' } });
      f.event(1, 'session.turn.close', { sessionID: 'ses_child', reason: 'completed' });
      drain.resolve(true);
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm1' },
      ]);
      expect(f.drains).toHaveLength(1);
    } finally {
      drain.resolve(false);
      await f.dispose();
    }
  });

  it('keeps closed but unproven work across a gap after new intake invalidates its drain', async () => {
    const attachment = Promise.withResolvers<{ prompt: string }>();
    const http = Promise.withResolvers<boolean>();
    const f = await hostFixture({
      materializeAttachments: async message => ({
        ...message,
        ...(message.id === 'm2' ? await attachment.promise : {}),
      }),
    });
    try {
      f.setDrain(() => http.promise);
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, prompt('m1'));
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.drains.length === 1);
      f.host.turns.submit(route.sessionId, prompt('m2'));
      await settle();
      f.feeds[feed].callbacks.onFailure();
      await waitFor(() => f.feeds.length === 2);
      await f.host.runtimes.get('/workspace')?.refreshActivity();
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      f.event(1, 'server.heartbeat', {});
      f.setDrain(async () => true);
      attachment.resolve({ prompt: 'new work' });
      await waitFor(() => f.prompts.length === 2);
      f.event(1, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(1, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(1, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm2' },
      ]);
    } finally {
      http.resolve(true);
      await f.dispose();
    }
  });

  it('preserves proven work across a gap while intake is held, then keeps that intake across a gap its root survives', async () => {
    const attachment = Promise.withResolvers<{ prompt: string }>();
    const condense = Promise.withResolvers<{ success: boolean; wasAborted: boolean }>();
    const started = Promise.withResolvers<void>();
    const f = await hostFixture({
      materializeAttachments: async message => ({
        ...message,
        ...(message.id === 'm2' ? await attachment.promise : {}),
      }),
      runCondense: () => {
        started.resolve();
        return condense.promise;
      },
    });
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, {
        ...prompt('m1'),
        finalization: { condenseOnComplete: true },
      });
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await started.promise;
      f.host.turns.submit(route.sessionId, prompt('m2'));
      await settle();
      f.feeds[feed].callbacks.onFailure();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      await waitFor(() => f.feeds.length === 2);
      f.event(1, 'server.heartbeat', {});
      attachment.resolve({ prompt: 'new work' });
      await waitFor(() => f.prompts.length === 2);
      f.event(1, 'session.turn.open', { sessionID: 'ses_root' });
      f.setSnapshot([rootObservation('busy')]);
      f.feeds[1].callbacks.onFailure();
      await waitFor(() => f.feeds.length === 3);
      await f.host.runtimes.get('/workspace')?.refreshActivity();
      condense.resolve({ success: true, wasAborted: false });
      await settle();
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      f.event(2, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(2, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'm2' },
      ]);
    } finally {
      condense.resolve({ success: true, wasAborted: false });
      await f.dispose();
    }
  });

  it('keeps a compact follower blocked when earlier ordinary root work closes', async () => {
    const f = await hostFixture();
    const summary = Promise.withResolvers<boolean>();
    try {
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, prompt('first'));
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.setSummary(() => summary.promise);
      f.host.turns.submit(route.sessionId, {
        messageId: 'compact',
        turn: { type: 'command', command: 'compact', arguments: '' },
        agent: { mode: 'code', model: 'test/model' },
      });
      await f.summaryRequested;
      f.host.turns.submit(route.sessionId, prompt('follower'));
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await settle();
      expect(f.prompts).toHaveLength(1);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      summary.resolve(true);
      await settle();
      expect(f.prompts).toHaveLength(1);
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.prompts.length === 2);
      expect(f.prompts).toHaveLength(2);
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'completed', lastMessageId: 'follower' },
      ]);
    } finally {
      summary.resolve(true);
      await f.dispose();
    }
  });

  it('bounds an empty root drain even while an unrelated sibling remains active', async () => {
    const http = Promise.withResolvers<boolean>();
    const pending: Array<{ ms: number; run(): void; cancelled: boolean }> = [];
    const f = await hostFixture({
      scheduler: {
        setInterval,
        clearInterval,
        setTimeout(run, ms) {
          const timer = { ms, run, cancelled: false };
          pending.push(timer);
          return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout(handle) {
          (handle as unknown as { cancelled: boolean }).cancelled = true;
        },
      },
    });
    try {
      f.setDrain(() => http.promise);
      const feed = await f.runtime('/workspace');
      f.host.turns.registerRoute(route);
      f.host.turns.submit(route.sessionId, prompt('m1'));
      await f.promptRequested;
      f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
      f.event(feed, 'session.turn.open', { sessionID: 'ses_sibling' });
      f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
      f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
      await waitFor(() => f.drains.length === 1);
      expect(f.host.runtimes.get('/workspace')?.liveTreeExecutions('ses_root')).toEqual([]);
      expect(f.host.runtimes.get('/workspace')?.liveTreeExecutions('ses_sibling')).toHaveLength(1);
      const fire = (ms: number) => {
        const timer = pending.find(timer => timer.ms === ms && !timer.cancelled);
        expect(timer).toBeDefined();
        timer!.cancelled = true;
        timer!.run();
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(f.drains).toHaveLength(attempt + 1);
        fire(10_000);
        await settle();
        if (attempt < 2) {
          fire((attempt + 1) * 1_000);
          await waitFor(() => f.drains.length === attempt + 2);
        }
      }
      expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
        { status: 'failed', reason: 'no_outcome', lastMessageId: 'm1' },
      ]);
      expect(f.host.getHeartbeat().active).toBe(true);
    } finally {
      http.resolve(true);
      await f.dispose();
    }
  });

  it.each(['idle-stop', 'answer'] as const)(
    'lets a waiting child in native drain follow normal allocation behavior: %s',
    async mode => {
      const allocationModule = new URL(
        '../../../src/control-plane/sandbox/allocation.ts',
        import.meta.url
      );
      const { initialAllocationState, reduceAllocation } = await import(allocationModule.pathname);
      const f = await hostFixture();
      const http = Promise.withResolvers<boolean>();
      try {
        f.setDrain(() => http.promise);
        const feed = await f.runtime('/workspace');
        f.host.turns.registerRoute(route);
        f.host.turns.submit(route.sessionId, prompt('m1'));
        await f.promptRequested;
        f.event(feed, 'session.turn.open', { sessionID: 'ses_root' });
        f.event(feed, 'session.created', {
          info: { id: 'ses_child', parentID: 'ses_root', directory: '/workspace' },
        });
        f.event(feed, 'session.turn.open', { sessionID: 'ses_child' });
        f.event(feed, 'question.asked', { sessionID: 'ses_child', id: 'q' });
        f.event(feed, 'session.status', { sessionID: 'ses_root', status: { type: 'idle' } });
        f.event(feed, 'session.turn.close', { sessionID: 'ses_root', reason: 'completed' });
        f.setSnapshot([
          {
            id: 'ses_child',
            directory: '/workspace',
            parentID: 'ses_root',
            status: 'busy',
            messages: [],
            interactions: [{ id: 'q', blocking: true }],
          },
        ]);
        await waitFor(() => f.drains.length === 1);
        expect(f.host.getHeartbeat().active).toBe(false);
        expect(f.host.runtimes.get('/workspace')?.liveTreeExecutions('ses_root')).toHaveLength(1);
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
        const lastActivityAt = allocation.lastActivityAt;
        const duration = mode === 'idle-stop' ? CONTROL_PLANE_TIMERS.sandbox.idleMs : 5_000;
        for (let elapsed = 0; elapsed < duration; elapsed += 5_000) {
          await f.advance(5_000);
          const heartbeat = reduceAllocation(
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
          allocation = heartbeat.state;
          expect(heartbeat.effects).toEqual([]);
          expect(allocation.lastActivityAt).toBe(lastActivityAt);
        }
        if (mode === 'idle-stop') {
          const tick = reduceAllocation(
            allocation,
            { type: 'tick', at: f.now(), nextAllocationId: 'next', retryAllowed: false },
            CONTROL_PLANE_TIMERS.sandbox
          );
          expect(tick.state).toMatchObject({ kind: 'stopping' });
          expect(tick.stopReason).toBe('sandbox_stopped');
          expect(f.frames.filter(frame => frame.type === 'session.outcome')).toEqual([]);
        } else {
          f.event(feed, 'question.replied', { sessionID: 'ses_child', requestID: 'q' });
          f.setSnapshot([]);
          expect(f.host.getHeartbeat().active).toBe(true);
          f.event(feed, 'session.status', { sessionID: 'ses_child', status: { type: 'idle' } });
          f.event(feed, 'session.turn.close', { sessionID: 'ses_child', reason: 'completed' });
          http.resolve(true);
          await waitFor(() => f.frames.some(frame => frame.type === 'session.outcome'));
          expect(f.frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
            { status: 'completed', lastMessageId: 'm1' },
          ]);
        }
      } finally {
        http.resolve(true);
        await f.dispose();
      }
    }
  );
});
