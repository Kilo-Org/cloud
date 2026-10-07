import { describe, expect, it } from 'bun:test';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { createControlPlaneSessionHost } from './main.js';
import type { KiloFeedCallbacks } from './kilo-runtime.js';
import type { KiloEventFeedSource } from './kilo-event-feed.js';
import type { SessionObservation } from './session-supervisor.js';

async function settle() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
  await Bun.sleep(5);
}

async function hostFixture() {
  let now = Date.now();
  let preparing = false;
  let terminalInput = false;
  let abortReply: () => Promise<boolean> = async () => true;
  const frames: ControlPlaneWrapperFrame[] = [];
  const aborts: Array<{ path: string; scope: unknown }> = [];
  const prompts: string[] = [];
  const feeds: Array<{ source: KiloEventFeedSource; callbacks: KiloFeedCallbacks }> = [];
  const intervals = new Map<symbol, () => void>();
  const stopped: number[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/abort')) {
        aborts.push({ path: url.pathname, scope: url.searchParams.get('scope') });
        return Response.json(await abortReply());
      }
      if (url.pathname.endsWith('/prompt_async')) {
        prompts.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/command') return Response.json([]);
      return new Response(null, { status: 404 });
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
    turn: { emit: frame => frames.push(frame), now: () => now, log: () => undefined },
    isPreparing: () => preparing,
    hasRecentTerminalInput: () => terminalInput,
  });
  const fixture = {
    host,
    now: () => now,
    frames,
    feeds,
    aborts,
    prompts,
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
    setSnapshot(observations: SessionObservation[]) {
      snapshot = observations;
    },
    prepare(value: boolean) {
      preparing = value;
    },
    terminal(value: boolean) {
      terminalInput = value;
    },
    async dispose() {
      host.turns.shutdown();
      await host.runtimes.shutdown();
      await server.stop(true);
    },
  };
  return fixture;
}

describe('production session host composition', () => {
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
        { sessionId: 'workspace_b', reason: 'agent_restarted' },
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
      f.prepare(true);
      expect(f.host.getHeartbeat().active).toBe(true);
      f.prepare(false);
      f.terminal(true);
      expect(f.host.getHeartbeat().active).toBe(true);
      f.terminal(false);
      expect(f.host.getHeartbeat().active).toBe(false);
    } finally {
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
