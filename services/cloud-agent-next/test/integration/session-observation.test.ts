import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession';
import type { SessionMessageRecord } from '../../src/sandbox-session/session-message-queue';
import type { ResponseFrame, SessionSyncResult } from '../../src/shared/sandbox-control-protocol';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines';
import { events } from '../../src/db/sqlite-schema';

const root = 'ses_00000000000000000000000001';
const cached = {
  revision: 3,
  questions: [{ id: 'cached_question', sessionID: root }],
  permissions: [],
};
const busy: SessionSyncResult = { status: { type: 'busy' }, questions: [], permissions: [] };
const idle: SessionSyncResult = { status: { type: 'idle' }, questions: [], permissions: [] };

function response(result: SessionSyncResult): ResponseFrame {
  return { type: 'response', requestId: 'observation', ok: true, result };
}

async function fixture(instance: SandboxSession, state: DurableObjectState) {
  const wrapperInstanceId = crypto.randomUUID();
  const sessionId = instance['requireSessionId']();
  await instance.registerSession({
    identity: { sessionId, userId: 'user_observation' },
    auth: { kiloSessionId: root, kilocodeToken: 'fixture-token' },
    agent: { mode: 'code', model: 'test-model' },
    repository: { type: 'github', repo: 'Kilo-Org/cloud' },
    workspace: { sandboxId: 'usr-abcdef123419', workspacePath: '/workspace/shared' },
  });
  const message: SessionMessageRecord = {
    messageId: 'msg_observed',
    state: 'accepted',
    wrapperInstanceId,
    acceptedAt: Date.now() - DEADLINE_MS.acceptedOverdue - 100,
    lastActivityAt: Date.now() - DEADLINE_MS.acceptedOverdue - 100,
    deliveryDeadlineAt: Date.now() + 60_000,
  };
  state.storage.kv.put('session_messages', [message]);
  state.storage.kv.put('session_pending_interactions', cached);
  const pending = Promise.withResolvers<ResponseFrame>();
  const control = {
    getStatus: vi.fn(async () => ({ connection: 'ready', physical: 'running', wrapperInstanceId })),
    request: vi.fn(() => pending.promise),
    quarantineRuntime: vi.fn(async () => ({ quarantined: true })),
  };
  const originalEnv = instance['env'];
  Object.assign(instance, {
    env: { ...originalEnv, SANDBOX_CONTROL: { getByName: () => control } },
  });
  const storedEvents = () => drizzle(state.storage).select().from(events).all();
  const cleanup = async () => {
    pending.resolve(response(busy));
    Object.assign(instance, { env: originalEnv });
    await state.storage.deleteAlarm();
  };
  return { control, pending, message, storedEvents, cleanup };
}

async function connect(instance: SandboxSession) {
  const result = await instance.fetch(
    new Request('http://worker.test/stream', { headers: { Upgrade: 'websocket' } })
  );
  expect(result.status).toBe(101);
  const socket = result.webSocket;
  if (!socket) throw new Error('Missing stream socket');
  const connected = new Promise<Record<string, unknown>>(resolve => {
    socket.addEventListener('message', event => {
      const frame = JSON.parse(String(event.data)) as {
        streamEventType: string;
        data: Record<string, unknown>;
      };
      if (frame.streamEventType === 'connected') resolve(frame.data);
    });
  });
  socket.accept();
  return { socket, connected: await connected };
}

