import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';
import { evaluateDispatch } from '@kilocode/agent-harness/policy';
import * as s from './db/sqlite-schema';
import {
  ConversationSchema,
  RunSchema,
  ToolCallSchema,
  type Conversation,
  type Run,
  type ToolCall,
} from '@kilocode/agent-harness/contracts';
import { admitCommand, SendResultSchema, type CommandAdapter } from './commands';
import { openStore } from './db/store';
import { getTestStoreStub, type TestStore } from './db/test-worker';
import { compareAndSetCall, insertAttempt, insertCall, insertCheckpoint } from './db/records';

const bindings = env as { STORE: DurableObjectNamespace<TestStore> };
const model = { contextTokens: 2048, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 };
const future = () => Date.now() + 3_600_000;
function fixture(context: Conversation['context'] = { type: 'personal' }) {
  const legacyConversation = {
    id: crypto.randomUUID(),
    ownerUserId: 'auth0|owner',
    context,
  };
  const conversation = ConversationSchema.parse(legacyConversation);
  const client = {
    id: crypto.randomUUID(),
    ownerUserId: conversation.ownerUserId,
    kind: 'browser' as const,
    supportedTools: [],
    revokedAt: null,
  };
  const base = {
    protocolVersion: 1 as const,
    clientId: client.id,
    conversationId: conversation.id,
  };
  const adapter: CommandAdapter = {
    authorize: async () => ({ conversation: legacyConversation, client, origin: 'user' }),
    validateModel: async () => model,
    now: future,
  };
  const stub = () => getTestStoreStub(bindings.STORE, conversation.id);
  const send = {
    ...base,
    type: 'sendMessage' as const,
    commandId: crypto.randomUUID(),
    text: 'hello',
    modelId: 'test/model',
    variant: 'fixed',
    permissionRevision: 0,
  };
  const apply = (input: unknown, override: Partial<CommandAdapter> = {}) =>
    runInDurableObject(stub(), (instance, state) =>
      admitCommand(state, instance.store, input, { ...adapter, ...override })
    );
  const open = {
    protocolVersion: 1,
    clientId: client.id,
    type: 'getOrCreateConversation',
    commandId: crypto.randomUUID(),
    context,
  };
  const mode = (revision = 0, permissionMode: 'ask' | 'yolo' = 'yolo') => ({
    ...base,
    type: 'setPermissionMode' as const,
    commandId: crypto.randomUUID(),
    permissionMode,
    expectedPermissionRevision: revision,
    acknowledgePendingActions: true,
  });
  const cancel = (runId: string) => ({
    ...base,
    type: 'cancelRun',
    commandId: crypto.randomUUID(),
    runId,
  });
  const snapshot = () => runInDurableObject(stub(), instance => instance.store.snapshot());
  const run = (id = send.commandId) =>
    runInDurableObject(stub(), (_instance, state) => {
      const row = drizzle(state.storage).select().from(s.runs).where(eq(s.runs.id, id)).get();
      return row ? RunSchema.parse(row.data) : null;
    });
  const events = () =>
    runInDurableObject(stub(), instance => {
      const page = instance.store.eventsAfter(0);
      if (page.status !== 'events') throw new Error('Unexpected expired cursor');
      return page.events;
    });
  return {
    conversation,
    client,
    base,
    adapter,
    stub,
    send,
    apply,
    open,
    mode,
    cancel,
    snapshot,
    run,
    events,
  };
}

