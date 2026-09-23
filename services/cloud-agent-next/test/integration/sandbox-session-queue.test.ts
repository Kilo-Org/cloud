import { abortAllDurableObjects, env, reset, runInDurableObject } from 'cloudflare:test';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './wait-for.js';
import { router } from '../../src/router/auth.js';
import { createSessionManagementHandlers } from '../../src/router/handlers/session-management.js';
import { createSessionSendHandlers } from '../../src/router/handlers/session-send.js';
import {
  createSessionMessageRecord,
  type SessionMessage,
} from '../../src/sandbox-session/session-message-queue.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import {
  acceptedState,
  terminalState,
} from '../../src/sandbox-session/session-state.test-helpers.js';
import { createEventQueries } from '../../src/session/queries/index.js';
import {
  PENDING_SESSION_MESSAGE_LIMIT,
  createPendingSessionMessageFromIntent,
  storePendingSessionMessage,
  listPendingSessionMessages,
} from '../../src/session/pending-messages.js';
import {
  createQueuedSessionMessageState,
  putSessionMessageState,
  getSessionMessageState,
} from '../../src/session/session-message-state.js';
import type { SessionMetadata } from '../../src/persistence/session-metadata.js';

import { writeSessionMessages } from '../../src/sandbox-state/persist/access.js';
import { readRawSessionMessages } from '../../src/sandbox-state/persist/load.js';
const access = vi.hoisted(() => new Map<string, string>());
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: () => ({}) }));
vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: async (
    _db: unknown,
    input: { kiloUserId: string; cloudAgentSessionId: string }
  ) =>
    access.get(input.cloudAgentSessionId) === input.kiloUserId
      ? { kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz', organizationId: null }
      : null,
}));

const api = router({ ...createSessionSendHandlers(), ...createSessionManagementHandlers() });
const ownerId = 'queue-owner';
const agent = { mode: 'code', model: 'anthropic/claude-sonnet-4' };
const id = (index: number) => `msg_${index.toString(16).padStart(12, '0')}AbCdEfGhIjKlMn`;
type Session = ReturnType<typeof env.SANDBOX_SESSION.getByName>;

