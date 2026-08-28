import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ConversationSchema,
  MessageSchema,
  ToolCallSchema,
  type EventEnvelope,
  type Run,
  type ToolCall,
} from '@kilocode/agent-harness/contracts';
import type { CommandReply } from '@kilocode/agent-harness/journal';
import { createHarnessStore } from '@kilocode/agent-harness/resume';
import { harnessReducer, initialHarnessState } from '@kilocode/agent-harness/state';
import {
  getOldTestStoreStub,
  getTestStoreStub,
  type OldTestStore,
  type TestStore,
} from './test-worker';
import { openStore, type ConversationStore } from './store';
import {
  compareAndSetActiveRun,
  compareAndSetCall,
  executableCheckpoint,
  insertAttempt,
  insertCall,
  insertCheckpoint,
  insertGrant,
} from './records';
import { transitionWithWake } from './wake';
import * as s from './sqlite-schema';

const bindings = env as {
  STORE: DurableObjectNamespace<TestStore>;
  OLD_STORE: DurableObjectNamespace<OldTestStore>;
};
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const time = '2026-08-28T12:00:00.000Z';
const future = () => Date.now() + 3_600_000;
const conversation = ConversationSchema.parse({
  id: id(1),
  ownerUserId: 'auth0|owner',
  context: { type: 'personal' },
});
const run = (value = 10, state: Run['state'] = { status: 'queued' }): Run => ({
  id: id(value),
  conversationId: conversation.id,
  inputMessageId: id(value + 1000),
  originClientId: id(2),
  modelId: 'test/model',
  variant: 'fixed',
  state,
});
const message = (value: number, content = 'hello', runId = id(10)) =>
  MessageSchema.parse({
    id: id(value),
    role: 'user',
    content,
    clientId: null,
    createdAt: time,
    provenance: 'harness',
    protocolVersion: 1,
    runId,
  });
const acceptedEvents = (value = 10): EventEnvelope['event'][] => [
  { type: 'message', message: message(value + 1000, 'hello', id(value)) },
  { type: 'run', run: run(value) },
];
const reply: CommandReply = {
  status: 'accepted',
  commandId: id(3),
  result: { messageId: id(1010), runId: id(10) },
};
const command = { id: id(3), fingerprint: 'authenticated-command-digest' };
const call = (value = 30): ToolCall =>
  ToolCallSchema.parse({
    id: id(value),
    runId: id(10),
    name: 'app.notifications',
    definitionVersion: '1',
    arguments: { enabled: true },
    context: conversation.context,
    effect: 'side_effect',
    executionTarget: { kind: 'client', clientId: id(2) },
    approval: null,
    state: 'pending',
    result: null,
  });
const checkpoint = {
  id: id(40),
  runId: id(10),
  step: 0,
  status: 'complete' as const,
  data: { responseMessages: [{ role: 'assistant', content: 'validated step' }] },
  definitionVersions: { 'app.notifications': '1' },
};
const callDetails = {
  checkpointId: checkpoint.id,
  inputDigest: 'immutable-input',
  position: 0,
  policy: { decision: 'dispatch', permissionRevision: 0 },
};
const grant = {
  id: id(50),
  conversationId: conversation.id,
  ownerUserId: conversation.ownerUserId,
  clientId: id(2),
  toolCallId: id(30),
  context: conversation.context,
  definitionVersion: '1',
  inputDigest: callDetails.inputDigest,
  generation: 1,
  expiresAt: '2030-01-01T00:00:00.000Z',
};

async function fresh() {
  const stub = getTestStoreStub(bindings.STORE, crypto.randomUUID());
  await runInDurableObject(stub, instance => {
    instance.store.bindExistingConversation(conversation);
  });
  return stub;
}
function eventList(store: ConversationStore, after = 0, limit = 200) {
  const page = store.eventsAfter(after, limit);
  if (page.status !== 'events') throw new Error('Unexpected expired cursor');
  return page.events;
}
async function seedCall(store: ConversationStore) {
  await store.transition({ wakeAt: future() }, db => {
    insertCheckpoint(db, checkpoint);
    insertCall(db, call(), callDetails);
    return { events: [] };
  });
}