describe('authenticated atomic command admission', () => {
  it('commits one message and frozen run under concurrent identical sends', async () => {
    const f = fixture();
    const replies = await Promise.all([f.apply(f.send), f.apply(f.send)]);
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0].status).toBe('accepted');
    if (replies[0].status !== 'accepted') throw new Error('Send rejected');
    const result = SendResultSchema.parse(replies[0].result);
    expect(result).toMatchObject({
      runId: f.send.commandId,
      context: f.conversation.context,
      limits: { modelInputTokens: 2048, calls: 32, modelCostUsd: 1 },
      model,
    });
    const snapshot = await f.snapshot();
    expect(snapshot?.recentMessages).toMatchObject([
      { id: result.messageId, content: 'hello', role: 'user', runId: result.runId },
    ]);
    expect(snapshot?.queuedRuns).toEqual([
      {
        id: result.runId,
        inputMessageId: result.messageId,
        originClientId: f.client.id,
        conversationId: f.conversation.id,
        modelId: 'test/model',
        variant: 'fixed',
        state: { status: 'queued' },
      },
    ]);
    expect(snapshot?.eventCursor).toBe(2);
    expect(await f.events()).toEqual([
      {
        protocolVersion: 1,
        conversationId: f.conversation.id,
        sequence: 1,
        event: { type: 'message', message: snapshot?.recentMessages[0] },
      },
      {
        protocolVersion: 1,
        conversationId: f.conversation.id,
        sequence: 2,
        event: { type: 'run', run: snapshot?.queuedRuns[0] },
      },
    ]);
    await runInDurableObject(f.stub(), instance => {
      expect(instance.store.getCommand(f.send.commandId)).toMatchObject({
        sequence: 2,
        reply: replies[0],
      });
    });
    for (const changed of [
      { text: 'changed' },
      { modelId: 'another/model' },
      { variant: undefined },
      { permissionRevision: 1 },
    ]) {
      expect(await f.apply({ ...f.send, ...changed })).toMatchObject({
        status: 'rejected',
        error: { code: 'command_conflict', retryable: false },
      });
      expect(await f.snapshot()).toEqual(snapshot);
    }
  });

  it('admits only the winning input when concurrent sends reuse an ID', async () => {
    const f = fixture();
    const commands = [f.send, { ...f.send, text: 'different input' }];
    const replies = await Promise.all(commands.map(command => f.apply(command)));
    const winner = replies.findIndex(reply => reply.status === 'accepted');
    expect(replies.filter(reply => reply.status === 'accepted')).toHaveLength(1);
    expect(replies.find(reply => reply.status === 'rejected')).toMatchObject({
      error: { code: 'command_conflict', retryable: false },
    });
    expect((await f.snapshot())?.recentMessages.map(message => message.content)).toEqual([
      commands[winner].text,
    ]);
    expect((await f.snapshot())?.queuedRuns.map(run => run.id)).toEqual([f.send.commandId]);
    await abortAllDurableObjects();
    expect(await f.apply(commands[winner])).toEqual(replies[winner]);
    expect((await f.events()).map(event => event.sequence)).toEqual([1, 2]);
  });

  it('serializes different IDs at the queue bound and retains the original limit rejection', async () => {
    const f = fixture();
    await f.apply(f.send);
    const active = {
      ...(await f.run())!,
      state: {
        status: 'waiting',
        waiting: { reason: 'question', toolCallId: crypto.randomUUID() },
      },
    } satisfies Run;
    await f.stub().commit({ wakeAt: future() }, [{ type: 'run', run: active }]);
    const commands = Array.from({ length: 33 }, () => ({
      ...f.send,
      commandId: crypto.randomUUID(),
    }));
    const replies = await Promise.all(commands.map(command => f.apply(command)));
    expect(replies.filter(reply => reply.status === 'accepted')).toHaveLength(32);
    const rejectedIndex = replies.findIndex(reply => reply.status === 'rejected');
    expect(replies[rejectedIndex]).toMatchObject({
      error: { code: 'limit_exceeded', retryable: false },
    });
    const snapshot = await f.snapshot();
    expect(snapshot?.activeRun).toEqual(active);
    expect(snapshot?.queuedRuns).toHaveLength(32);
    expect(snapshot?.recentMessages).toHaveLength(33);
    expect(snapshot?.eventCursor).toBe(67);
    const admittedOrder = (await f.events()).flatMap(({ event }) =>
      event.type === 'run' && event.run.id !== active.id ? [event.run.id] : []
    );
    expect(snapshot?.queuedRuns.map(run => run.id)).toEqual(admittedOrder);
    expect(new Set(admittedOrder).size).toBe(32);
    expect(new Set(snapshot?.queuedRuns.map(run => run.inputMessageId)).size).toBe(32);
    await f.apply(f.cancel(snapshot!.queuedRuns[0].id));
    await abortAllDurableObjects();
    expect(await runDurableObjectAlarm(f.stub())).toBe(true);
    expect(await f.run()).toEqual(active);
    expect((await f.snapshot())?.queuedRuns.map(run => run.id)).toEqual(admittedOrder.slice(1));
    expect(await f.apply(commands[rejectedIndex])).toEqual(replies[rejectedIndex]);
    expect(await f.apply({ ...f.send, commandId: crypto.randomUUID() })).toMatchObject({
      status: 'accepted',
    });
    expect((await f.snapshot())?.queuedRuns).toHaveLength(32);
  });

  it('resolves one existing empty thread and replays its original settings after changes', async () => {
    const f = fixture();
    const mobile = { ...f.client, id: crypto.randomUUID(), kind: 'mobile' as const };
    const replies = await Promise.all([
      f.apply(f.open),
      f.apply(
        { ...f.open, clientId: mobile.id, commandId: crypto.randomUUID() },
        {
          authorize: async () => ({ conversation: f.conversation, client: mobile, origin: 'user' }),
        }
      ),
      f.apply(f.open),
    ]);
    for (const reply of replies)
      expect(reply).toMatchObject({
        status: 'accepted',
        result: { conversation: f.conversation },
      });
    expect(replies[0]).toEqual(replies[2]);
    expect(await f.snapshot()).toEqual({
      protocolVersion: 1,
      activeRun: null,
      queuedRuns: [],
      recentMessages: [],
      unresolvedInteractions: [],
      pendingClientActions: [],
      historyCursor: null,
      eventCursor: 2,
      conversation: { ...f.conversation, permissionMode: 'ask', permissionRevision: 0 },
    });
    await runInDurableObject(f.stub(), async (_instance, state) => {
      expect(drizzle(state.storage).select().from(s.conversation).all()).toHaveLength(1);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await f.apply(f.mode());
    await abortAllDurableObjects();
    expect(await f.apply(f.open)).toEqual(replies[0]);
    const before = await f.snapshot();
    expect(before?.conversation).toMatchObject({ permissionMode: 'yolo', permissionRevision: 1 });
    const context = { type: 'organization' as const, organizationId: crypto.randomUUID() };
    expect(
      await f.apply(
        { ...f.open, context },
        {
          authorize: async () => ({
            conversation: { ...f.conversation, context },
            client: f.client,
            origin: 'user',
          }),
        }
      )
    ).toMatchObject({ error: { code: 'command_conflict', retryable: false } });
    expect(await f.snapshot()).toEqual(before);
  });

  it('rejects stale sends and mode changes durably while racing modes increment only once', async () => {
    const f = fixture();
    const changes = [f.mode(), f.mode()];
    const replies = await Promise.all([
      f.apply(changes[0]),
      f.apply(changes[1]),
      f.apply(changes[0]),
    ]);
    expect(replies[0]).toEqual(replies[2]);
    expect(replies.slice(0, 2).filter(reply => reply.status === 'accepted')).toHaveLength(1);
    expect(replies.slice(0, 2).find(reply => reply.status === 'rejected')).toMatchObject({
      error: { code: 'stale_revision', retryable: true },
    });
    expect((await f.snapshot())?.conversation).toMatchObject({
      permissionMode: 'yolo',
      permissionRevision: 1,
    });
    const stale = await f.apply(f.send);
    expect(stale).toMatchObject({ error: { code: 'stale_revision', retryable: true } });
    await f.apply({ ...f.mode(1, 'ask'), acknowledgePendingActions: false });
    await abortAllDurableObjects();
    expect(await f.apply(f.send)).toEqual(stale);
    for (const [index, change] of changes.entries()) {
      expect(await f.apply(change)).toEqual(replies[index]);
      expect(
        await f.apply({ ...change, permissionMode: 'ask', expectedPermissionRevision: 2 })
      ).toMatchObject({
        error: { code: 'command_conflict', retryable: false },
      });
    }
    expect((await f.snapshot())?.queuedRuns).toEqual([]);
    expect((await f.snapshot())?.recentMessages).toEqual([]);
    expect((await f.snapshot())?.conversation).toMatchObject({
      permissionMode: 'ask',
      permissionRevision: 2,
    });
    expect((await f.events()).map(event => event.sequence)).toEqual([1, 2]);
    expect(await f.apply({ ...f.send, permissionRevision: 2 })).toMatchObject({
      error: { code: 'command_conflict' },
    });
    const reviewed = { ...f.send, commandId: crypto.randomUUID(), permissionRevision: 2 };
    expect(await f.apply(reviewed)).toMatchObject({ status: 'accepted' });
    expect((await f.snapshot())?.queuedRuns.map(run => run.id)).toEqual([reviewed.commandId]);
  });

  it('rechecks the revision after awaited model validation', async () => {
    const f = fixture();
    const reply = await f.apply(f.send, {
      validateModel: async () => {
        await f.apply(f.mode());
        return model;
      },
    });
    expect(reply).toMatchObject({ error: { code: 'stale_revision' } });
    expect((await f.snapshot())?.queuedRuns).toEqual([]);
  });

  it.each([
    ['invalid_input', { modelId: 'unavailable' }, { validateModel: async () => null }],
    [
      'invalid_input',
      { variant: 'unpriced' },
      { validateModel: async () => ({ contextTokens: 1000 }) },
    ],
    ['invalid_input', {}, { validateModel: async () => ({ ...model, contextTokens: 0 }) }],
    ['invalid_input', {}, { validateModel: async () => ({ ...model, inputUsdPerMillion: -1 }) }],
    [
      'invalid_input',
      {},
      { validateModel: async () => ({ ...model, outputUsdPerMillion: Infinity }) },
    ],
    ['limit_exceeded', { text: 'é'.repeat(16_385) }, {}],
    ['unsupported_protocol', { protocolVersion: 2 }, {}],
  ] as const)(
    'rejects %s without accepting a message, case %#',
    async (code, changes, override) => {
      const f = fixture();
      const command = { ...f.send, ...changes };
      const reply = await f.apply(command, override);
      expect(reply).toMatchObject({ status: 'rejected', error: { code, retryable: false } });
      const before = await f.snapshot();
      expect(before?.recentMessages ?? []).toEqual([]);
      expect(before?.queuedRuns ?? []).toEqual([]);
      expect(before?.eventCursor ?? 0).toBe(0);
      await abortAllDurableObjects();
      expect(await f.apply(command)).toEqual(reply);
      expect(await f.snapshot()).toEqual(before);
    }
  );

  it.each(['retired', 'access_revoked'] as const)(
    'rejects %s authority lost during model validation before accepting work',
    async code => {
      const f = fixture();
      let revoked = false;
      const error = { code, message: 'Current authority is unavailable.', retryable: false };
      const reply = await f.apply(f.send, {
        authorize: async () =>
          revoked ? { error } : { conversation: f.conversation, client: f.client, origin: 'user' },
        validateModel: async () => {
          revoked = true;
          return model;
        },
      });
      expect(reply).toEqual({ status: 'rejected', commandId: f.send.commandId, error });
      await runInDurableObject(f.stub(), async (instance, state) => {
        expect(instance.store.getCommand(f.send.commandId)).toBeNull();
        expect(instance.store.snapshot()).toMatchObject({
          recentMessages: [],
          queuedRuns: [],
          eventCursor: 0,
        });
        expect(await state.storage.getAlarm()).toBeNull();
      });
    }
  );

  it.each(['authorize', 'validateModel'] as const)(
    'allows the same command to retry after a transient %s failure',
    async method => {
      const f = fixture();
      const reply = await f.apply(f.send, {
        [method]: async () => {
          throw new Error('temporary outage');
        },
      });
      expect(reply).toMatchObject({
        status: 'rejected',
        error: { code: 'storage_unavailable', retryable: true },
      });
      await runInDurableObject(f.stub(), async (instance, state) => {
        expect(instance.store.getCommand(f.send.commandId)).toBeNull();
        expect(instance.store.snapshot()?.queuedRuns ?? []).toEqual([]);
        expect(instance.store.snapshot()?.recentMessages ?? []).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
      });
      await abortAllDurableObjects();
      expect(await f.apply(f.send)).toMatchObject({ status: 'accepted' });
      expect((await f.snapshot())?.queuedRuns).toHaveLength(1);
    }
  );

  it('requires current client authority and a confirmed direct user mode action', async () => {
    const f = fixture(),
      original = await f.apply(f.send);
    const before = await f.snapshot();
    expect(
      await f.apply(f.send, {
        authorize: async () => ({
          conversation: f.conversation,
          client: { ...f.client, revokedAt: '2026-08-28T00:00:00.000Z' },
          origin: 'user',
        }),
      })
    ).toMatchObject({ error: { code: 'access_revoked' } });
    expect(
      await f.apply(f.mode(), {
        authorize: async () => ({
          conversation: f.conversation,
          client: f.client,
          origin: 'agent',
        }),
      })
    ).toMatchObject({ error: { code: 'access_revoked' } });
    expect(await f.apply({ ...f.mode(), acknowledgePendingActions: false })).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(await f.apply({ ...f.send, conversationId: crypto.randomUUID() })).toMatchObject({
      error: { code: 'access_revoked' },
    });
    for (const client of [
      { ...f.client, ownerUserId: 'another-owner' },
      { ...f.client, id: crypto.randomUUID() },
    ]) {
      expect(
        await f.apply(f.send, {
          authorize: async () => ({ conversation: f.conversation, client, origin: 'user' }),
        })
      ).toMatchObject({ status: 'rejected', error: { code: 'access_revoked', retryable: false } });
    }
    expect(
      await f.apply({
        ...f.open,
        context: { type: 'organization', organizationId: crypto.randomUUID() },
      })
    ).toMatchObject({
      status: 'rejected',
      error: { code: 'access_revoked', retryable: false },
    });
    for (const code of ['access_revoked', 'retired'] as const) {
      const error = {
        code,
        message: 'The current primary authority denies access.',
        retryable: false,
      };
      expect(await f.apply(f.send, { authorize: async () => ({ error }) })).toEqual({
        status: 'rejected',
        commandId: f.send.commandId,
        error,
      });
    }
    expect(await f.apply(f.send)).toEqual(original);
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(['approval', 'question', 'client', 'reconciliation'] as const)(
    'preserves immutable calls and the %s gate on mode changes',
    async reason => {
      const f = fixture();
      await f.apply(f.send);
      const call = ToolCallSchema.parse({
        id: crypto.randomUUID(),
        runId: f.send.commandId,
        name: reason === 'question' ? 'test.question' : 'app.notifications',
        definitionVersion: '1',
        arguments: { enabled: true },
        context: f.conversation.context,
        effect: 'side_effect',
        executionTarget:
          reason === 'question'
            ? { kind: 'interaction' }
            : { kind: 'client', clientId: f.client.id },
        approval: null,
        state: 'waiting',
        result: null,
      });
      const action = {
        toolCall: call,
        grant: null,
        reason: reason === 'client' ? ('gesture' as const) : ('locked' as const),
      };
      const stored = await runInDurableObject(f.stub(), async instance => {
        const run = instance.store.queuedRuns()[0].data;
        await instance.store.transition({ wakeAt: future() }, db => {
          const checkpointId = crypto.randomUUID();
          insertCheckpoint(db, {
            id: checkpointId,
            runId: run.id,
            step: 0,
            status: 'complete',
            data: {},
            definitionVersions: { [call.name]: '1' },
          });
          insertCall(db, call, {
            checkpointId,
            inputDigest: 'fixed',
            position: 0,
            policy: { permissionRevision: 0 },
          });
          return {
            events: [
              {
                type: 'run',
                run: {
                  ...run,
                  state: { status: 'waiting', waiting: { toolCallId: call.id, reason } },
                },
              },
              ...(reason === 'question'
                ? []
                : [{ type: 'client_action' as const, toolCallId: call.id, action }]),
            ],
          };
        });
        return instance.store.callsForRun(call.runId);
      });
      const later = { ...f.send, commandId: crypto.randomUUID() };
      expect(await f.apply(later)).toMatchObject({ status: 'accepted' });
      expect(await runDurableObjectAlarm(f.stub())).toBe(true);
      expect(await f.apply(f.mode())).toMatchObject({ status: 'accepted' });
      await abortAllDurableObjects();
      await runInDurableObject(f.stub(), async (instance, state) => {
        const calls = instance.store.callsForRun(call.runId);
        const snapshot = instance.store.snapshot()!;
        expect(calls).toEqual(stored);
        expect(snapshot.activeRun?.state).toEqual(
          reason === 'approval'
            ? { status: 'running' }
            : { status: 'waiting', waiting: { reason, toolCallId: call.id } }
        );
        expect(snapshot.queuedRuns.map(run => run.id)).toEqual([later.commandId]);
        expect(snapshot.pendingClientActions).toEqual(reason === 'question' ? [] : [action]);
        const policy = {
          permissionMode: snapshot.conversation.permissionMode,
          permissionRevision: snapshot.conversation.permissionRevision,
          expectedPermissionRevision: 1,
          authorized: true,
          available: true,
          clientReady: false,
          questionAnswered: false,
          trustedRead: false,
        };
        expect(evaluateDispatch(calls[0].data, calls[0].data, policy)).toBe(
          reason === 'question' ? 'question' : 'client'
        );
        expect(
          evaluateDispatch(calls[0].data, calls[0].data, { ...policy, authorized: false })
        ).toBe('access_revoked');
        expect(await state.storage.getAlarm()).not.toBeNull();
      });
    }
  );

  it('gates undispatched effects after YOLO-to-Ask without changing approvals or current effects', async () => {
    const f = fixture();
    await f.apply(f.mode());
    await f.apply({ ...f.send, permissionRevision: 1 });
    const run = (await f.run())!;
    const pending = ToolCallSchema.parse({
      id: crypto.randomUUID(),
      runId: run.id,
      name: 'kilo.invite',
      definitionVersion: '1',
      arguments: { recipient: 'member@example.com', role: 'member' },
      context: f.conversation.context,
      effect: 'side_effect',
      executionTarget: { kind: 'backend' },
      approval: null,
      state: 'pending',
      result: null,
    });
    const calls: ToolCall[] = [
      pending,
      {
        ...pending,
        id: crypto.randomUUID(),
        approval: {
          interactionId: crypto.randomUUID(),
          commandId: crypto.randomUUID(),
          decision: 'approve',
        },
      },
      { ...pending, id: crypto.randomUUID(), state: 'executing' },
      {
        ...pending,
        id: crypto.randomUUID(),
        state: 'settled',
        result: { status: 'succeeded', output: { invitationId: crypto.randomUUID() } },
      },
    ];
    const stored = await runInDurableObject(f.stub(), async instance => {
      await instance.store.transition({ wakeAt: future() }, db => {
        const checkpointId = crypto.randomUUID();
        insertCheckpoint(db, {
          id: checkpointId,
          runId: run.id,
          step: 0,
          status: 'complete',
          data: {},
          definitionVersions: { 'kilo.invite': '1' },
        });
        for (const [position, call] of calls.entries()) {
          insertCall(
            db,
            { ...call, state: 'pending', result: null },
            { checkpointId, inputDigest: 'fixed', position, policy: { permissionRevision: 1 } }
          );
          if (call.state === 'executing')
            insertAttempt(db, { id: crypto.randomUUID(), toolCallId: call.id, generation: 0 });
          if (call.state !== 'pending')
            compareAndSetCall(db, call.id, 0, {
              state: call.state,
              result: call.result,
              approval: call.approval,
            });
        }
        return { events: [{ type: 'run', run: { ...run, state: { status: 'running' } } }] };
      });
      return instance.store.callsForRun(run.id);
    });
    expect(await f.apply({ ...f.mode(1, 'ask'), acknowledgePendingActions: false })).toMatchObject({
      status: 'accepted',
    });
    await abortAllDurableObjects();
    await runInDurableObject(f.stub(), instance => {
      const after = instance.store.callsForRun(run.id);
      expect(after).toEqual(stored);
      const conversation = instance.store.snapshot()!.conversation;
      expect(conversation).toMatchObject({ permissionMode: 'ask', permissionRevision: 2 });
      expect(
        after.map(call =>
          evaluateDispatch(call.data, call.data, {
            permissionMode: conversation.permissionMode,
            permissionRevision: conversation.permissionRevision,
            expectedPermissionRevision: 2,
            authorized: true,
            available: true,
            clientReady: true,
            questionAnswered: true,
            trustedRead: false,
          })
        )
      ).toEqual(['approval', 'dispatch', 'already_dispatched', 'already_dispatched']);
      expect(instance.store.snapshot()?.activeRun).toEqual({
        ...run,
        state: { status: 'running' },
      });
    });
  });

  it.each([
    'queued',
    'running',
    'waiting',
    'stopping',
    'completed',
    'cancelled',
    'failed',
  ] as const)(
    'cancels only the named %s run and keeps the original command result',
    async status => {
      const f = fixture();
      await f.apply(f.send);
      const run = (await f.snapshot())!.queuedRuns[0];
      const state: Run['state'] =
        status === 'waiting'
          ? { status, waiting: { reason: 'reconciliation', toolCallId: crypto.randomUUID() } }
          : status === 'failed'
            ? { status, error: { code: 'invalid_output', message: 'bad output', retryable: false } }
            : { status };
      await runInDurableObject(f.stub(), instance =>
        instance.store.transition({ wakeAt: f.adapter.now!() }, () => ({
          events: [{ type: 'run', run: { ...run, state } }],
        }))
      );
      const unrelated = { ...f.send, commandId: crypto.randomUUID() };
      await f.apply(unrelated);
      const cancel = f.cancel(run.id),
        before = await f.snapshot(),
        reply = await f.apply(cancel);
      const expected =
        status === 'queued'
          ? { status: 'cancelled' }
          : ['running', 'waiting'].includes(status)
            ? { status: 'stopping' }
            : state;
      expect(reply).toMatchObject({
        status: 'accepted',
        result: { runId: run.id, state: expected },
      });
      expect(await f.run()).toEqual({ ...run, state: expected });
      const after = await f.snapshot();
      expect(after?.queuedRuns).toEqual(before?.queuedRuns.filter(queued => queued.id !== run.id));
      expect(after?.queuedRuns.map(queued => queued.id)).toEqual([unrelated.commandId]);
      expect(after?.recentMessages).toEqual(before?.recentMessages);
      expect(after?.eventCursor).toBe(
        before!.eventCursor + (['queued', 'running', 'waiting'].includes(status) ? 1 : 0)
      );
      expect(await f.apply({ ...cancel, runId: unrelated.commandId })).toMatchObject({
        error: { code: 'command_conflict', retryable: false },
      });
      expect(await f.snapshot()).toEqual(after);
      if (expected.status === 'stopping')
        await runInDurableObject(f.stub(), instance =>
          instance.store.transition({ wakeAt: future() }, () => ({
            events: [{ type: 'run', run: { ...run, state: { status: 'completed' } } }],
          }))
        );
      await abortAllDurableObjects();
      expect(await f.apply(cancel)).toEqual(reply);
    }
  );

  it('retains a missing-run rejection when a later send creates that run', async () => {
    const f = fixture();
    const cancel = f.cancel(f.send.commandId);
    const reply = await f.apply(cancel);
    expect(reply).toMatchObject({
      status: 'rejected',
      error: { code: 'invalid_input', retryable: false },
    });
    await f.apply(f.send);
    const before = await f.snapshot();
    await abortAllDurableObjects();
    expect(await f.apply(cancel)).toEqual(reply);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.run())?.state).toEqual({ status: 'queued' });
  });

  it.each([
    { status: 'succeeded', output: { invitationId: 'stored-invitation' } },
    {
      status: 'outcome_unknown',
      reason: 'Lost provider response',
      providerReference: 'operation-1',
    },
  ] as const)(
    'preserves the actual $status effect after Stop and leaves other queued work',
    async outcome => {
      const f = fixture();
      await f.apply(f.send);
      const run = (await f.run())!;
      const call = ToolCallSchema.parse({
        id: crypto.randomUUID(),
        runId: run.id,
        name: 'kilo.invite',
        definitionVersion: '1',
        arguments: { recipient: 'member@example.com' },
        context: f.conversation.context,
        effect: 'side_effect',
        executionTarget: { kind: 'backend' },
        state: 'pending',
        approval: null,
        result: null,
      });
      await runInDurableObject(f.stub(), instance =>
        instance.store.transition({ wakeAt: future() }, db => {
          const checkpointId = crypto.randomUUID();
          insertCheckpoint(db, {
            id: checkpointId,
            runId: run.id,
            step: 0,
            status: 'complete',
            data: {},
            definitionVersions: { 'kilo.invite': '1' },
          });
          insertCall(db, call, {
            checkpointId,
            inputDigest: 'fixed',
            position: 0,
            policy: { permissionRevision: 0 },
          });
          insertAttempt(db, { id: crypto.randomUUID(), toolCallId: call.id, generation: 0 });
          compareAndSetCall(db, call.id, 0, { state: 'executing', approval: null, result: null });
          return { events: [{ type: 'run', run: { ...run, state: { status: 'running' } } }] };
        })
      );
      const unrelated = { ...f.send, commandId: crypto.randomUUID() };
      await f.apply(unrelated);
      const cancel = f.cancel(run.id);
      const reply = await f.apply(cancel);
      expect(reply).toMatchObject({
        status: 'accepted',
        result: { state: { status: 'stopping' } },
      });
      await runInDurableObject(f.stub(), instance =>
        instance.store.transition({ wakeAt: future() }, db => {
          compareAndSetCall(db, call.id, 1, { state: 'settled', approval: null, result: outcome });
          return { events: [] };
        })
      );
      await abortAllDurableObjects();
      expect(await f.apply(cancel)).toEqual(reply);
      await runInDurableObject(f.stub(), instance => {
        expect(instance.store.callsForRun(run.id)[0].data).toEqual({
          ...call,
          state: 'settled',
          result: outcome,
        });
        expect(instance.store.snapshot()?.queuedRuns.map(queued => queued.id)).toEqual([
          unrelated.commandId,
        ]);
        expect(instance.store.snapshot()?.recentMessages).toHaveLength(2);
      });
    }
  );

  it.each([false, true])(
    'leaves no accepted work when prearming fails afterArm=%s',
    async afterArm => {
      const f = fixture();
      await runInDurableObject(f.stub(), async (instance, state) => {
        const store = await openStore(state, {
          getAlarm: () => state.storage.getAlarm(),
          setAlarm: async deadline => {
            if (afterArm) await state.storage.setAlarm(deadline);
            throw new Error('arm failure');
          },
        });
        expect(await admitCommand(state, store, f.send, f.adapter)).toMatchObject({
          error: { code: 'storage_unavailable', retryable: true },
        });
        expect(instance.store.getCommand(f.send.commandId)).toBeNull();
        expect(instance.store.snapshot()?.queuedRuns).toEqual([]);
      });
      await abortAllDurableObjects();
      expect(await runDurableObjectAlarm(f.stub())).toBe(afterArm);
      expect((await f.snapshot())?.recentMessages).toEqual([]);
      expect(await f.apply(f.send)).toMatchObject({ status: 'accepted' });
    }
  );

  it.each([false, true])(
    'resumes committed work across restart with acknowledgmentLost=%s',
    async acknowledgmentLost => {
      const f = fixture();
      const submission = runInDurableObject(f.stub(), async (instance, state) => {
        const reply = await admitCommand(state, instance.store, f.send, f.adapter);
        if (acknowledgmentLost) throw new Error('lost acknowledgment');
        return reply;
      });
      if (acknowledgmentLost) await expect(submission).rejects.toThrow('lost acknowledgment');
      else expect(await submission).toMatchObject({ status: 'accepted' });
      const original = await runInDurableObject(
        f.stub(),
        instance => instance.store.getCommand(f.send.commandId)?.reply
      );
      await abortAllDurableObjects();
      expect(await runDurableObjectAlarm(f.stub())).toBe(true);
      expect(
        await f.apply(f.send, { validateModel: async () => null, limits: { calls: 1 } })
      ).toEqual(original);
      const snapshot = await f.snapshot();
      expect(snapshot).toMatchObject({ queuedRuns: [], activeRun: null, eventCursor: 3 });
      expect(snapshot?.recentMessages).toHaveLength(1);
      expect(await f.run()).toEqual({
        id: f.send.commandId,
        inputMessageId: snapshot?.recentMessages[0].id,
        originClientId: f.client.id,
        conversationId: f.conversation.id,
        modelId: f.send.modelId,
        variant: f.send.variant,
        state: { status: 'completed' },
      });
      expect((await f.events()).at(-1)).toMatchObject({
        sequence: 3,
        event: { type: 'run', run: { id: f.send.commandId, state: { status: 'completed' } } },
      });
      await runInDurableObject(f.stub(), instance => {
        instance.store.compactEvents();
      });
      await abortAllDurableObjects();
      expect(await f.apply(f.send)).toEqual(original);
      expect((await f.snapshot())?.eventCursor).toBe(3);
    }
  );

  it('accepts the UTF-8 message boundary without a variant and clamps a large model context', async () => {
    const f = fixture();
    const command = { ...f.send, text: 'é'.repeat(16_384), variant: undefined };
    const reply = await f.apply(command, {
      validateModel: async () => ({ ...model, contextTokens: 64_000 }),
    });
    expect(reply).toMatchObject({
      status: 'accepted',
      result: { limits: { modelInputTokens: 32_000 } },
    });
    expect((await f.snapshot())?.recentMessages.map(message => message.content)).toEqual([
      command.text,
    ]);
    expect(await f.run()).toEqual({
      id: command.commandId,
      inputMessageId: (await f.snapshot())?.recentMessages[0].id,
      originClientId: f.client.id,
      conversationId: f.conversation.id,
      modelId: command.modelId,
      state: { status: 'queued' },
    });
  });

  it('persists lower limits and frozen organization inputs without revalidating a replay', async () => {
    const f = fixture({ type: 'organization', organizationId: crypto.randomUUID() });
    const limits = {
      messageBytes: 4,
      pendingMessages: 1,
      calls: 2,
      modelSteps: 3,
      modelInputTokens: 1000,
      modelOutputTokens: 500,
      toolInputBytes: 1024,
      toolOutputBytes: 2048,
      httpResponseBytes: 4096,
      modelAttemptMs: 1000,
      toolAttemptMs: 500,
      activeRunMs: 10_000,
      webRequests: 2,
      searchResults: 3,
      snippetCharacters: 100,
      pageBytes: 512,
      modelCostUsd: 0.25,
    } satisfies NonNullable<CommandAdapter['limits']>;
    const command = { ...f.send, text: 'éé' };
    const reply = await f.apply(command, { limits });
    expect(reply).toMatchObject({
      status: 'accepted',
      result: { context: f.conversation.context, limits, model },
    });
    const admitted = await f.run();
    expect(
      await f.apply({ ...command, commandId: crypto.randomUUID(), text: 'a' }, { limits })
    ).toMatchObject({
      error: { code: 'limit_exceeded', retryable: false },
    });
    await f.apply(f.cancel(command.commandId));
    expect(
      await f.apply({ ...command, commandId: crypto.randomUUID(), text: 'ééx' }, { limits })
    ).toMatchObject({
      error: { code: 'limit_exceeded', retryable: false },
    });
    await f.apply(f.mode());
    await abortAllDurableObjects();
    expect(
      await f.apply(command, {
        limits: { calls: 1 },
        validateModel: async () => {
          throw new Error('A replay must not validate the model again');
        },
      })
    ).toEqual(reply);
    expect(await f.run()).toEqual({ ...admitted, state: { status: 'cancelled' } });
    await runInDurableObject(f.stub(), instance => {
      expect(instance.store.getCommand(command.commandId)?.reply).toEqual(reply);
      expect(instance.store.snapshot()?.recentMessages.map(message => message.content)).toEqual([
        'éé',
      ]);
    });
  });

  it('keeps an event-size rejection canonical after mode changes and restart', async () => {
    const f = fixture();
    // JSON escaping exceeds the event bound even though the input is below 32 KiB.
    const command = { ...f.send, text: '\0'.repeat(24 * 1024) };
    const reply = await f.apply(command);
    expect(reply).toMatchObject({
      status: 'rejected',
      error: { code: 'limit_exceeded', retryable: false },
    });
    expect(await f.snapshot()).toMatchObject({
      recentMessages: [],
      queuedRuns: [],
      eventCursor: 0,
    });
    await f.apply(f.mode());
    await abortAllDurableObjects();
    expect(await f.apply(command)).toEqual(reply);
    expect(await f.apply({ ...command, text: 'short' })).toMatchObject({
      error: { code: 'command_conflict', retryable: false },
    });
    expect(await f.snapshot()).toMatchObject({
      recentMessages: [],
      queuedRuns: [],
      eventCursor: 1,
    });
    await runInDurableObject(f.stub(), instance => {
      expect(instance.store.getCommand(command.commandId)?.reply).toEqual(reply);
    });
  });

  it('prearms admission and keeps the earliest wake across concurrent commands', async () => {
    const f = fixture();
    const earliest = future();
    await runInDurableObject(f.stub(), async (instance, state) => {
      const store = await openStore(state, {
        getAlarm: () => state.storage.getAlarm(),
        setAlarm: async deadline => {
          expect(instance.store.getCommand(f.send.commandId)).toBeNull();
          expect(instance.store.snapshot()).toMatchObject({
            queuedRuns: [],
            recentMessages: [],
            eventCursor: 0,
          });
          await state.storage.setAlarm(deadline);
        },
      });
      expect(
        await admitCommand(state, store, f.send, { ...f.adapter, now: () => earliest + 2000 })
      ).toMatchObject({ status: 'accepted' });
    });
    const replies = await Promise.all(
      [earliest, earliest + 1000].map(deadline =>
        f.apply({ ...f.send, commandId: crypto.randomUUID() }, { now: () => deadline })
      )
    );
    expect(replies.every(reply => reply.status === 'accepted')).toBe(true);
    await abortAllDurableObjects();
    await runInDurableObject(f.stub(), async (instance, state) => {
      expect(await state.storage.getAlarm()).toBe(earliest);
      expect(instance.store.snapshot()).toMatchObject({ eventCursor: 6, activeRun: null });
      expect(instance.store.snapshot()?.queuedRuns).toHaveLength(3);
    });
  });

  it('rolls back the message, run, events, and original reply after a late journal failure', async () => {
    const f = fixture();
    await runInDurableObject(f.stub(), async (instance, state) => {
      const store = {
        ...instance.store,
        transition: (options, write) =>
          instance.store.transition(options, db => {
            const changes = write(db);
            // Force the final journal insert to fail after both admission events are written.
            db.insert(s.commands)
              .values({
                id: f.send.commandId,
                fingerprint: 'injected conflict',
                reply: changes.reply,
                sequence: 0,
              })
              .run();
            return changes;
          }),
      } satisfies typeof instance.store;
      expect(await admitCommand(state, store, f.send, f.adapter)).toMatchObject({
        error: { code: 'storage_unavailable', retryable: true },
      });
      expect(instance.store.getCommand(f.send.commandId)).toBeNull();
      expect(instance.store.snapshot()).toMatchObject({
        queuedRuns: [],
        recentMessages: [],
        eventCursor: 0,
      });
      const db = drizzle(state.storage);
      expect(db.select().from(s.commands).all()).toEqual([]);
      expect(db.select().from(s.runs).all()).toEqual([]);
      expect(db.select().from(s.messages).all()).toEqual([]);
      expect(db.select().from(s.events).all()).toEqual([]);
    });
    await abortAllDurableObjects();
    expect(await runDurableObjectAlarm(f.stub())).toBe(true);
    expect(await f.run()).toBeNull();
    expect(await f.apply(f.send)).toMatchObject({ status: 'accepted' });
    expect((await f.events()).map(event => event.sequence)).toEqual([1, 2]);
  });
});