async function request(path: 'send' | 'cancelQueuedMessage', input: unknown, userId = ownerId) {
  const req = new Request(`https://queue.test/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return fetchRequestHandler({
    endpoint: '/trpc',
    req,
    router: api,
    createContext: () => ({
      env: { ...env, HYPERDRIVE: { ...env.HYPERDRIVE, connectionString: 'postgres://unused' } },
      userId,
      authToken: userId ? 'test-token' : '',
      request: req,
    }),
  });
}

function send(sessionId: string, index: number, model = agent.model) {
  return request('send', {
    cloudAgentSessionId: sessionId,
    message: { id: id(index), prompt: `queued ${index}` },
    agent: { ...agent, model },
  });
}

function cancel(sessionId: string, index: number, userId = ownerId) {
  return request('cancelQueuedMessage', { sessionId, messageId: id(index) }, userId);
}

function snapshot(session: Session) {
  return runInDurableObject(session, async (_instance, state) => ({
    messages: readRawSessionMessages(state.storage.kv),
    metadata: state.storage.kv.get<SessionMetadata>('session_metadata'),
    events: createEventQueries(drizzle(state.storage), state.storage.sql).findByFilters({}),
    alarm: await state.storage.getAlarm(),
  }));
}

/** Seed/rewrite canonical messages. `unresolved` is valid alongside an accepted head. */
function seed(storage: Parameters<typeof writeSessionMessages>[0], messages: SessionMessage[]) {
  writeSessionMessages(storage, { kind: 'unresolved' }, messages);
}

async function fixture() {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  access.set(sessionId, ownerId);
  const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
  await session.registerSession({
    identity: { sessionId, userId: ownerId },
    auth: { kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz', kilocodeToken: 'test-token' },
    agent,
  });
  await runInDurableObject(session, (_instance, state) => {
    seed(state.storage.kv, [
      {
        messageId: id(0),
        state: acceptedState({
          intent: {
            turn: { type: 'prompt', messageId: id(0), prompt: 'accepted head' },
            agent,
          },
          legacyInvalidIntent: undefined,
          acceptedAt: Date.now(),
          lastActivityAt: Date.now(),
        }),
      } satisfies SessionMessage,
    ]);
  });
  const broadcast = await runInDurableObject(session, instance => {
    const observed = vi.fn(instance['broadcastQueuedMessage'].bind(instance));
    instance['broadcastQueuedMessage'] = observed;
    return observed;
  });
  return { session, sessionId, broadcast };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
});
afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
  access.clear();
});

describe('public control queue capacity and cancellation', () => {
  it('retains the legacy public cancellation method and once-only cancellation event', async () => {
    const sessionId = `agent_${crypto.randomUUID()}`;
    access.set(sessionId, ownerId);
    const session = env.CLOUD_AGENT_SESSION.getByName(`${ownerId}:${sessionId}`);
    await session.registerSession({
      identity: { sessionId, userId: ownerId },
      auth: { kilocodeToken: 'test-token' },
      agent,
    });
    const intent = {
      turn: { type: 'prompt' as const, messageId: id(1), prompt: 'legacy queued' },
      agent,
    };
    await runInDurableObject(session, async (_instance, state) => {
      await storePendingSessionMessage(
        state.storage,
        createPendingSessionMessageFromIntent(intent)
      );
      await putSessionMessageState(state.storage, createQueuedSessionMessageState(intent));
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await (await cancel(sessionId, 1)).json()).toMatchObject({
        result: { data: { dropped: true } },
      });
    }
    await runInDurableObject(session, async (_instance, state) => {
      expect(await listPendingSessionMessages(state.storage)).toEqual([]);
      expect(await getSessionMessageState(state.storage, id(1))).toMatchObject({
        status: 'interrupted',
        completionSource: 'canceled',
      });
      expect(
        createEventQueries(drizzle(state.storage), state.storage.sql).findByFilters({
          eventTypes: ['cloud.message.canceled'],
        })
      ).toHaveLength(1);
    });
  });

  it('rejects overflow with HTTP 429 without durable or metadata side effects and allows replay at capacity', async () => {
    const { session, sessionId, broadcast } = await fixture();
    for (let index = 1; index <= PENDING_SESSION_MESSAGE_LIMIT; index++)
      expect((await send(sessionId, index)).status).toBe(200);
    const before = await snapshot(session);
    const overflow = await send(sessionId, 11, 'openai/gpt-4.1');
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toMatchObject({
      error: { data: { code: 'TOO_MANY_REQUESTS', clientError: { retryable: true } } },
    });
    expect(await snapshot(session)).toEqual(before);
    expect((await send(sessionId, 1)).status).toBe(200);
    expect(
      await session.admitSubmittedMessage({
        userId: ownerId,
        turn: { type: 'prompt', id: id(0), prompt: 'accepted head' },
        agent,
      })
    ).toMatchObject({ success: true, compatibilityDelivery: 'sent' });
    expect((await snapshot(session)).events).toEqual(before.events);
    expect(broadcast).toHaveBeenCalledTimes(PENDING_SESSION_MESSAGE_LIMIT);
  });

  it('rechecks capacity when model validation yields while another request takes the last slot', async () => {
    const { session, sessionId } = await fixture();
    for (let index = 1; index < PENDING_SESSION_MESSAGE_LIMIT; index++)
      await send(sessionId, index);
    let entered = false;
    let released = false;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
      entered = true;
      while (!released) await new Promise(resolve => setTimeout(resolve, 1));
      return Response.json({ valid: true });
    });
    const slow = send(sessionId, 11, 'openai/gpt-4.1');
    let before: Awaited<ReturnType<typeof snapshot>>;
    try {
      await waitFor(() => expect(entered).toBe(true));
      expect((await send(sessionId, 10)).status).toBe(200);
      before = await snapshot(session);
    } finally {
      released = true;
    }
    expect((await slow).status).toBe(429);
    expect(await snapshot(session)).toEqual(before);
  });

  it('serializes concurrent admissions after asynchronous model validation', async () => {
    const { session, sessionId } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 16 }, (_, index) => send(sessionId, index + 1))
    );
    expect(responses.filter(response => response.status === 200)).toHaveLength(
      PENDING_SESSION_MESSAGE_LIMIT
    );
    expect(responses.filter(response => response.status === 429)).toHaveLength(6);
    const stored = await snapshot(session);
    expect(stored.messages.filter(message => message.state.kind === 'queued')).toHaveLength(
      PENDING_SESSION_MESSAGE_LIMIT
    );
    for (const message of stored.messages.filter(message => message.state.kind === 'queued')) {
      expect(await session.getMessageResult(message.messageId)).toMatchObject({
        type: 'found',
        result: { status: 'queued' },
      });
    }
  });

  it('cancels only the target, frees one slot, appends replacement at the tail and persists retry tombstones', async () => {
    const { session, sessionId } = await fixture();
    for (let index = 1; index <= PENDING_SESSION_MESSAGE_LIMIT; index++)
      await send(sessionId, index);
    const before = await snapshot(session);
    const responses = await Promise.all([cancel(sessionId, 4), cancel(sessionId, 4)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { data: { dropped: true } } });
    }
    const after = await snapshot(session);
    expect(after.messages[0]).toEqual(before.messages[0]);
    expect(after.messages.find(message => message.messageId === id(4))).toMatchObject({
      state: { kind: 'cancelled', intent: before.messages[4].state.intent, at: expect.any(Number) },
    });
    expect(
      after.events.filter(event => event.stream_event_type === 'cloud.message.failed')
    ).toHaveLength(1);
    expect(JSON.parse(after.events.at(-1)?.payload ?? 'null')).toMatchObject({
      messageId: id(4),
      status: 'interrupted',
      accepted: false,
      delivery: 'queued',
    });
    expect(await session.getMessageResult(id(4))).toMatchObject({
      type: 'found',
      result: { status: 'interrupted' },
    });
    expect((await send(sessionId, 11)).status).toBe(200);
    expect((await send(sessionId, 12)).status).toBe(429);
    expect(
      (await snapshot(session)).messages
        .filter(message => message.state.kind === 'queued')
        .map(message => message.messageId)
    ).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11].map(id));
    const persisted = await snapshot(session);
    await abortAllDurableObjects();
    expect(await (await cancel(sessionId, 4)).json()).toMatchObject({
      result: { data: { dropped: true } },
    });
    expect((await send(sessionId, 4)).status).toBe(400);
    expect(await snapshot(env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`))).toEqual(
      persisted
    );
  });

  it('rolls back both the terminal event and state if cancellation persistence fails', async () => {
    const { session, sessionId } = await fixture();
    await send(sessionId, 1);
    const before = await snapshot(session);
    await runInDurableObject(session, instance => {
      const persist = instance['persistMessageLifecycleEvent'].bind(instance);
      instance['persistMessageLifecycleEvent'] = vi.fn(persist).mockImplementationOnce(message => {
        persist(message);
        throw new Error('Injected cancellation persistence failure');
      });
    });
    expect((await cancel(sessionId, 1)).status).toBe(500);
    expect(await snapshot(session)).toEqual(before);
    expect(await (await cancel(sessionId, 1)).json()).toMatchObject({
      result: { data: { dropped: true } },
    });
    expect(
      (await snapshot(session)).events.filter(
        event => event.stream_event_type === 'cloud.message.failed'
      )
    ).toHaveLength(1);
  });

  it('schedules the next queued head without dispatching cancelled work or renewing its budget', async () => {
    const { session, sessionId } = await fixture();
    await send(sessionId, 1);
    await send(sessionId, 2);
    await runInDurableObject(session, async (_instance, state) => {
      const messages = readRawSessionMessages(state.storage.kv);
      seed(
        state.storage.kv,
        messages.filter(message => message.messageId !== id(0))
      );
      await state.storage.deleteAlarm();
    });
    const before = await snapshot(session);
    expect(await (await cancel(sessionId, 1)).json()).toMatchObject({
      result: { data: { dropped: true } },
    });
    const after = await snapshot(session);
    expect(after.messages.find(message => message.state.kind === 'queued')).toEqual(
      before.messages[1]
    );
    expect(after.alarm).not.toBeNull();
    expect(after.messages[0]).toMatchObject({ state: { kind: 'cancelled' } });
    // The canonical cancelled union drops the queued preparation attempt.
    expect(after.messages[0].state).not.toHaveProperty('preparationAttemptId');
  });

  it('denies unauthenticated and other-owner access and cannot cancel another session message', async () => {
    const { session, sessionId } = await fixture();
    await send(sessionId, 1);
    const before = await snapshot(session);
    expect((await cancel(sessionId, 1, '')).status).toBe(401);
    expect((await cancel(sessionId, 1, 'other-owner')).status).toBe(403);
    const other = await fixture();
    expect(await (await cancel(other.sessionId, 1)).json()).toMatchObject({
      result: { data: { dropped: false } },
    });
    expect(await snapshot(session)).toEqual(before);
  });

  it.each([
    {
      name: 'accepted',
      patch: (message: SessionMessage) => ({
        ...message,
        state: acceptedState({
          intent: message.state.intent,
          legacyInvalidIntent: undefined,
          acceptedAt: 1,
          lastActivityAt: 1,
        }),
      }),
    },
    {
      name: 'unresolved dispatch',
      patch: (message: SessionMessage) => ({
        ...message,
        state: {
          ...(message.state as Extract<SessionMessage['state'], { kind: 'queued' }>),
          unresolvedDispatch: true as const,
        },
      }),
    },
    {
      name: 'failed',
      patch: (message: SessionMessage) => ({
        ...message,
        state: terminalState('failed', {
          intent: message.state.intent,
          legacyInvalidIntent: undefined,
          at: 1,
        }),
      }),
    },
    {
      name: 'cancelled',
      patch: (message: SessionMessage) => ({
        ...message,
        state: terminalState('cancelled', {
          intent: message.state.intent,
          legacyInvalidIntent: undefined,
          at: 1,
        }),
      }),
    },
  ])('refuses accepted, ambiguous and stale targets: $name', async ({ patch }) => {
    const { session, sessionId } = await fixture();
    await send(sessionId, 1);
    await runInDurableObject(session, (_instance, state) => {
      const messages = readRawSessionMessages(state.storage.kv);
      seed(
        state.storage.kv,
        messages.map(message => (message.messageId === id(1) ? patch(message) : message))
      );
    });
    const before = await snapshot(session);
    expect(await (await cancel(sessionId, 1)).json()).toMatchObject({
      result: { data: { dropped: false } },
    });
    expect(await (await cancel(sessionId, 99)).json()).toMatchObject({
      result: { data: { dropped: false } },
    });
    expect(await snapshot(session)).toEqual(before);
  });

  it.each([
    {
      name: 'preparing',
      patch: (message: SessionMessage) => ({
        ...message,
        state: {
          ...(message.state as Extract<SessionMessage['state'], { kind: 'queued' }>),
          preparationAttemptId: 'attempt-original',
          deadlineAt: Date.now() + 60_000,
        },
      }),
    },
    {
      name: 'wrapper-bound',
      patch: (message: SessionMessage) => ({
        ...message,
        state: {
          ...(message.state as Extract<SessionMessage['state'], { kind: 'queued' }>),
          wrapperInstanceId: 'wrapper-original',
        },
      }),
    },
  ])('drops a queued $name target', async ({ patch }) => {
    const { session, sessionId } = await fixture();
    await send(sessionId, 1);
    await runInDurableObject(session, (_instance, state) => {
      const messages = readRawSessionMessages(state.storage.kv);
      seed(
        state.storage.kv,
        messages.map(message => (message.messageId === id(1) ? patch(message) : message))
      );
    });
    const before = await snapshot(session);
    expect(await (await cancel(sessionId, 1)).json()).toMatchObject({
      result: { data: { dropped: true } },
    });
    const after = await snapshot(session);
    expect(after).not.toEqual(before);
    // The cancelled union drops the queued deadline; it keeps the intent and the
    // cancellation reason.
    const beforeTarget = before.messages.find(message => message.messageId === id(1));
    const afterTarget = after.messages.find(message => message.messageId === id(1));
    expect(afterTarget).toMatchObject({
      state: {
        kind: 'cancelled',
        reason: 'queued_message_cancelled',
        at: expect.any(Number),
      },
    });
    // Ordinary cancellation is not allocation loss, so the delivery identity the
    // queued message owned is retained (only STOPPED terminalization clears it).
    expect(afterTarget?.state.wrapperInstanceId).toBe(beforeTarget?.state.wrapperInstanceId);
    expect(afterTarget?.state.preparationAttemptId).toBe(beforeTarget?.state.preparationAttemptId);
  });

  it('counts the preparing head and frees a slot when that head is cancelled', async () => {
    const { session, sessionId } = await fixture();
    for (let index = 1; index <= PENDING_SESSION_MESSAGE_LIMIT; index++)
      await send(sessionId, index);
    await runInDurableObject(session, (_instance, state) => {
      const messages = readRawSessionMessages(state.storage.kv);
      seed(
        state.storage.kv,
        messages
          .filter(message => message.messageId !== id(0))
          .map(message =>
            message.messageId === id(1)
              ? {
                  ...message,
                  state: {
                    ...(message.state as Extract<SessionMessage['state'], { kind: 'queued' }>),
                    preparationAttemptId: 'original',
                    deadlineAt: Date.now() + 60_000,
                  },
                }
              : message
          )
      );
    });
    expect((await send(sessionId, 11)).status).toBe(429);
    expect(await (await cancel(sessionId, 1)).json()).toMatchObject({
      result: { data: { dropped: true } },
    });
    expect(
      (await snapshot(session)).messages.find(message => message.messageId === id(1))
    ).toMatchObject({
      state: { kind: 'cancelled', reason: 'queued_message_cancelled' },
    });
    expect((await send(sessionId, 11)).status).toBe(200);
  });
});