describe('real Durable Object SQLite storage', () => {
  it('migrates empty storage without inventing a conversation or active work', async () => {
    const stub = getTestStoreStub(bindings.STORE, crypto.randomUUID());
    await runInDurableObject(stub, async (instance, state) => {
      expect(instance.store.snapshot()).toBeNull();
      instance.store.bindExistingConversation({
        id: conversation.id,
        ownerUserId: conversation.ownerUserId,
        context: conversation.context,
      });
      expect(instance.store.snapshot()).toEqual({
        protocolVersion: 1,
        conversation,
        recentMessages: [],
        historyCursor: null,
        activeRun: null,
        queuedRuns: [],
        unresolvedInteractions: [],
        pendingClientActions: [],
        eventCursor: 0,
      });
      expect(instance.store.pendingProjections(Date.now())).toEqual([]);
      expect(instance.store.getCommand(command.id)).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
      expect((await openStore(state)).snapshot()).toEqual(instance.store.snapshot());
    });
  });

  it('commits state, ordered events, and the original reply once under racing commands', async () => {
    const stub = await fresh(),
      wakeAt = future();
    expect(
      await Promise.all([
        stub.commit({ command, wakeAt }, acceptedEvents(), reply),
        stub.commit({ command, wakeAt }, acceptedEvents(), reply),
      ])
    ).toEqual([reply, reply]);
    await runInDurableObject(stub, (instance, state) => {
      const snapshot = instance.store.snapshot();
      expect(snapshot?.recentMessages.map(row => row.id)).toEqual([id(1010)]);
      expect(snapshot?.queuedRuns.map(row => row.id)).toEqual([id(10)]);
      expect(eventList(instance.store).map(event => event.sequence)).toEqual([1, 2]);
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
      expect(drizzle(state.storage).select().from(s.commands).all()).toHaveLength(1);
    });
  });

  it('rolls back state, events, projection work, and results after a late uniqueness failure', async () => {
    const stub = await fresh();
    await runInDurableObject(stub, async instance => {
      await expect(
        instance.store.transition({ command, wakeAt: future() }, db => {
          db.insert(s.projectionWork)
            .values({ id: 'projection-1', messageId: id(1010), data: { text: 'hello' }, dueAt: 1 })
            .run();
          // The final result insert fails after the materialized state and events have been written.
          db.insert(s.commands)
            .values({ id: command.id, fingerprint: command.fingerprint, reply, sequence: 0 })
            .run();
          return { events: acceptedEvents(), reply };
        })
      ).rejects.toThrow();
      expect(instance.store.snapshot()).toMatchObject({
        recentMessages: [],
        queuedRuns: [],
        eventCursor: 0,
      });
      expect(instance.store.getCommand(command.id)).toBeNull();
      expect(instance.store.pendingProjections(Date.now())).toEqual([]);
      expect(eventList(instance.store)).toEqual([]);
      await instance.store.transition({ command, wakeAt: future() }, () => ({
        events: acceptedEvents(),
        reply,
      }));
      expect(eventList(instance.store).map(event => event.sequence)).toEqual([1, 2]);
    });
  });

  it('replays a stored rejection after restart instead of admitting the command again', async () => {
    const stub = await fresh();
    const rejected: CommandReply = {
      status: 'rejected',
      commandId: command.id,
      error: {
        code: 'limit_exceeded',
        message: 'The stored command exceeded its limit.',
        retryable: false,
      },
    };
    expect(await stub.commit({ command, wakeAt: null }, [], rejected)).toEqual(rejected);
    await abortAllDurableObjects();
    const restarted = getTestStoreStub(bindings.STORE, stub.id);
    expect(await restarted.commit({ command, wakeAt: future() }, acceptedEvents(), reply)).toEqual(
      rejected
    );
    await runInDurableObject(restarted, async (instance, state) => {
      expect(instance.store.getCommand(command.id)?.reply).toEqual(rejected);
      expect(instance.store.snapshot()).toMatchObject({
        recentMessages: [],
        queuedRuns: [],
        eventCursor: 0,
      });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('rejects conflicting replay without replacing the reply or admitting another run', async () => {
    const stub = await fresh();
    await stub.commit({ command, wakeAt: future() }, acceptedEvents(), reply);
    const conflict = await stub.commit(
      { command: { ...command, fingerprint: 'changed-input' }, wakeAt: future() },
      acceptedEvents(11),
      reply
    );
    expect(conflict).toMatchObject({
      status: 'rejected',
      commandId: command.id,
      error: { code: 'command_conflict', retryable: false },
    });
    await runInDurableObject(stub, instance => {
      expect(instance.store.snapshot()?.queuedRuns.map(row => row.id)).toEqual([id(10)]);
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
      expect(eventList(instance.store)).toHaveLength(2);
    });
  });

  it('keeps a waiting active run ahead of the durable queue across restart', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, [
      ...acceptedEvents(),
      ...acceptedEvents(11),
      ...acceptedEvents(12),
    ]);
    await stub.commit({ wakeAt: future() }, [{ type: 'run', run: run(10, { status: 'running' }) }]);
    const waiting = run(10, {
      status: 'waiting',
      waiting: { reason: 'approval', toolCallId: id(30) },
    });
    await stub.commit({ wakeAt: null }, [{ type: 'run', run: waiting }]);
    await abortAllDurableObjects();
    const restarted = getTestStoreStub(bindings.STORE, stub.id);
    await runInDurableObject(restarted, async instance => {
      await expect(
        instance.store.transition({ wakeAt: future() }, () => ({
          events: [{ type: 'run', run: run(11, { status: 'running' }) }],
        }))
      ).rejects.toThrow('command_conflict');
      expect(instance.store.snapshot()?.activeRun).toEqual(waiting);
      expect(instance.store.queuedRuns().map(row => row.data.id)).toEqual([id(11), id(12)]);
      const first = instance.store.queuedRuns(0, 1)[0];
      expect(instance.store.queuedRuns(first.position, 1).map(row => row.data.id)).toEqual([
        id(12),
      ]);
    });
    await restarted.commit({ wakeAt: future() }, [
      { type: 'run', run: run(10, { status: 'completed' }) },
    ]);
    await restarted.commit({ wakeAt: future() }, [
      { type: 'run', run: run(11, { status: 'running' }) },
    ]);
    await runInDurableObject(restarted, instance => {
      expect(instance.store.snapshot()?.activeRun?.id).toBe(id(11));
    });
  });

  it('enforces one active SQLite slot and ordered activation without changing run inputs', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, [...acceptedEvents(), ...acceptedEvents(11)]);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(
        instance.store.transition({ wakeAt: future() }, () => ({
          events: [{ type: 'run', run: run(11, { status: 'running' }) }],
        }))
      ).rejects.toThrow('command_conflict');
      await instance.store.transition({ wakeAt: future() }, () => ({
        events: [{ type: 'run', run: run(10, { status: 'running' }) }],
      }));
      await expect(
        instance.store.transition({ wakeAt: future() }, () => ({
          events: [
            { type: 'run', run: { ...run(10, { status: 'running' }), modelId: 'changed/model' } },
          ],
        }))
      ).rejects.toThrow('invalid_input');
      const db = drizzle(state.storage);
      expect(() =>
        db
          .update(s.runs)
          .set({ status: 'running', activeSlot: 1 })
          .where(eq(s.runs.id, id(11)))
          .run()
      ).toThrow();
      expect(() =>
        db
          .update(s.runs)
          .set({ status: 'running', activeSlot: null })
          .where(eq(s.runs.id, id(11)))
          .run()
      ).toThrow();
      expect(instance.store.snapshot()?.activeRun).toEqual(run(10, { status: 'running' }));
      expect(instance.store.snapshot()?.queuedRuns.map(row => row.id)).toEqual([id(11)]);
    });
  });

  it('retains original results and complete tool parts after compaction and restart', async () => {
    const stub = await fresh();
    await stub.commit({ command, wakeAt: future() }, acceptedEvents(), reply);
    const settledCall = ToolCallSchema.parse({
      ...call(),
      state: 'settled',
      result: {
        status: 'outcome_unknown',
        reason: 'Lost provider reply',
        providerReference: 'provider-operation-7',
      },
    });
    const output = MessageSchema.parse({
      ...message(1020),
      role: 'assistant',
      parts: [{ type: 'tool_call', toolCall: settledCall }],
    });
    await stub.commit({ wakeAt: null }, [
      { type: 'message', message: output },
      { type: 'run', run: run(10, { status: 'completed' }) },
    ]);
    await runInDurableObject(stub, instance => {
      expect(instance.store.compactEvents(2)).toBe(2);
      expect(instance.store.eventsAfter(0)).toEqual({ status: 'cursor_expired' });
      expect(eventList(instance.store, 2).map(event => event.sequence)).toEqual([3, 4]);
      expect(instance.store.compactEvents()).toBe(2);
    });
    await abortAllDurableObjects();
    const restarted = getTestStoreStub(bindings.STORE, stub.id);
    expect(
      await restarted.commit({ command, wakeAt: future() }, acceptedEvents(11), reply)
    ).toEqual(reply);
    await runInDurableObject(restarted, (instance, state) => {
      expect(instance.store.snapshot()).toMatchObject({
        activeRun: null,
        queuedRuns: [],
        eventCursor: 4,
      });
      expect(instance.store.history().messages.find(row => row.id === output.id)).toEqual(output);
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
      expect(drizzle(state.storage).select().from(s.events).all()).toEqual([]);
      expect(drizzle(state.storage).select().from(s.snapshots).get()?.data).toEqual(
        instance.store.snapshot()
      );
    });
  });

  it('upgrades older SQLite storage without losing legacy text, defaults, or command results', async () => {
    const stub = getOldTestStoreStub(bindings.OLD_STORE, crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage);
      const legacy = { id: id(1010), role: 'assistant', content: 'old text', createdAt: time };
      db.insert(s.conversation)
        .values({
          id: conversation.id,
          ownerUserId: conversation.ownerUserId,
          context: conversation.context,
        })
        .run();
      db.insert(s.messages)
        .values({ id: legacy.id, sequence: 1, createdAt: time, data: legacy })
        .run();
      db.insert(s.commands)
        .values({ id: command.id, fingerprint: command.fingerprint, reply, sequence: 0 })
        .run();
      expect(() => db.select().from(s.projectionWork).all()).toThrow();
      const store = await openStore(state);
      expect(store.pendingProjections(Date.now())).toEqual([]);
      expect(store.snapshot()?.conversation).toEqual(conversation);
      expect(store.history().messages).toEqual([
        {
          ...legacy,
          clientId: null,
          provenance: 'legacy',
          parts: [{ type: 'text', text: legacy.content }],
        },
      ]);
      expect(store.getCommand(command.id)?.reply).toEqual(reply);
      expect((await openStore(state)).getCommand(command.id)?.reply).toEqual(reply);
    });
  });

  it('bounds ordered replay to 200 events and resumes strictly after the cursor', async () => {
    const stub = await fresh();
    const inputs: EventEnvelope['event'][] = Array.from({ length: 205 }, (_, n) => ({
      type: 'message',
      message: message(10_000 + n),
    }));
    await stub.commit({ wakeAt: null }, inputs);
    await runInDurableObject(stub, instance => {
      const first = eventList(instance.store),
        second = eventList(instance.store, first.at(-1)!.sequence);
      expect(first.map(event => event.sequence)).toEqual(
        Array.from({ length: 200 }, (_, n) => n + 1)
      );
      expect(second.map(event => event.sequence)).toEqual([201, 202, 203, 204, 205]);
      expect(eventList(instance.store, 205)).toEqual([]);
      for (const limit of [0, -1, 1.5, 201])
        expect(() => instance.store.eventsAfter(0, limit)).toThrow();
      expect(instance.store.eventsAfter(206)).toEqual({ status: 'cursor_expired' });
    });
  });

  it('bounds replay by encoded bytes and rejects an event that cannot fit a page', async () => {
    const stub = await fresh(),
      text = 'é'.repeat(24 * 1024);
    await stub.commit(
      { wakeAt: null },
      [1, 2, 3].map(n => ({ type: 'message', message: message(10_000 + n, text) }))
    );
    await runInDurableObject(stub, async instance => {
      const first = instance.store.eventsAfter(0);
      expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
        256 * 1024
      );
      expect(eventList(instance.store).map(event => event.sequence)).toEqual([1, 2]);
      expect(eventList(instance.store, 2).map(event => event.sequence)).toEqual([3]);
      await expect(
        instance.store.transition({ command, wakeAt: null }, () => ({
          events: [{ type: 'message', message: message(20_000, 'é'.repeat(128 * 1024)) }],
          reply,
        }))
      ).rejects.toThrow('limit_exceeded');
      expect(instance.store.snapshot()?.eventCursor).toBe(3);
      expect(instance.store.getCommand(command.id)).toBeNull();
      expect(instance.store.history().messages).toHaveLength(3);
    });
  });

  it('keeps the snapshot cursor consistent and history keysets complete at timestamp ties', async () => {
    const stub = await fresh();
    await stub.commit(
      { wakeAt: null },
      Array.from({ length: 60 }, (_, n) => ({ type: 'message', message: message(10_000 + n) }))
    );
    await runInDurableObject(stub, async instance => {
      const snapshot = instance.store.snapshot()!;
      expect(snapshot.recentMessages.map(row => row.id)).toEqual(
        Array.from({ length: 50 }, (_, n) => id(10_010 + n))
      );
      const earlier = instance.store.history(snapshot.historyCursor);
      expect(earlier.messages.map(row => row.id)).toEqual(
        Array.from({ length: 10 }, (_, n) => id(10_000 + n))
      );
      expect(earlier.historyCursor).toBeNull();
      const nextMessage = message(11_000, 'after snapshot');
      await instance.store.transition({ wakeAt: null }, () => ({
        events: [
          {
            type: 'conversation',
            conversation: { ...conversation, permissionMode: 'yolo', permissionRevision: 1 },
          },
          { type: 'message', message: nextMessage },
        ],
      }));
      const resumed = eventList(instance.store, snapshot.eventCursor).reduce(
        (state, envelope) => harnessReducer(state, { type: 'event', envelope }),
        harnessReducer(initialHarnessState(), { type: 'snapshot', snapshot })
      );
      expect(resumed.messages[nextMessage.id]).toEqual(nextMessage);
      expect(resumed.conversation?.permissionMode).toBe('yolo');
      expect(resumed.eventCursor).toBe(62);
      expect(() => instance.store.history('not-a-cursor')).toThrow('invalid_input');
    });
  });

  it('retains old unresolved interactions and client waits outside display history', async () => {
    const stub = await fresh();
    const interaction = {
      id: id(70),
      kind: 'approval' as const,
      toolCall: call(),
      resolution: null,
    };
    const action = { toolCall: call(), grant: null, reason: 'locked' as const };
    await stub.commit({ wakeAt: future() }, [
      ...acceptedEvents(),
      { type: 'interaction', interaction },
      { type: 'client_action', toolCallId: call().id, action },
    ]);
    await stub.commit({ wakeAt: null }, [
      {
        type: 'run',
        run: run(10, { status: 'waiting', waiting: { toolCallId: call().id, reason: 'client' } }),
      },
      ...Array.from({ length: 60 }, (_, n): EventEnvelope['event'] => ({
        type: 'message',
        message: message(10_000 + n),
      })),
    ]);
    await runInDurableObject(stub, instance => {
      instance.store.compactEvents();
    });
    await abortAllDurableObjects();
    await runInDurableObject(getTestStoreStub(bindings.STORE, stub.id), instance => {
      const snapshot = instance.store.snapshot();
      expect(snapshot?.unresolvedInteractions).toEqual([interaction]);
      expect(snapshot?.pendingClientActions).toEqual([action]);
      expect(snapshot?.activeRun?.state).toEqual({
        status: 'waiting',
        waiting: { toolCallId: call().id, reason: 'client' },
      });
      expect(snapshot?.recentMessages.some(row => row.id === id(1010))).toBe(false);
    });
  });

  it('rejects a conflicting interaction resolution without replacing the first decision', async () => {
    const stub = await fresh();
    const interaction = {
      id: id(70),
      kind: 'approval' as const,
      toolCall: call(),
      resolution: null,
    };
    await stub.commit({ wakeAt: null }, [{ type: 'interaction', interaction }]);
    const approved = {
      ...interaction,
      resolution: {
        interactionId: interaction.id,
        commandId: command.id,
        decision: 'approve' as const,
      },
    };
    await stub.commit(
      { command, wakeAt: null },
      [{ type: 'interaction', interaction: approved }],
      reply
    );
    await runInDurableObject(stub, async (instance, state) => {
      await expect(
        instance.store.transition({ wakeAt: null }, () => ({
          events: [
            {
              type: 'interaction',
              interaction: {
                ...approved,
                resolution: { ...approved.resolution, decision: 'deny' },
              },
            },
          ],
        }))
      ).rejects.toThrow('command_conflict');
      expect(drizzle(state.storage).select().from(s.interactions).get()?.data).toEqual(approved);
      expect(instance.store.snapshot()?.unresolvedInteractions).toEqual([]);
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
    });
  });

  it('fails a snapshot instead of silently truncating unresolved work', async () => {
    const stub = await fresh();
    await stub.commit(
      { wakeAt: null },
      Array.from({ length: 201 }, (_, n) => ({
        type: 'interaction',
        interaction: { id: id(1000 + n), kind: 'approval', toolCall: call(), resolution: null },
      }))
    );
    await runInDurableObject(stub, (instance, state) => {
      expect(() => instance.store.snapshot()).toThrow('limit_exceeded');
      expect(() => instance.store.compactEvents()).toThrow('limit_exceeded');
      expect(drizzle(state.storage).select().from(s.interactions).all()).toHaveLength(201);
      expect(eventList(instance.store)).toHaveLength(200);
    });
  });

  it('deduplicates legacy UUIDs atomically and never upgrades supplied text to run authority', async () => {
    const stub = await fresh();
    await runInDurableObject(stub, async (instance, state) => {
      const forged = {
        ...message(1010),
        role: 'assistant',
        parts: [{ type: 'tool_call', toolCall: call() }],
      };
      expect(await instance.store.importLegacy(forged, 1)).toBe(true);
      expect(
        await instance.store.importLegacy({ ...forged, content: 'conflicting redelivery' }, 2)
      ).toBe(false);
      expect(instance.store.snapshot()).toMatchObject({
        activeRun: null,
        queuedRuns: [],
        eventCursor: 1,
      });
      expect(instance.store.history().messages).toEqual([
        {
          id: id(1010),
          role: 'assistant',
          content: 'hello',
          clientId: null,
          createdAt: time,
          provenance: 'legacy',
          parts: [{ type: 'text', text: 'hello' }],
        },
      ]);
      expect(drizzle(state.storage).select().from(s.conversation).get()?.legacyCursor).toBe(2);
      expect(instance.store.history().messages).toHaveLength(1);
    });
  });

  it('recovers large legacy text through bounded replay, snapshots, and history after restart', async () => {
    const stub = await fresh();
    const legacy = {
      id: id(1011),
      role: 'assistant',
      content: 'é'.repeat(128 * 1024) + '\n終わり',
      createdAt: time,
    };
    const expected = {
      ...legacy,
      clientId: null,
      provenance: 'legacy',
      parts: [{ type: 'text', text: legacy.content }],
    };
    await runInDurableObject(stub, async instance => {
      await instance.store.importLegacy({ ...legacy, id: id(1010), content: 'before' }, 1);
    });
    const client = createHarnessStore({
      conversationId: conversation.id,
      clientId: id(2),
      clock: { now: () => Date.now(), schedule: () => () => {} },
      transport: {
        read: input =>
          runInDurableObject(getTestStoreStub(bindings.STORE, stub.id), instance => {
            switch (input.type) {
              case 'getSnapshot':
                return instance.store.snapshot();
              case 'getHistory':
                return instance.store.history(input.before, input.limit);
              case 'getEvents': {
                const page = instance.store.eventsAfter(input.after, input.limit);
                expect(
                  new TextEncoder().encode(JSON.stringify(page)).byteLength
                ).toBeLessThanOrEqual(256 * 1024);
                return page;
              }
              default:
                throw new Error('Unexpected storage read');
            }
          }),
      },
    });
    try {
      await client.refresh();
      expect(client.getSnapshot().eventCursor).toBe(1);
      await runInDurableObject(stub, async (instance, state) => {
        expect(await instance.store.importLegacy(legacy, 2)).toBe(true);
        expect(
          await instance.store.importLegacy({ ...legacy, content: 'conflicting redelivery' }, 3)
        ).toBe(false);
        expect(
          await instance.store.importLegacy({ ...legacy, id: id(1012), content: 'after' }, 4)
        ).toBe(true);
        expect(drizzle(state.storage).select().from(s.conversation).get()?.legacyCursor).toBe(4);
        expect(eventList(instance.store).map(event => event.sequence)).toEqual([1]);
        expect(instance.store.eventsAfter(1)).toEqual({ status: 'cursor_expired' });
        expect(eventList(instance.store, 2).map(event => event.sequence)).toEqual([3]);
      });
      await abortAllDurableObjects();
      await client.refresh();
      expect(client.getSnapshot().connection.status).toBe('connected');
      expect(client.getSnapshot().eventCursor).toBe(3);
      expect(client.getSnapshot().messages[legacy.id]).toEqual(expected);
      expect(client.getSnapshot().messages[id(1012)]?.content).toBe('after');
      await runInDurableObject(
        getTestStoreStub(bindings.STORE, stub.id),
        async (instance, state) => {
          expect(await instance.store.importLegacy(legacy, 5)).toBe(false);
          expect(instance.store.history().messages.find(row => row.id === legacy.id)).toEqual(
            expected
          );
          expect(
            instance.store.snapshot()?.recentMessages.find(row => row.id === legacy.id)
          ).toEqual(expected);
          for (let n = 0; n < 55; n++)
            expect(
              await instance.store.importLegacy(
                { ...legacy, id: id(2000 + n), content: `later ${n}` },
                6 + n
              )
            ).toBe(true);
          expect(drizzle(state.storage).select().from(s.conversation).get()?.legacyCursor).toBe(60);
          instance.store.compactEvents();
        }
      );
      await abortAllDurableObjects();
      await client.refresh();
      expect(client.getSnapshot().connection.status).toBe('connected');
      expect(client.getSnapshot().messages[legacy.id]).toBeUndefined();
      expect(client.getSnapshot().historyCursor).not.toBeNull();
      await client.loadHistory();
      expect(client.getSnapshot().messages[legacy.id]).toEqual(expected);
      expect(Object.keys(client.getSnapshot().messages)).toHaveLength(58);
      expect(client.getSnapshot().historyCursor).toBeNull();
      expect(client.getSnapshot().eventCursor).toBe(58);
      expect(client.getSnapshot().activeRunId).toBeNull();
      expect(client.getSnapshot().queuedRunIds).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it('rolls back the legacy cursor with a failed large import and permits subsequent imports', async () => {
    const stub = await fresh();
    const legacy = {
      id: id(1011),
      role: 'assistant',
      content: 'é'.repeat(128 * 1024),
      createdAt: time,
    };
    await runInDurableObject(stub, async (instance, state) => {
      await instance.store.importLegacy({ ...legacy, id: id(1010), content: 'before' }, 1);
      const before = instance.store.snapshot();
      // Fail event insertion after the message write, inside the same SQLite transaction.
      drizzle(state.storage)
        .insert(s.events)
        .values({
          sequence: 2,
          data: {
            protocolVersion: 1,
            conversationId: conversation.id,
            sequence: 2,
            event: { type: 'message', message: message(9999) },
          },
        })
        .run();
      await expect(instance.store.importLegacy(legacy, 2)).rejects.toThrow();
      expect(instance.store.snapshot()).toEqual(before);
      expect(instance.store.history().messages.map(row => row.id)).toEqual([id(1010)]);
      expect(drizzle(state.storage).select().from(s.conversation).get()?.legacyCursor).toBe(1);
    });
    await abortAllDurableObjects();
    await runInDurableObject(getTestStoreStub(bindings.STORE, stub.id), async (instance, state) => {
      const db = drizzle(state.storage);
      expect(db.select().from(s.conversation).get()?.legacyCursor).toBe(1);
      expect(instance.store.history().messages.map(row => row.id)).toEqual([id(1010)]);
      db.delete(s.events).where(eq(s.events.sequence, 2)).run();
      expect(await instance.store.importLegacy(legacy, 2)).toBe(true);
      expect(
        await instance.store.importLegacy({ ...legacy, id: id(1012), content: 'after retry' }, 3)
      ).toBe(true);
      expect(db.select().from(s.conversation).get()?.legacyCursor).toBe(3);
      expect(instance.store.history().messages.map(row => row.content)).toEqual([
        'before',
        legacy.content,
        'after retry',
      ]);
      expect(instance.store.snapshot()?.eventCursor).toBe(3);
    });
  });

  it('persists projection work and fences stale or duplicate acknowledgments', async () => {
    const stub = await fresh();
    await runInDurableObject(stub, async instance => {
      await instance.store.transition({ command, wakeAt: future() }, db => {
        db.insert(s.projectionWork)
          .values([
            { id: 'b', messageId: id(1010), data: { text: 'hello' }, dueAt: 1 },
            { id: 'a', messageId: id(1011), data: { text: 'second' }, dueAt: 1 },
            { id: 'later', messageId: id(1012), data: {}, dueAt: 100 },
          ])
          .run();
        return { events: acceptedEvents(), reply };
      });
    });
    await abortAllDurableObjects();
    await runInDurableObject(getTestStoreStub(bindings.STORE, stub.id), instance => {
      expect(instance.store.pendingProjections(1, 1).map(row => row.id)).toEqual(['a']);
      expect(instance.store.acknowledgeProjection('a', 1, time)).toBe(false);
      expect(instance.store.pendingProjections(1).map(row => row.id)).toEqual(['a', 'b']);
      expect(instance.store.acknowledgeProjection('a', 0, time)).toBe(true);
      expect(instance.store.acknowledgeProjection('a', 0, time)).toBe(false);
      expect(instance.store.pendingProjections(1).map(row => row.id)).toEqual(['b']);
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
    });
  });

  it.each(['partial', 'failed'] as const)(
    'never authorizes calls from a %s checkpoint',
    async status => {
      const stub = await fresh();
      await stub.commit({ wakeAt: future() }, acceptedEvents());
      await runInDurableObject(stub, async (instance, state) => {
        await instance.store.transition({ wakeAt: null }, db => {
          insertCheckpoint(db, { ...checkpoint, status });
          return { events: [] };
        });
        await expect(
          instance.store.transition({ wakeAt: future() }, db => {
            insertCall(db, call(), callDetails);
            return { events: [] };
          })
        ).rejects.toThrow('invalid_input');
        const db = drizzle(state.storage);
        expect(executableCheckpoint(db, checkpoint.id)).toBeNull();
        expect(db.select().from(s.calls).all()).toEqual([]);
        expect(db.select().from(s.attempts).all()).toEqual([]);
        expect(db.select().from(s.checkpoints).get()?.status).toBe(status);
      });
    }
  );

  it('retains immutable dispatch inputs, grants, intent, and CAS outcomes through restart', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, acceptedEvents());
    await runInDurableObject(stub, async instance => {
      await seedCall(instance.store);
      await expect(
        instance.store.transition({ wakeAt: future() }, db => {
          compareAndSetCall(db, id(30), 0, { state: 'executing', approval: null, result: null });
          return { events: [] };
        })
      ).rejects.toThrow('invalid_input');
      await instance.store.transition({ wakeAt: future() }, db => {
        insertGrant(db, grant);
        insertAttempt(db, { id: id(60), toolCallId: id(30), generation: 1, grantId: grant.id });
        expect(
          compareAndSetCall(db, id(30), 0, { state: 'executing', approval: null, result: null })
        ).toBe(true);
        return { events: [] };
      });
    });
    await abortAllDurableObjects();
    await runInDurableObject(getTestStoreStub(bindings.STORE, stub.id), async (instance, state) => {
      const db = drizzle(state.storage);
      expect(executableCheckpoint(db, checkpoint.id)).toEqual(checkpoint);
      expect(db.select().from(s.grants).get()?.data).toEqual(grant);
      expect(db.select().from(s.attempts).get()?.intent).toEqual({
        toolCall: call(),
        inputDigest: callDetails.inputDigest,
        policy: callDetails.policy,
        grant,
      });
      expect(instance.store.callsForRun(id(10))[0]).toMatchObject({
        inputDigest: callDetails.inputDigest,
        data: { ...call(), state: 'executing' },
        revision: 1,
      });
      await instance.store.transition({ wakeAt: null }, transaction => {
        expect(
          compareAndSetCall(transaction, id(30), 0, {
            state: 'settled',
            approval: null,
            result: { status: 'cancelled' },
          })
        ).toBe(false);
        return { events: [] };
      });
      expect(instance.store.callsForRun(id(10))[0].data.state).toBe('executing');
      await expect(
        instance.store.transition({ wakeAt: null }, transaction => {
          const changed = {
            state: 'waiting' as const,
            approval: null,
            result: null,
            arguments: { enabled: false },
          };
          compareAndSetCall(transaction, id(30), 1, changed);
          return { events: [] };
        })
      ).rejects.toThrow('invalid_input');
      const result = {
        status: 'outcome_unknown' as const,
        reason: 'Lost receipt',
        providerReference: 'operation-1',
      };
      await instance.store.transition({ wakeAt: null }, transaction => {
        expect(
          compareAndSetCall(transaction, id(30), 1, { state: 'settled', approval: null, result })
        ).toBe(true);
        return { events: [] };
      });
      expect(instance.store.callsForRun(id(10))[0].data).toEqual({
        ...call(),
        state: 'settled',
        result,
      });
    });
  });

  it('orders calls and rejects duplicate call positions and mismatched definition versions', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, acceptedEvents());
    await runInDurableObject(stub, async instance => {
      await seedCall(instance.store);
      await instance.store.transition({ wakeAt: future() }, db => {
        insertCall(db, call(32), { ...callDetails, position: 2 });
        insertCall(db, call(31), { ...callDetails, position: 1 });
        return { events: [] };
      });
      expect(instance.store.callsForRun(id(10), -1, 2).map(row => row.id)).toEqual([
        id(30),
        id(31),
      ]);
      expect(instance.store.callsForRun(id(10), 1).map(row => row.id)).toEqual([id(32)]);
      await expect(
        instance.store.transition({ wakeAt: future() }, db => {
          insertCall(db, call(33), callDetails);
          return { events: [] };
        })
      ).rejects.toThrow();
      await expect(
        instance.store.transition({ wakeAt: future() }, db => {
          insertCall(db, { ...call(33), definitionVersion: '2' }, { ...callDetails, position: 3 });
          return { events: [] };
        })
      ).rejects.toThrow('invalid_input');
      expect(instance.store.callsForRun(id(10))).toHaveLength(3);
    });
  });
});