describe('Session observation wiring', () => {
  it('returns cached getters and connections while one read/application is shared with the watchdog', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_observation:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await fixture(instance, state);
      const streams: WebSocket[] = [];
      try {
        for (let index = 0; index < 3; index++) {
          expect(instance['derivePendingInteractions']()).toEqual({
            questions: cached.questions,
            permissions: [],
          });
          const stream = await connect(instance);
          streams.push(stream.socket);
          expect(stream.connected).toMatchObject({
            pendingInteractions: { questions: cached.questions, permissions: [] },
          });
        }
        await vi.waitFor(() => expect(f.control.request).toHaveBeenCalledTimes(1));
        expect(state.storage.kv.get('session_messages')).toEqual([f.message]);
        const refresh = vi.spyOn(instance['interactionRefresh'], 'refresh');
        const alarm = instance.alarm();
        await vi.waitFor(() =>
          expect(refresh).toHaveBeenCalledWith(expect.anything(), 'accepted_alarm')
        );
        expect(f.control.getStatus).toHaveBeenCalledTimes(1);
        expect(f.control.request).toHaveBeenCalledTimes(1);
        f.pending.resolve(response(busy));
        await alarm;
        expect(state.storage.kv.get('session_pending_interactions')).toEqual({
          revision: 4,
          questions: [],
          permissions: [],
        });
        expect(
          f.storedEvents().filter(event => event.stream_event_type === 'kilocode')
        ).toHaveLength(1);
        expect(state.storage.kv.get('session_messages')).toEqual([
          expect.objectContaining({
            messageId: f.message.messageId,
            state: 'accepted',
            acceptedAt: f.message.acceptedAt,
            deliveryDeadlineAt: f.message.deliveryDeadlineAt,
            lastActivityAt: expect.any(Number),
          }),
        ]);
        refresh.mockRestore();
      } finally {
        for (const socket of streams) socket.close();
        await f.cleanup();
      }
    });
  });

  it.each(['revision', 'message', 'wrapper', 'root', 'directory', 'lifecycle'] as const)(
    'discards old idle/empty application after %s changes',
    async change => {
      const stub = env.SANDBOX_SESSION.getByName(
        `user_observation:workspace_${crypto.randomUUID()}`
      );
      await runInDurableObject(stub, async (instance, state) => {
        const f = await fixture(instance, state);
        try {
          instance['derivePendingInteractions']();
          await vi.waitFor(() => expect(f.control.request).toHaveBeenCalledTimes(1));
          const refresh = vi.spyOn(instance['interactionRefresh'], 'refresh');
          const alarm = instance.alarm();
          await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
          if (change === 'revision') {
            instance['recordPendingInteraction']({
              type: 'question.asked',
              properties: { id: 'new_question', sessionID: root },
            });
          } else if (change === 'message' || change === 'wrapper') {
            state.storage.kv.put('session_messages', [
              {
                ...f.message,
                [change === 'message' ? 'messageId' : 'wrapperInstanceId']: crypto.randomUUID(),
              },
            ]);
          } else if (change === 'lifecycle') {
            const metadata = instance['terminalLifecycle'].getStoredMetadata();
            if (!metadata) throw new Error('Missing metadata');
            instance['terminalLifecycle'].beginDeletion(metadata);
          } else {
            const metadata = instance['terminalLifecycle'].getStoredMetadata();
            if (!metadata?.workspace) throw new Error('Missing metadata');
            state.storage.kv.put('session_metadata', {
              ...metadata,
              auth: {
                ...metadata.auth,
                ...(change === 'root' ? { kiloSessionId: 'ses_00000000000000000000000002' } : {}),
              },
              workspace: {
                ...metadata.workspace,
                ...(change === 'directory' ? { workspacePath: '/workspace/other' } : {}),
              },
            });
          }
          const before = {
            interactions: state.storage.kv.get('session_pending_interactions'),
            messages: state.storage.kv.get('session_messages'),
            events: f.storedEvents(),
          };
          f.pending.resolve(response(idle));
          await alarm;
          expect(state.storage.kv.get('session_pending_interactions')).toEqual(before.interactions);
          expect(state.storage.kv.get('session_messages')).toEqual(before.messages);
          expect(f.storedEvents()).toEqual(before.events);
          expect(f.control.quarantineRuntime).not.toHaveBeenCalled();
          refresh.mockRestore();
        } finally {
          await f.cleanup();
        }
      });
    }
  );

  it('preserves a shared sync failure for the watchdog runtime_unhealthy path', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_observation:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await fixture(instance, state);
      try {
        instance['derivePendingInteractions']();
        await vi.waitFor(() => expect(f.control.request).toHaveBeenCalledTimes(1));
        const refresh = vi.spyOn(instance['interactionRefresh'], 'refresh');
        const alarm = instance.alarm();
        await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
        f.pending.reject(new Error('native read failed'));
        await alarm;
        expect(f.control.request).toHaveBeenCalledTimes(1);
        expect(state.storage.kv.get('session_messages')).toEqual([
          expect.objectContaining({ state: 'failed', failedReason: 'runtime_unhealthy' }),
        ]);
        expect(f.control.quarantineRuntime).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'runtime_unhealthy',
            wrapperInstanceId: f.message.wrapperInstanceId,
          })
        );
        expect(f.storedEvents().filter(event => event.stream_event_type === 'kilocode')).toEqual(
          []
        );
        refresh.mockRestore();
      } finally {
        await f.cleanup();
      }
    });
  });

  it('preserves cached inputs on failed background sync and permits a later read', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_observation:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await fixture(instance, state);
      try {
        instance['derivePendingInteractions']();
        const shared = instance['interactionRefresh'].refresh(
          instance['captureInteractionScope'](),
          'pending_interactions'
        );
        f.pending.resolve({
          type: 'response',
          requestId: 'unknown',
          ok: false,
          error: { code: 'not_ready', message: 'Incomplete ancestry', retryable: false },
        });
        await expect(shared).rejects.toThrow('Session sync failed');
        expect(state.storage.kv.get('session_pending_interactions')).toEqual(cached);
        expect(state.storage.kv.get('session_messages')).toEqual([f.message]);
        expect(f.storedEvents()).toEqual([]);
        f.control.request.mockResolvedValue(response(busy));
        instance['derivePendingInteractions']();
        await instance['interactionRefresh'].refresh(
          instance['captureInteractionScope'](),
          'pending_interactions'
        );
        expect(f.control.request).toHaveBeenCalledTimes(2);
        expect(state.storage.kv.get('session_messages')).toEqual([f.message]);
      } finally {
        await f.cleanup();
      }
    });
  });

  it('starts a new revision read while old work is pending without letting old cleanup clear it', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_observation:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await fixture(instance, state);
      const next = Promise.withResolvers<ResponseFrame>();
      try {
        instance['derivePendingInteractions']();
        const first = instance['interactionRefresh'].refresh(
          instance['captureInteractionScope'](),
          'pending_interactions'
        );
        await vi.waitFor(() => expect(f.control.request).toHaveBeenCalledTimes(1));
        instance['recordPendingInteraction']({
          type: 'question.asked',
          properties: { id: 'new_question', sessionID: root },
        });
        f.control.request.mockReturnValue(next.promise);
        instance['derivePendingInteractions']();
        const current = instance['interactionRefresh'].refresh(
          instance['captureInteractionScope'](),
          'pending_interactions'
        );
        await vi.waitFor(() => expect(f.control.request).toHaveBeenCalledTimes(2));
        const interactions = state.storage.kv.get('session_pending_interactions');
        f.pending.resolve(response(idle));
        expect(await first).toBeUndefined();
        expect(state.storage.kv.get('session_pending_interactions')).toEqual(interactions);
        expect(f.storedEvents()).toEqual([]);
        instance['derivePendingInteractions']();
        expect(
          instance['interactionRefresh'].refresh(
            instance['captureInteractionScope'](),
            'accepted_alarm'
          )
        ).toBe(current);
        next.resolve(response(busy));
        await current;
        expect(f.control.request).toHaveBeenCalledTimes(2);
        expect(f.storedEvents()).toHaveLength(1);
        expect(state.storage.kv.get('session_messages')).toEqual([f.message]);
      } finally {
        next.resolve(response(busy));
        await f.cleanup();
      }
    });
  });

  it('fences revision changes during runtime-status setup before issuing native sync', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_observation:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await fixture(instance, state);
      const status = Promise.withResolvers<Awaited<ReturnType<typeof f.control.getStatus>>>();
      f.control.getStatus.mockReturnValue(status.promise);
      try {
        instance['derivePendingInteractions']();
        const shared = instance['interactionRefresh'].refresh(
          instance['captureInteractionScope'](),
          'pending_interactions'
        );
        await vi.waitFor(() => expect(f.control.getStatus).toHaveBeenCalledTimes(1));
        instance['recordPendingInteraction']({
          type: 'question.asked',
          properties: { id: 'new_question', sessionID: root },
        });
        status.resolve({
          connection: 'ready',
          physical: 'running',
          wrapperInstanceId: f.message.wrapperInstanceId ?? '',
        });
        expect(await shared).toBeUndefined();
        expect(f.control.request).not.toHaveBeenCalled();
        expect(f.storedEvents()).toEqual([]);
      } finally {
        status.resolve({
          connection: 'ready',
          physical: 'running',
          wrapperInstanceId: f.message.wrapperInstanceId ?? '',
        });
        await f.cleanup();
      }
    });
  });

  it('does not retarget a watchdog when the accepted message changes during alarm setup', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_observation:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await fixture(instance, state);
      const setup = Promise.withResolvers<void>();
      const original = instance['armQueueRetry'];
      Object.assign(instance, { armQueueRetry: () => setup.promise });
      try {
        const alarm = instance.alarm();
        const nextMessage = { ...f.message, messageId: 'msg_new' };
        state.storage.kv.put('session_messages', [nextMessage]);
        setup.resolve();
        await alarm;
        expect(f.control.getStatus).not.toHaveBeenCalled();
        expect(f.control.request).not.toHaveBeenCalled();
        expect(state.storage.kv.get('session_messages')).toEqual([nextMessage]);
      } finally {
        setup.resolve();
        Object.assign(instance, { armQueueRetry: original });
        await f.cleanup();
      }
    });
  });
});