describe('preserved queued work after allocation loss', () => {
  it('arms a preserved null-deadline row and fails it at the delivery bound', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}`;
    access.set(sessionId, ownerId);
    const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
    const wrapperInstanceId = crypto.randomUUID();
    const kiloSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
    const incarnation = 'incarnation-preserved-queue';
    const messageId = id(0);
    await session.registerSession({
      identity: { sessionId, userId: ownerId, createdOnPlatform: 'cloud-agent-web' },
      auth: { kiloSessionId, kilocodeToken: 'test-token' },
      agent,
      workspace: { sandboxId, sandboxProvider: 'cloudflare' },
    });
    await runInDurableObject(session, async (_instance, state) => {
      seed(state.storage.kv, [
        createSessionMessageRecord({
          turn: { type: 'prompt', messageId, prompt: 'preserved after loss' },
          agent,
        }),
      ]);
      await state.storage.put('terminal_attached_session', {
        ownerId,
        sessionId,
        kiloSessionId,
        directory: '/workspace/preserved',
        sandboxId,
        wrapperInstanceId,
        allocationIncarnation: incarnation,
      });
      // Clear any registration alarm so the assertion below is caused by the
      // preserved-queue arm, not an older one.
      await state.storage.deleteAlarm();
    });

    await runInDurableObject(session, async instance => {
      await instance.notifyStopped({
        reason: 'idle',
        stopProof: {
          effect: 'destroy',
          at: Date.now(),
          providerRef: encodeCloudflareProviderRef({
            sandboxId,
            containment: true,
            instanceId: incarnation,
          }),
          incarnation,
          reason: 'idle',
          wrapper: wrapperInstanceId,
        },
      });
    });

    await waitFor(async () => {
      const armed = await runInDurableObject(session, (_instance, state) =>
        state.storage.getAlarm()
      );
      expect(armed).not.toBeNull();
    });
    await runInDurableObject(session, async (_instance, state) => {
      const [row] = readRawSessionMessages(state.storage.kv);
      expect(row).toMatchObject({ state: { kind: 'queued', deadlineAt: null } });
    });

    // Acquisition never succeeds (no receipt/wrapper): the drain must park the
    // preserved row and keep it queued rather than dropping it.
    const stubControl = {
      ensureReady: async () => ({
        physical: 'creating' as const,
        connection: 'not_ready' as const,
      }),
    };
    const drain = () =>
      runInDurableObject(session, async instance => {
        const original = instance['env'].SANDBOX_CONTROL;
        instance['env'].SANDBOX_CONTROL = { getByName: () => stubControl } as never;
        try {
          await instance.alarm();
        } finally {
          instance['env'].SANDBOX_CONTROL = original;
        }
      });

    await drain();
    const drained = await runInDurableObject(
      session,
      (_instance, state) => readRawSessionMessages(state.storage.kv)[0]
    );
    expect(drained?.state.kind).toBe('queued');
    const deadlineAt = drained?.state.kind === 'queued' ? drained.state.deadlineAt : null;
    expect(deadlineAt).toEqual(expect.any(Number));

    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadlineAt!);
    try {
      await drain();
    } finally {
      clock.mockRestore();
    }
    const [failed] = await runInDurableObject(session, (_instance, state) =>
      readRawSessionMessages(state.storage.kv)
    );
    expect(failed).toMatchObject({ state: { kind: 'failed', reason: 'preparation_timeout' } });
  });
});