describe('stored identity and dispatch constraints', () => {
  it('keeps an existing thread identity and scope immutable', async () => {
    const stub = await fresh();
    await runInDurableObject(stub, async instance => {
      for (const changes of [
        { id: id(99) },
        { ownerUserId: 'another-user' },
        { context: { type: 'organization' as const, organizationId: id(99) } },
      ]) {
        expect(() =>
          instance.store.bindExistingConversation({ ...conversation, ...changes })
        ).toThrow('invalid_input');
      }
      await instance.store.transition({ wakeAt: null }, () => ({
        events: [
          {
            type: 'conversation',
            conversation: { ...conversation, permissionMode: 'yolo', permissionRevision: 1 },
          },
        ],
      }));
      instance.store.bindExistingConversation(conversation);
      expect(instance.store.snapshot()?.conversation).toEqual({
        ...conversation,
        permissionMode: 'yolo',
        permissionRevision: 1,
      });
    });
  });

  it('rejects calls and grants that do not match the stored conversation and target', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, acceptedEvents());
    await runInDurableObject(stub, async (instance, state) => {
      await instance.store.transition({ wakeAt: null }, db => {
        insertCheckpoint(db, checkpoint);
        return { events: [] };
      });
      await expect(
        instance.store.transition({ wakeAt: future() }, db => {
          insertCall(
            db,
            { ...call(), context: { type: 'organization', organizationId: id(99) } },
            callDetails
          );
          return { events: [] };
        })
      ).rejects.toThrow('invalid_input');
      expect(instance.store.callsForRun(id(10))).toEqual([]);
      await instance.store.transition({ wakeAt: future() }, db => {
        insertCall(db, call(), callDetails);
        return { events: [] };
      });
      for (const changes of [
        { conversationId: id(99) },
        { ownerUserId: 'another-user' },
        { clientId: id(99) },
        { inputDigest: 'changed-input' },
        { definitionVersion: '2' },
        { context: { type: 'organization', organizationId: id(99) } },
      ]) {
        await expect(
          instance.store.transition({ wakeAt: future() }, db => {
            insertGrant(db, { ...grant, ...changes });
            return { events: [] };
          })
        ).rejects.toThrow('invalid_input');
      }
      expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([]);
      expect(instance.store.callsForRun(id(10))[0].data).toEqual(call());
    });
  });

  it('retains one grant and execution intent per call generation', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, acceptedEvents());
    await runInDurableObject(stub, async (instance, state) => {
      await seedCall(instance.store);
      await instance.store.transition({ wakeAt: future() }, db => {
        insertGrant(db, grant);
        insertAttempt(db, { id: id(60), toolCallId: id(30), generation: 1, grantId: grant.id });
        return { events: [] };
      });
      await expect(
        instance.store.transition({ wakeAt: future() }, db => {
          insertGrant(db, { ...grant, id: id(51) });
          return { events: [] };
        })
      ).rejects.toThrow();
      await expect(
        instance.store.transition({ wakeAt: future() }, db => {
          insertAttempt(db, { id: id(61), toolCallId: id(30), generation: 1, grantId: grant.id });
          return { events: [] };
        })
      ).rejects.toThrow();
      const db = drizzle(state.storage);
      expect(
        db
          .select()
          .from(s.grants)
          .all()
          .map(row => row.data)
      ).toEqual([grant]);
      expect(
        db
          .select()
          .from(s.attempts)
          .all()
          .map(row => row.id)
      ).toEqual([id(60)]);
    });
  });
});

describe('durable prearm and transition gate', () => {
  const terminalStates = [
    { status: 'completed' },
    { status: 'cancelled' },
    {
      status: 'failed',
      error: { code: 'invalid_output', message: 'Invalid model output.', retryable: false },
    },
  ] satisfies Run['state'][];

  async function waitingWithQueue() {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, [
      ...acceptedEvents(),
      ...acceptedEvents(11),
      {
        type: 'run',
        run: run(10, { status: 'waiting', waiting: { reason: 'question', toolCallId: id(30) } }),
      },
    ]);
    // Consume the admission alarm while the active wait still blocks the queue.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    return stub;
  }

  it.each(terminalStates)(
    'rolls back a waiting run becoming $status when the queue has no prearmed wake',
    async terminal => {
      const stub = await waitingWithQueue();
      await runInDurableObject(stub, async (instance, state) => {
        const before = instance.store.snapshot();
        expect(await state.storage.getAlarm()).toBeNull();
        for (const releaseBeforeEvent of [false, true]) {
          await expect(
            instance.store.transition({ command, wakeAt: null }, db => {
              if (releaseBeforeEvent) compareAndSetActiveRun(db, id(10), null);
              return { events: [{ type: 'run', run: run(10, terminal) }], reply };
            })
          ).rejects.toThrow('invalid_input');
          expect(instance.store.snapshot()).toEqual(before);
          expect(instance.store.getCommand(command.id)).toBeNull();
          expect(eventList(instance.store).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
        }
        const failing = await openStore(state, {
          getAlarm: () => state.storage.getAlarm(),
          setAlarm: async () => {
            throw new Error('injected alarm failure');
          },
        });
        await expect(
          failing.transition({ command, wakeAt: future() }, () => ({
            events: [{ type: 'run', run: run(10, terminal) }],
            reply,
          }))
        ).rejects.toMatchObject({ code: 'storage_unavailable', retryable: true });
        expect(instance.store.snapshot()).toEqual(before);
        expect(instance.store.getCommand(command.id)).toBeNull();
        expect(eventList(instance.store).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
        expect(await state.storage.getAlarm()).toBeNull();
        const wakeAt = future();
        expect(
          await instance.store.transition({ command, wakeAt }, () => ({
            events: [{ type: 'run', run: run(10, terminal) }],
            reply,
          }))
        ).toEqual(reply);
        expect(instance.store.snapshot()).toMatchObject({ activeRun: null, eventCursor: 6 });
        expect(instance.store.queuedRuns().map(row => row.id)).toEqual([id(11)]);
        expect(await state.storage.getAlarm()).toBe(wakeAt);
      });
    }
  );

  it.each(terminalStates)(
    'wakes queued work after a waiting run becomes $status and restarts without another submission',
    async terminal => {
      const stub = await waitingWithQueue(),
        earliest = future();
      const results = await Promise.all([
        stub.commit(
          { command, wakeAt: earliest + 1000 },
          [{ type: 'run', run: run(10, terminal) }],
          reply
        ),
        stub.commit({ wakeAt: earliest }, []),
        stub.commit({ wakeAt: earliest + 2000 }, []),
      ]);
      expect(results[0]).toEqual(reply);
      await runInDurableObject(stub, async (instance, state) => {
        expect(await state.storage.getAlarm()).toBe(earliest);
        expect(instance.store.snapshot()).toMatchObject({ activeRun: null, eventCursor: 6 });
        expect(instance.store.queuedRuns().map(row => row.id)).toEqual([id(11)]);
        expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
      });
      await abortAllDurableObjects();
      const restarted = getTestStoreStub(bindings.STORE, stub.id);
      expect(await runDurableObjectAlarm(restarted)).toBe(true);
      await runInDurableObject(restarted, (instance, state) => {
        expect(instance.store.snapshot()).toMatchObject({
          activeRun: null,
          queuedRuns: [],
          eventCursor: 7,
        });
        const db = drizzle(state.storage);
        expect(
          db
            .select()
            .from(s.runs)
            .where(eq(s.runs.id, id(10)))
            .get()?.data
        ).toEqual(run(10, terminal));
        expect(
          db
            .select()
            .from(s.runs)
            .where(eq(s.runs.id, id(11)))
            .get()?.data
        ).toEqual(run(11, { status: 'completed' }));
        expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
      });
    }
  );

  it('completes a waiting run without polling when no queued work remains', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, [
      ...acceptedEvents(),
      {
        type: 'run',
        run: run(10, { status: 'waiting', waiting: { reason: 'question', toolCallId: id(30) } }),
      },
    ]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await stub.commit(
        { command, wakeAt: null },
        [{ type: 'run', run: run(10, { status: 'completed' }) }],
        reply
      )
    ).toEqual(reply);
    await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      expect(instance.store.snapshot()).toMatchObject({
        activeRun: null,
        queuedRuns: [],
        eventCursor: 4,
      });
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
    });
  });

  it('leaves no accepted work after failed prearming and permits retry with the same command', async () => {
    const stub = await fresh();
    await runInDurableObject(stub, async (instance, state) => {
      const failing = await openStore(state, {
        getAlarm: () => state.storage.getAlarm(),
        setAlarm: async () => {
          throw new Error('injected alarm failure');
        },
      });
      await expect(
        failing.transition({ command, wakeAt: future() }, () => ({
          events: acceptedEvents(),
          reply,
        }))
      ).rejects.toMatchObject({ code: 'storage_unavailable', retryable: true });
      expect(instance.store.snapshot()).toMatchObject({
        queuedRuns: [],
        recentMessages: [],
        eventCursor: 0,
      });
      expect(instance.store.getCommand(command.id)).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
      const wakeAt = future();
      expect(
        await instance.store.transition({ command, wakeAt }, () => ({
          events: acceptedEvents(),
          reply,
        }))
      ).toEqual(reply);
      expect(await state.storage.getAlarm()).toBe(wakeAt);
      expect(instance.store.snapshot()?.queuedRuns.map(row => row.id)).toEqual([id(10)]);
    });
  });

  it('arms before writing and preserves the earliest deadline across concurrent handlers', async () => {
    const stub = await fresh(),
      earliest = future();
    await runInDurableObject(stub, async (instance, state) => {
      const observed = await openStore(state, {
        getAlarm: () => state.storage.getAlarm(),
        async setAlarm(deadline) {
          expect(instance.store.getCommand(command.id)).toBeNull();
          expect(instance.store.snapshot()?.queuedRuns).toEqual([]);
          await state.storage.setAlarm(deadline);
        },
      });
      await observed.transition({ command, wakeAt: earliest + 1000 }, () => ({
        events: acceptedEvents(),
        reply,
      }));
    });
    await Promise.all([
      stub.commit({ wakeAt: earliest + 2000 }, []),
      stub.commit({ wakeAt: earliest }, []),
      stub.commit({ wakeAt: earliest + 3000 }, []),
    ]);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.store.transition({ wakeAt: null }, () => ({ events: [] }));
      expect(await state.storage.getAlarm()).toBe(earliest);
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
    });
  });

  it('leaves a harmless durable alarm when the transaction fails after prearming', async () => {
    const stub = await fresh();
    await runInDurableObject(stub, async (instance, state) => {
      await expect(
        instance.store.transition({ command, wakeAt: future() }, () => {
          throw new Error('crash after arm');
        })
      ).rejects.toThrow('crash after arm');
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(instance.store.getCommand(command.id)).toBeNull();
    });
    await abortAllDurableObjects();
    const restarted = getTestStoreStub(bindings.STORE, stub.id);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    await runInDurableObject(restarted, instance => {
      expect(instance.store.snapshot()).toMatchObject({
        recentMessages: [],
        queuedRuns: [],
        activeRun: null,
        eventCursor: 0,
      });
    });
  });

  it('wakes committed work after restart without another client submission', async () => {
    const stub = await fresh();
    await stub.commit({ command, wakeAt: future() }, acceptedEvents(), reply);
    await abortAllDurableObjects();
    const restarted = getTestStoreStub(bindings.STORE, stub.id);
    expect(await runDurableObjectAlarm(restarted)).toBe(true);
    await runInDurableObject(restarted, (instance, state) => {
      expect(instance.store.snapshot()).toMatchObject({
        queuedRuns: [],
        activeRun: null,
        eventCursor: 3,
      });
      expect(drizzle(state.storage).select().from(s.runs).get()?.data).toEqual(
        run(10, { status: 'completed' })
      );
      expect(instance.store.getCommand(command.id)?.reply).toEqual(reply);
    });
  });

  it('does not poll wait-only state and requires a prearm when work leaves waiting', async () => {
    const stub = await fresh();
    await stub.commit({ wakeAt: future() }, acceptedEvents());
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      const waiting = run(10, {
        status: 'waiting',
        waiting: { toolCallId: id(30), reason: 'question' },
      });
      await instance.store.transition({ wakeAt: null }, () => ({
        events: [{ type: 'run', run: waiting }],
      }));
      expect(await state.storage.getAlarm()).toBeNull();
      await expect(
        instance.store.transition({ wakeAt: null }, () => ({
          events: [{ type: 'run', run: run(10, { status: 'running' }) }],
        }))
      ).rejects.toThrow('invalid_input');
      expect(instance.store.snapshot()?.activeRun).toEqual(waiting);
      const wakeAt = future();
      await instance.store.transition({ wakeAt }, () => ({
        events: [{ type: 'run', run: run(10, { status: 'running' }) }],
      }));
      expect(await state.storage.getAlarm()).toBe(wakeAt);
      expect(instance.store.snapshot()?.activeRun?.state.status).toBe('running');
    });
  });

  it('rejects an asynchronous transaction result and rolls back its synchronous writes', async () => {
    const stub = await fresh();
    await runInDurableObject(stub, async (instance, state) => {
      await expect(
        transitionWithWake(state, () => ({
          wakeAt: future(),
          commit: async () => {
            drizzle(state.storage)
              .insert(s.projectionWork)
              .values({ id: 'bad-async', messageId: id(1010), data: {}, dueAt: 0 })
              .run();
            return 'not synchronous';
          },
        }))
      ).rejects.toThrow('invalid_input');
      expect(instance.store.pendingProjections(Date.now())).toEqual([]);
    });
  });
});
