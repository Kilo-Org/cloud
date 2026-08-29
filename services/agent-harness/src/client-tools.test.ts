import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalizeValidatedInput, type Command } from '@kilocode/agent-harness/commands';
import {
  ConversationSchema,
  ExecutionGrantSchema,
  RunSchema,
  ToolCallSchema,
  type Client,
  type ToolOutcome,
} from '@kilocode/agent-harness/contracts';
import type { BridgeReadiness } from '@kilocode/agent-harness/bridge';
import { createHarnessClient } from '@kilocode/agent-harness/client';
import {
  JournalSnapshotSchema,
  completionCommand,
  type CommandReply,
  type HarnessJournal,
  type JournalSnapshot,
} from '@kilocode/agent-harness/journal';
import { toolDefinitions, type ToolName } from '@kilocode/agent-harness/tools';
import { admitCommand, type CommandAdapter } from './commands';
import { createScheduler, SchedulerStateSchema, type SchedulerAdapter } from './scheduler';
import type { ClientToolAuthorizer, ClientToolCommand } from './client-tools';
import { insertCall, insertCheckpoint } from './db/records';
import { openStore, type ConversationStore } from './db/store';
import { getTestStoreStub, type TestStore } from './db/test-worker';
import { StoreError } from './db/wake';
import * as s from './db/sqlite-schema';

const bindings = env as { STORE: DurableObjectNamespace<TestStore> };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ready: BridgeReadiness = {
  available: true,
  foreground: true,
  connectivity: 'confirmed',
  unlock: 'ready',
  gesture: 'not_required',
};
const receipt: ToolOutcome = { status: 'succeeded', output: { permission: 'denied' } };
const grantReply = (reply: CommandReply) => {
  if (reply.status !== 'accepted') throw new Error(JSON.stringify(reply));
  return z.object({ grant: ExecutionGrantSchema, toolCall: ToolCallSchema }).parse(reply.result);
};
function ledger(state: DurableObjectState, runId: string) {
  return SchedulerStateSchema.parse(
    drizzle(state.storage)
      .select()
      .from(s.checkpoints)
      .all()
      .find(row => row.runId === runId && row.step === 0)?.data
  );
}
function deferred() {
  let resolve: () => void = () => {
    throw new Error('Missing resolver');
  };
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  names: ToolName[] = ['app.notifications'],
  limits?: CommandAdapter['limits']
) {
  const conversation = ConversationSchema.parse({
    id: crypto.randomUUID(),
    ownerUserId: 'auth0|owner',
    context: { type: 'personal' },
    permissionMode: 'yolo',
  });
  const phone: Client = {
    id: crypto.randomUUID(),
    ownerUserId: conversation.ownerUserId,
    kind: 'mobile',
    supportedTools: toolDefinitions
      .filter(tool => tool.executorKind === 'client')
      .map(tool => ({ name: tool.name, version: tool.version })),
    revokedAt: null,
  };
  const web: Client = { ...phone, id: crypto.randomUUID(), kind: 'browser' };
  const base = { protocolVersion: 1 as const, conversationId: conversation.id, clientId: phone.id };
  const f = {
    registration: phone,
    readiness: { ...ready },
    storageReady: true,
    authorized: true,
    clock: Date.now() + 3_600_000,
    executions: [] as string[],
  };
  const now = () => f.clock;
  const stub = () => getTestStoreStub(bindings.STORE, conversation.id);
  const use = <T>(work: (store: ConversationStore, state: DurableObjectState) => T | Promise<T>) =>
    runInDurableObject(stub(), (instance, state) => work(instance.store, state));
  const authority: ClientToolAuthorizer = async command => ({
    conversation,
    client: command.clientId === web.id ? web : f.registration,
    readiness: f.readiness,
    storageReady: f.storageReady,
  });
  const commandAdapter: CommandAdapter = {
    limits,
    authorize: async () => ({ conversation, client: phone, origin: 'user' }),
    validateModel: async () => ({
      contextTokens: 32000,
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.2,
    }),
    now,
  };
  const model = new MockLanguageModelV3({
    modelId: 'test/model',
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'text' });
          controller.enqueue({ type: 'text-delta', id: 'text', delta: 'done' });
          controller.enqueue({ type: 'text-end', id: 'text' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
  const adapter: SchedulerAdapter = {
    definitions: toolDefinitions,
    model: () => model,
    countTokens: () => 10,
    system: 'Untrusted tool data.',
    now,
    authorize: async () => undefined,
    policy: async current => ({
      permissionMode: current.permissionMode,
      permissionRevision: current.permissionRevision,
      expectedPermissionRevision: current.permissionRevision,
      authorized: f.authorized,
      available: true,
      trustedRead: true,
      clientReady: true,
      questionAnswered: true,
    }),
    dispatch: async ({ call }) => {
      f.executions.push(call.id);
      return { status: 'succeeded', output: [] };
    },
  };
  const send = () =>
    use(async (store, state) => {
      const commandId = crypto.randomUUID();
      expect(
        await admitCommand(
          state,
          store,
          {
            ...base,
            type: 'sendMessage',
            commandId,
            text: 'hello',
            modelId: 'test/model',
            permissionRevision: store.snapshot()!.conversation.permissionRevision,
          },
          commandAdapter
        )
      ).toMatchObject({ status: 'accepted' });
      return commandId;
    });
  await use(store => store.bindExistingConversation(conversation));
  const runId = await send();
  const calls = await use(async store => {
    const run = store.queuedRuns()[0].data;
    const calls = names.map(name => {
      const definition = toolDefinitions.find(tool => tool.name === name)!;
      const input =
        name === 'app.openScreen'
          ? { screen: 'preferences' }
          : name === 'app.setPreference'
            ? { name: 'showToolDetails', value: true }
            : {};
      return ToolCallSchema.parse({
        id: crypto.randomUUID(),
        runId,
        name,
        definitionVersion: definition.version,
        arguments: input,
        context: conversation.context,
        effect: definition.effect,
        executionTarget: {
          kind: definition.executorKind,
          ...(definition.executorKind === 'client' ? { clientId: phone.id } : {}),
        },
        approval: null,
        state: 'pending',
        result: null,
      });
    });
    await store.transition({ wakeAt: now() }, db => {
      const checkpointId = crypto.randomUUID();
      insertCheckpoint(db, {
        id: checkpointId,
        runId,
        step: 1,
        status: 'complete',
        definitionVersions: Object.fromEntries(
          calls.map(call => [call.name, call.definitionVersion])
        ),
        data: {
          kind: 'complete',
          attemptId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          createdAt: new Date(now()).toISOString(),
          text: '',
          finishReason: 'tool-calls',
          citations: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: calls.map((call, index) => ({ sdkId: `sdk-${index}`, call })),
          responseMessages: [
            {
              role: 'assistant',
              content: calls.map((call, index) => ({
                type: 'tool-call',
                toolCallId: `sdk-${index}`,
                toolName: call.name,
                input: call.arguments,
              })),
            },
          ],
        },
      });
      calls.forEach((call, position) =>
        insertCall(db, call, {
          checkpointId,
          position,
          inputDigest: digest(canonicalizeValidatedInput(call.arguments)),
          policy: {},
        })
      );
      return { events: [{ type: 'run', run: { ...run, state: { status: 'running' } } }] };
    });
    return calls;
  });
  const scheduler = (store: ConversationStore, state: DurableObjectState) =>
    createScheduler(state, store, adapter);
  const alarm = () =>
    use(async (store, state) => {
      await state.storage.deleteAlarm();
      await scheduler(store, state).alarm();
    });
  const claim = (clientId = phone.id, toolCallId = calls[0].id): ClientToolCommand => ({
    ...base,
    type: 'claimClientTool',
    commandId: crypto.randomUUID(),
    clientId,
    toolCallId,
  });
  const perform = (command: unknown) =>
    use((store, state) => scheduler(store, state).clientTool(command, authority));
  const complete = (request: ReturnType<typeof grantReply>, result = receipt): ClientToolCommand =>
    completionCommand({
      ...request,
      completionCommandId: crypto.randomUUID(),
      receipt: result,
    }) as ClientToolCommand;
  const cancel = (id = runId) => ({
    ...base,
    type: 'cancelRun',
    runId: id,
    commandId: crypto.randomUUID(),
  });
  const setMode = (mode: 'ask' | 'yolo') =>
    use((store, state) =>
      admitCommand(
        state,
        store,
        {
          ...base,
          type: 'setPermissionMode',
          commandId: crypto.randomUUID(),
          permissionMode: mode,
          expectedPermissionRevision: store.snapshot()!.conversation.permissionRevision,
          acknowledgePendingActions: true,
        },
        commandAdapter
      )
    );
  await alarm();
  return Object.assign(f, {
    base,
    conversation,
    phone,
    web,
    calls,
    runId,
    adapter,
    commandAdapter,
    authority,
    use,
    now,
    stub,
    scheduler,
    send,
    alarm,
    claim,
    perform,
    complete,
    cancel,
    setMode,
  });
}

describe('designated client grants on real SQLite', () => {
  it.each(['authorization', 'policy', 'final-authority'] as const)(
    'charges delayed %s checks before refusing an over-budget grant',
    async boundary => {
      const f = await fixture(undefined, { activeRunMs: 10 });
      await f.use(async (store, state) => {
        let reads = 0;
        const runtime = createScheduler(state, store, {
          ...f.adapter,
          authorize: async (...args) => {
            await f.adapter.authorize(...args);
            if (boundary === 'authorization') f.clock += 100;
          },
          policy: async (...args) => {
            const result = await f.adapter.policy(...args);
            if (boundary === 'policy') f.clock += 100;
            return result;
          },
        });
        expect(
          await runtime.clientTool(f.claim(), async command => {
            const result = await f.authority(command);
            if (++reads === 2 && boundary === 'final-authority') f.clock += 100;
            return result;
          })
        ).toMatchObject({ status: 'rejected', error: { code: 'limit_exceeded' } });
        expect(ledger(state, f.runId).reservations.at(-1)).toMatchObject({
          status: 'released',
          activeMs: 10,
        });
        expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([]);
        expect(drizzle(state.storage).select().from(s.attempts).all()).toEqual([]);
      });
      expect(await f.perform(f.claim())).toMatchObject({
        status: 'rejected',
        error: { code: 'limit_exceeded' },
      });
    }
  );

  it('charges failed checks and retains the original deadline for a later successful claim', async () => {
    const f = await fixture(undefined, { activeRunMs: 20, toolAttemptMs: 10 });
    await f.use(async (store, state) => {
      const failed = createScheduler(state, store, {
        ...f.adapter,
        policy: async () => {
          f.clock += 6;
          throw new StoreError('storage_unavailable', true);
        },
      });
      expect(await failed.clientTool(f.claim(), f.authority)).toMatchObject({ status: 'rejected' });
      expect(ledger(state, f.runId).reservations.at(-1)).toMatchObject({
        status: 'released',
        activeMs: 6,
      });
      const started = f.now();
      const runtime = createScheduler(state, store, {
        ...f.adapter,
        policy: async (...args) => {
          f.clock += 4;
          return f.adapter.policy(...args);
        },
      });
      const request = grantReply(await runtime.clientTool(f.claim(), f.authority));
      expect(Date.parse(request.grant.expiresAt)).toBe(started + 10);
      expect(Date.parse(request.grant.expiresAt) - f.now()).toBe(6);
      f.clock += 2;
      expect(await runtime.clientTool(f.complete(request), f.authority)).toMatchObject({
        status: 'accepted',
      });
      expect(ledger(state, f.runId).reservations.at(-1)).toMatchObject({
        status: 'finished',
        activeMs: 6,
      });
    });
  });

  it('keeps lost preparation time reserved across restart without granting an effect', async () => {
    const f = await fixture(undefined, { activeRunMs: 10 });
    await f.use(async (store, state) => {
      let persisted = false;
      const lost: ConversationStore = {
        ...store,
        transition: async (...args) => {
          if (persisted) throw new StoreError('storage_unavailable', true);
          await store.transition(...args);
          persisted = true;
          throw new StoreError('storage_unavailable', true);
        },
      };
      expect(await f.scheduler(lost, state).clientTool(f.claim(), f.authority)).toMatchObject({
        status: 'rejected',
        error: { code: 'storage_unavailable' },
      });
      expect(ledger(state, f.runId).reservations.at(-1)).toMatchObject({
        status: 'reserved',
        activeMs: 10,
      });
    });
    await abortAllDurableObjects();
    f.clock += 100;
    await f.alarm();
    expect(await f.perform(f.claim())).toMatchObject({
      status: 'rejected',
      error: { code: 'limit_exceeded' },
    });
    await f.use((_store, state) => {
      expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([]);
      expect(drizzle(state.storage).select().from(s.attempts).all()).toEqual([]);
      expect(ledger(state, f.runId).reservations.at(-1)?.activeMs).toBe(10);
    });
  });

  it('does not charge time between genuine device waits', async () => {
    const f = await fixture(undefined, { activeRunMs: 10 });
    f.readiness = { ...ready, unlock: 'locked' };
    expect(await f.perform(f.claim())).toMatchObject({
      status: 'accepted',
      result: { grant: null },
    });
    f.clock += 100000;
    f.readiness = { ...ready };
    const request = grantReply(await f.perform(f.claim()));
    expect(Date.parse(request.grant.expiresAt) - f.now()).toBe(10);
  });

  it.each(['policy failure', 'budget exhaustion', 'successful checks'] as const)(
    'replays a lost wait acknowledgment during %s without another reservation',
    async scenario => {
      const f = await fixture(['app.notifications', 'app.openSettings'], { activeRunMs: 20 });
      f.readiness = { ...ready, unlock: 'locked' };
      const command = f.claim();
      const committed = await f.use(async (store, state) => {
        const lost: ConversationStore = {
          ...store,
          transition: async (...args) => {
            const reply = await store.transition(...args);
            if (args[0].command?.id === command.commandId)
              throw new StoreError('storage_unavailable', true);
            return reply;
          },
        };
        expect(await f.scheduler(lost, state).clientTool(command, f.authority)).toMatchObject({
          status: 'rejected',
          error: { code: 'storage_unavailable' },
        });
        const saved = store.getCommand(command.commandId);
        expect(saved?.reply).toMatchObject({
          status: 'accepted',
          result: { grant: null, decision: 'client' },
        });
        return saved;
      });
      await abortAllDurableObjects();
      f.clock += 1000;
      f.readiness = { ...ready };
      const policy = f.adapter.policy;
      f.adapter.policy = async (...args) => {
        f.clock += scenario === 'budget exhaustion' ? 20 : 4;
        if (scenario === 'policy failure') throw new StoreError('storage_unavailable', true);
        return policy(...args);
      };
      if (scenario === 'budget exhaustion')
        expect(await f.perform(f.claim())).toMatchObject({
          status: 'rejected',
          error: { code: 'limit_exceeded' },
        });
      const before = await f.use((store, state) => ({
        snapshot: store.snapshot(),
        budget: ledger(state, f.runId),
      }));
      expect(await f.perform(command)).toEqual(committed?.reply);
      expect(await f.perform(command)).toEqual(committed?.reply);
      await f.use((store, state) => {
        expect(store.getCommand(command.commandId)).toEqual(committed);
        expect(store.snapshot()).toEqual(before.snapshot);
        expect(ledger(state, f.runId)).toEqual(before.budget);
        expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([]);
        expect(drizzle(state.storage).select().from(s.attempts).all()).toEqual([]);
      });
      expect(await f.perform({ ...command, toolCallId: f.calls[1].id })).toMatchObject({
        status: 'rejected',
        error: { code: 'command_conflict', retryable: false },
      });
    }
  );

  it.each(['storage', 'revoked', 'capability'] as const)(
    'rejects %s loss before replaying a committed wait',
    async reason => {
      const f = await fixture();
      f.readiness = { ...ready, unlock: 'locked' };
      const command = f.claim();
      const committed = await f.perform(command);
      expect(committed).toMatchObject({ status: 'accepted', result: { grant: null } });
      if (reason === 'storage') f.storageReady = false;
      else
        f.registration = {
          ...f.registration,
          ...(reason === 'revoked'
            ? { revokedAt: new Date(f.now()).toISOString() }
            : { supportedTools: [] }),
        };
      expect(await f.perform(command)).toMatchObject({
        status: 'rejected',
        error: {
          code:
            reason === 'storage'
              ? 'storage_unavailable'
              : reason === 'revoked'
                ? 'access_revoked'
                : 'unavailable_tool',
        },
      });
      await f.use((store, state) => {
        expect(store.getCommand(command.commandId)?.reply).toEqual(committed);
        expect(store.snapshot()?.pendingClientActions).toMatchObject([
          { reason: 'unavailable', grant: null },
        ]);
        expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([]);
      });
    }
  );

  it('races claims, retains a lost completion acknowledgment, and settles one SDK result', async () => {
    const f = await fixture();
    const commands = [f.claim(), f.claim()];
    const replies = await Promise.all(commands.map(f.perform));
    const request = grantReply(replies[0]);
    expect(grantReply(replies[1])).toEqual(request);
    await f.use((store, state) => {
      expect(drizzle(state.storage).select().from(s.grants).all()).toHaveLength(1);
      expect(drizzle(state.storage).select().from(s.attempts).all()).toMatchObject([
        {
          intent: {
            grant: request.grant,
            inputDigest: digest('{}'),
            policy: { decision: 'dispatch', clientReady: true },
          },
        },
      ]);
      expect(request.grant).toMatchObject({
        clientId: f.phone.id,
        ownerUserId: f.conversation.ownerUserId,
        toolCallId: f.calls[0].id,
        definitionVersion: '1',
        context: f.conversation.context,
      });
      expect(Date.parse(request.grant.expiresAt) - f.now()).toBe(30000);
      expect(store.snapshot()?.pendingClientActions).toEqual([]);
    });
    const command = f.complete(request);
    await f.use(async (store, state) => {
      const lost = {
        ...store,
        transition: async (...args: Parameters<ConversationStore['transition']>) => {
          await store.transition(...args);
          throw new StoreError('storage_unavailable', true);
        },
      } satisfies ConversationStore;
      expect(await f.scheduler(lost, state).clientTool(command, f.authority)).toMatchObject({
        status: 'rejected',
        error: { code: 'storage_unavailable' },
      });
      expect(store.getCommand(command.commandId)?.reply.status).toBe('accepted');
    });
    await abortAllDurableObjects();
    const reply = await f.perform(command);
    expect(reply).toMatchObject({ status: 'accepted', result: { result: receipt } });
    await f.alarm();
    expect(await f.perform(command)).toEqual(reply);
    expect(
      await f.perform({
        ...command,
        result: { status: 'succeeded', output: { permission: 'granted' } },
      })
    ).toMatchObject({ status: 'rejected', error: { code: 'command_conflict' } });
    expect(
      await f.perform({
        ...command,
        commandId: crypto.randomUUID(),
        result: { status: 'cancelled' },
      })
    ).toMatchObject({ status: 'rejected', error: { code: 'command_conflict' } });
    await f.use((store, state) => {
      expect(store.snapshot()?.activeRun).toBeNull();
      expect(store.callsForRun(f.runId)[0].data.result).toEqual(receipt);
      expect(ledger(state, f.runId).resultMessages[f.calls[0].id]).toMatchObject({
        role: 'tool',
        content: [{ toolCallId: 'sdk-0', output: { value: { permission: 'denied' } } }],
      });
      expect(drizzle(state.storage).select().from(s.attempts).all()).toHaveLength(1);
      expect(f.executions).toEqual([]);
    });
  });

  it.each([
    [{ foreground: false }, 'background'],
    [{ connectivity: 'offline' }, 'offline'],
    [{ connectivity: 'unknown' }, 'offline'],
    [{ unlock: 'locked' }, 'locked'],
    [{ unlock: 'unknown' }, 'locked'],
    [{ gesture: 'required' }, 'gesture'],
    [{ available: false }, 'unavailable'],
  ] as const)('persists %j without transferring or consuming a grant', async (change, reason) => {
    const f = await fixture();
    const later = await f.send();
    f.readiness = { ...ready, ...change };
    const command = f.claim();
    expect(await f.perform(command)).toMatchObject({ status: 'accepted', result: { grant: null } });
    await abortAllDurableObjects();
    await f.use(async (store, state) => {
      expect(store.snapshot()?.pendingClientActions).toMatchObject([
        { reason, grant: null, toolCall: { executionTarget: { clientId: f.phone.id } } },
      ]);
      expect(store.queuedRuns().map(row => row.id)).toEqual([later]);
      expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([]);
      expect(ledger(state, f.runId).reservations.every(item => item.status === 'released')).toBe(
        true
      );
    });
    expect(await f.perform(f.claim(f.web.id))).toMatchObject({
      status: 'rejected',
      error: { code: 'access_revoked' },
    });
    f.readiness = { ...ready };
    expect(await f.perform(command)).toMatchObject({ result: { grant: null } });
    expect(grantReply(await f.perform(f.claim())).grant.clientId).toBe(f.phone.id);
  });

  it.each(['expired', 'offline', 'storage_unavailable', 'access_revoked'] as const)(
    'keeps a claimed %s action unknown and accepts only its eventual receipt',
    async reason => {
      const f = await fixture();
      const request = grantReply(await f.perform(f.claim()));
      const later = await f.send();
      await abortAllDurableObjects();
      if (reason === 'expired') {
        f.clock += 30001;
        await f.alarm();
      } else
        await f.use((store, state) =>
          f.scheduler(store, state).clientUnavailable(f.phone.id, reason)
        );
      expect(await f.perform(f.claim())).toMatchObject({
        status: 'rejected',
        error: { code: 'outcome_unknown' },
      });
      expect(await f.perform(f.claim(f.web.id))).toMatchObject({
        status: 'rejected',
        error: { code: 'access_revoked' },
      });
      await f.use((store, state) => {
        expect(store.snapshot()?.activeRun?.state).toMatchObject({
          status: 'waiting',
          waiting: { reason: 'reconciliation' },
        });
        expect(store.snapshot()?.pendingClientActions).toMatchObject([
          { reason: 'reconciliation', grant: request.grant },
        ]);
        expect(store.queuedRuns().map(row => row.id)).toEqual([later]);
        expect(store.callsForRun(f.runId)[0].data).toMatchObject({
          state: 'executing',
          result: null,
        });
        expect(drizzle(state.storage).select().from(s.attempts).all()).toHaveLength(1);
      });
      expect(await f.perform(f.complete(request))).toMatchObject({
        status: 'accepted',
        result: { result: receipt },
      });
      await f.alarm();
      expect(f.executions).toEqual([]);
    }
  );

  it.each(['storage', 'revoked', 'capability'] as const)(
    'rejects %s identity before replay and preserves the uncertain effect',
    async reason => {
      const f = await fixture();
      const claim = f.claim(),
        request = grantReply(await f.perform(claim));
      if (reason === 'storage') f.storageReady = false;
      else
        f.registration = {
          ...f.registration,
          ...(reason === 'revoked'
            ? { revokedAt: new Date(f.now()).toISOString() }
            : { supportedTools: [{ name: 'app.notifications', version: '2' }] }),
        };
      const error = {
        code:
          reason === 'storage'
            ? 'storage_unavailable'
            : reason === 'revoked'
              ? 'access_revoked'
              : 'unavailable_tool',
      };
      expect(await f.perform(claim)).toMatchObject({ status: 'rejected', error });
      expect(await f.perform(f.complete(request))).toMatchObject({ status: 'rejected', error });
      await f.use(store =>
        expect(store.snapshot()?.pendingClientActions).toMatchObject([
          { reason: 'reconciliation', grant: request.grant },
        ])
      );
    }
  );

  it('keeps an incapable designated client waiting and refuses another registration', async () => {
    const f = await fixture();
    f.registration = { ...f.phone, supportedTools: [] };
    expect(await f.perform(f.claim())).toMatchObject({
      status: 'rejected',
      error: { code: 'unavailable_tool' },
    });
    await f.use((store, state) => {
      expect(store.snapshot()?.pendingClientActions).toMatchObject([
        { reason: 'unavailable', grant: null },
      ]);
      expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([]);
    });
    f.registration = { ...f.phone, id: crypto.randomUUID() };
    expect(await f.perform(f.claim(f.registration.id))).toMatchObject({
      status: 'rejected',
      error: { code: 'access_revoked' },
    });
  });

  it.each(['grantId', 'generation', 'clientId', 'result', 'oversized'] as const)(
    'rejects a foreign or invalid completion %s without changing the actual result',
    async field => {
      const f = await fixture();
      const request = grantReply(await f.perform(f.claim())),
        command = f.complete(request);
      const changes = {
        grantId: { grantId: crypto.randomUUID() },
        generation: { generation: request.grant.generation + 1 },
        clientId: { clientId: f.web.id },
        result: { result: { status: 'succeeded', output: { enabled: true } } },
        oversized: { result: { status: 'outcome_unknown', reason: 'x'.repeat(65536) } },
      };
      expect(await f.perform({ ...command, ...changes[field] })).toMatchObject({
        status: 'rejected',
        error: {
          code:
            field === 'result'
              ? 'invalid_output'
              : field === 'oversized'
                ? 'limit_exceeded'
                : 'access_revoked',
        },
      });
      await f.use(store =>
        expect(store.callsForRun(f.runId)[0].data).toMatchObject({
          state: 'executing',
          result: null,
        })
      );
      expect(await f.perform(f.complete(request))).toMatchObject({ status: 'accepted' });
    }
  );

  it.each(['stop', 'mode', 'identity', 'policy'] as const)(
    'fences %s changed during the policy check before granting execution',
    async boundary => {
      const f = await fixture();
      await f.use(async (store, state) => {
        const entered = deferred(),
          release = deferred();
        const runtime = createScheduler(state, store, {
          ...f.adapter,
          policy: async (...args) => {
            const policy = await f.adapter.policy(...args);
            entered.resolve();
            await release.promise;
            return boundary === 'policy' ? { ...policy, authorized: false } : policy;
          },
        });
        const pending = runtime.clientTool(f.claim(), f.authority);
        await entered.promise;
        if (boundary === 'stop') await admitCommand(state, store, f.cancel(), f.commandAdapter);
        if (boundary === 'mode')
          await admitCommand(
            state,
            store,
            {
              ...f.base,
              type: 'setPermissionMode',
              commandId: crypto.randomUUID(),
              permissionMode: 'ask',
              expectedPermissionRevision: 0,
            },
            f.commandAdapter
          );
        if (boundary === 'identity')
          f.registration = { ...f.phone, revokedAt: new Date(f.now()).toISOString() };
        release.resolve();
        const reply = await pending;
        expect(reply).toMatchObject({
          status: 'rejected',
          error: {
            code:
              boundary === 'stop'
                ? 'cancelled'
                : boundary === 'mode'
                  ? 'stale_revision'
                  : 'access_revoked',
          },
        });
        expect(drizzle(state.storage).select().from(s.attempts).all()).toEqual([]);
      });
    }
  );

  it.each(['succeeded', 'failed', 'outcome_unknown'] as const)(
    'keeps the actual %s receipt after Stop and cancels only remaining calls',
    async status => {
      const f = await fixture(['app.notifications', 'app.openSettings']);
      const request = grantReply(await f.perform(f.claim()));
      const later = await f.send();
      await f.use((store, state) => admitCommand(state, store, f.cancel(), f.commandAdapter));
      await f.alarm();
      f.clock += 30001;
      await f.alarm();
      const result: ToolOutcome =
        status === 'succeeded'
          ? receipt
          : status === 'failed'
            ? {
                status,
                error: {
                  code: 'unavailable_tool',
                  message: 'Permission unavailable.',
                  retryable: false,
                },
              }
            : { status, reason: 'Receipt unavailable.' };
      expect(await f.perform(f.complete(request, result))).toMatchObject({
        status: 'accepted',
        result: { result },
      });
      await f.use(async (store, state) => {
        const calls = store.callsForRun(f.runId);
        expect(calls[1].data.result).toEqual({ status: 'cancelled' });
        expect(calls[0].data.result).toEqual(status === 'outcome_unknown' ? null : result);
        expect(store.queuedRuns().map(row => row.id)).toEqual([later]);
        if (status !== 'outcome_unknown') {
          const before = store.snapshot();
          expect(await admitCommand(state, store, f.cancel(), f.commandAdapter)).toMatchObject({
            status: 'accepted',
            result: { state: { status: 'cancelled' } },
          });
          expect(store.snapshot()).toEqual(before);
        } else
          expect(store.snapshot()?.activeRun?.state).toMatchObject({
            status: 'waiting',
            waiting: { reason: 'reconciliation' },
          });
      });
    }
  );

  it.each(['claim', 'completion'] as const)(
    'rolls back every %s record when the command journal fails',
    async operation => {
      const f = await fixture();
      const request = operation === 'completion' ? grantReply(await f.perform(f.claim())) : null;
      const command = request ? f.complete(request) : f.claim();
      await f.use(async (original, state) => {
        const before = original.snapshot(),
          calls = original.callsForRun(f.runId),
          budget = ledger(state, f.runId);
        const store = {
          ...original,
          transition: (options, write) =>
            original.transition(options, db => {
              const changes = write(db);
              if (options.command)
                db.insert(s.commands)
                  .values({
                    id: command.commandId,
                    fingerprint: 'injected conflict',
                    reply: changes.reply,
                    sequence: 0,
                  })
                  .run();
              return changes;
            }),
        } satisfies ConversationStore;
        expect(await f.scheduler(store, state).clientTool(command, f.authority)).toMatchObject({
          status: 'rejected',
          error: { code: 'storage_unavailable' },
        });
        expect(original.snapshot()).toEqual(before);
        expect(original.callsForRun(f.runId)).toEqual(calls);
        const afterBudget = ledger(state, f.runId);
        expect(afterBudget.currentReservationId).toEqual(budget.currentReservationId);
        expect(afterBudget.reservations.slice(0, budget.reservations.length)).toEqual(
          budget.reservations
        );
        expect(afterBudget.reservations.slice(budget.reservations.length)).toEqual(
          request ? [] : [expect.objectContaining({ status: 'released', activeMs: 0 })]
        );
        expect(original.getCommand(command.commandId)).toBeNull();
        expect(drizzle(state.storage).select().from(s.grants).all()).toHaveLength(request ? 1 : 0);
        expect(drizzle(state.storage).select().from(s.attempts).all()).toHaveLength(
          request ? 1 : 0
        );
      });
      expect(await f.perform(command)).toMatchObject({ status: 'accepted' });
    }
  );

  it.each(['claim', 'completion'] as const)(
    'recovers %s before-arm, after-arm, and after-commit without another client request',
    async operation => {
      for (const boundary of ['before-arm', 'after-arm', 'after-commit'] as const) {
        const f = await fixture();
        const request = operation === 'completion' ? grantReply(await f.perform(f.claim())) : null;
        const command = request ? f.complete(request) : f.claim();
        await f.use(async (original, state) => {
          const beforeAlarm = await state.storage.getAlarm();
          const store =
            boundary === 'after-commit'
              ? ({
                  ...original,
                  transition: async (...args: Parameters<ConversationStore['transition']>) => {
                    const reply = await original.transition(...args);
                    if (args[0].command) throw new StoreError('storage_unavailable', true);
                    return reply;
                  },
                } satisfies ConversationStore)
              : await openStore(state, {
                  getAlarm: () => state.storage.getAlarm(),
                  setAlarm: async deadline => {
                    if (boundary === 'after-arm') await state.storage.setAlarm(deadline);
                    throw new Error('Injected alarm failure');
                  },
                });
          expect(await f.scheduler(store, state).clientTool(command, f.authority)).toMatchObject({
            status: 'rejected',
            error: { code: 'storage_unavailable' },
          });
          expect(original.getCommand(command.commandId)?.reply.status).toBe(
            boundary === 'after-commit' ? 'accepted' : undefined
          );
          expect(drizzle(state.storage).select().from(s.grants).all()).toHaveLength(
            request || boundary === 'after-commit' ? 1 : 0
          );
          expect(await state.storage.getAlarm()).toBe(
            boundary === 'before-arm' ? beforeAlarm : f.now() + 1
          );
        });
        await abortAllDurableObjects();
        f.clock += 30001;
        await runInDurableObject(f.stub(), (instance, state) => {
          instance.alarm = f.scheduler(instance.store, state).alarm;
        });
        expect(await runDurableObjectAlarm(f.stub())).toBe(
          operation !== 'claim' || boundary !== 'before-arm'
        );
        await f.use((store, state) => {
          const completed = operation === 'completion' && boundary === 'after-commit';
          expect(
            RunSchema.parse(
              drizzle(state.storage).select().from(s.runs).where(eq(s.runs.id, f.runId)).get()?.data
            ).state
          ).toMatchObject(
            completed
              ? { status: 'completed' }
              : {
                  status: 'waiting',
                  waiting: {
                    reason: request || boundary === 'after-commit' ? 'reconciliation' : 'client',
                  },
                }
          );
          expect(store.callsForRun(f.runId)[0].data.result).toEqual(completed ? receipt : null);
          expect(f.executions).toEqual([]);
        });
      }
    }
  );

  it.each(['execution', 'effect', 'receipt', 'send'] as const)(
    'uses the shared receipt contract across failures before and after %s',
    async point => {
      for (const side of ['before', 'after'] as const) {
        const f = await fixture();
        const request = {
          ...grantReply(await f.perform(f.claim())),
          completionCommandId: crypto.randomUUID(),
        };
        await f.use(async (store, state) => {
          const scope = {
            ownerUserId: f.phone.ownerUserId,
            clientId: f.phone.id,
            storageGeneration: crypto.randomUUID(),
          };
          let durable: JournalSnapshot = {
            scope,
            revision: 0,
            intents: [],
            acknowledgments: [],
            executions: [],
          };
          let fault = true,
            effects = 0;
          const edge = (at: string, when: string) => {
            if (fault && at === point && when === side) {
              fault = false;
              throw new Error(`Lost ${when} ${at}`);
            }
          };
          const journal: HarnessJournal = {
            read: async () => structuredClone(durable),
            compareAndSwap: async (_scope, revision, next) => {
              const at =
                next.executions.length > durable.executions.length
                  ? 'execution'
                  : next.executions[0]?.receipt && !durable.executions[0]?.receipt
                    ? 'receipt'
                    : 'journal';
              edge(at, 'before');
              if (durable.revision !== revision) return false;
              durable = JournalSnapshotSchema.parse(structuredClone(next));
              edge(at, 'after');
              return true;
            },
          };
          const open = () =>
            createHarnessClient({
              scope,
              currentScope: () => scope,
              journal,
              now: f.now,
              digest,
              transport: {
                send: async (_scope, command: Command) => {
                  edge('send', 'before');
                  expect(durable.executions[0]?.receipt).toEqual(receipt);
                  const reply = await f.scheduler(store, state).clientTool(command, f.authority);
                  edge('send', 'after');
                  return reply;
                },
              },
              bridge: {
                readiness: () => ready,
                execute: async () => {
                  edge('effect', 'before');
                  expect(durable.executions[0]?.grant.id).toBe(request.grant.id);
                  effects++;
                  edge('effect', 'after');
                  return receipt;
                },
                reconcileReceipt: async () => (effects ? receipt : null),
              },
            });
          await open().dispatch(request);
          expect(fault).toBe(false);
          await open().recover();
          await open().dispatch(request);
          await open().recover();
          const uncertain =
            (point === 'execution' && side === 'after') ||
            (point === 'effect' && side === 'before');
          expect(effects).toBe(uncertain ? 0 : 1);
          expect(store.callsForRun(f.runId)[0].data.result).toEqual(uncertain ? null : receipt);
          expect(drizzle(state.storage).select().from(s.attempts).all()).toHaveLength(1);
          if (uncertain) {
            f.clock += 30001;
            await f.scheduler(store, state).alarm();
            expect(store.snapshot()?.pendingClientActions).toMatchObject([
              { reason: 'reconciliation', grant: request.grant },
            ]);
          }
        });
      }
    }
  );

  it.each(['storage', 'account'] as const)(
    'invalidates local dispatch after %s loss without replacing the server grant',
    async loss => {
      const f = await fixture(),
        request = {
          ...grantReply(await f.perform(f.claim())),
          completionCommandId: crypto.randomUUID(),
        };
      await f.use(async (store, state) => {
        const scope = {
          ownerUserId: f.phone.ownerUserId,
          clientId: f.phone.id,
          storageGeneration: crypto.randomUUID(),
        };
        let effects = 0;
        const client = createHarnessClient({
          scope,
          currentScope: () => (loss === 'account' ? null : scope),
          now: f.now,
          digest,
          journal: {
            read: async () => null,
            compareAndSwap: async () => {
              throw new Error('Unsafe storage replacement');
            },
          },
          transport: {
            send: async () => {
              throw new Error('Unexpected send');
            },
          },
          bridge: {
            readiness: () => ready,
            execute: async () => {
              effects++;
              return receipt;
            },
            reconcileReceipt: async () => null,
          },
        });
        expect(await client.dispatch(request)).toMatchObject({
          status: 'unknown',
          error: { code: loss === 'account' ? 'access_revoked' : 'storage_unavailable' },
        });
        expect(await client.dispatch(request)).toMatchObject({ status: 'unknown' });
        await f
          .scheduler(store, state)
          .clientUnavailable(
            f.phone.id,
            loss === 'account' ? 'access_revoked' : 'storage_unavailable'
          );
        expect(effects).toBe(0);
        expect(store.snapshot()?.pendingClientActions).toMatchObject([
          { reason: 'reconciliation', grant: request.grant },
        ]);
      });
    }
  );

  it.each(['partial', 'arguments', 'context', 'definitionVersion', 'inputDigest'] as const)(
    'refuses a changed %s checkpoint or call before issuing a grant',
    async field => {
      const f = await fixture();
      await f.use((store, state) => {
        const db = drizzle(state.storage),
          call = store.callsForRun(f.runId)[0];
        if (field === 'partial')
          db.update(s.checkpoints)
            .set({ status: 'partial' })
            .where(eq(s.checkpoints.id, call.checkpointId))
            .run();
        else if (field === 'inputDigest')
          db.update(s.calls).set({ inputDigest: 'changed' }).where(eq(s.calls.id, call.id)).run();
        else
          db.update(s.calls)
            .set({
              data: {
                ...call.data,
                [field]:
                  field === 'arguments'
                    ? { changed: true }
                    : field === 'context'
                      ? { type: 'organization', organizationId: crypto.randomUUID() }
                      : '2',
              },
            })
            .where(eq(s.calls.id, call.id))
            .run();
      });
      expect(await f.perform(f.claim())).toMatchObject({
        status: 'rejected',
        error: { code: 'invalid_output' },
      });
      await f.use((_store, state) =>
        expect(drizzle(state.storage).select().from(s.grants).all()).toEqual([])
      );
    }
  );

  it.each(['ownerUserId', 'inputDigest', 'generation', 'expiresAt'] as const)(
    'rejects corrupt persisted grant %s without another dispatch',
    async field => {
      const f = await fixture(),
        claim = f.claim(),
        request = grantReply(await f.perform(claim));
      await f.use((_store, state) =>
        drizzle(state.storage)
          .update(s.grants)
          .set({
            data: {
              ...request.grant,
              [field]: field === 'generation' ? request.grant.generation + 1 : 'changed',
            },
          })
          .where(eq(s.grants.id, request.grant.id))
          .run()
      );
      expect(await f.perform(claim)).toMatchObject({
        status: 'rejected',
        error: { code: 'invalid_output' },
      });
      expect(await f.perform(f.complete(request))).toMatchObject({
        status: 'rejected',
        error: { code: 'invalid_output' },
      });
      await f.use((store, state) => {
        expect(store.callsForRun(f.runId)[0].data.result).toBeNull();
        expect(drizzle(state.storage).select().from(s.attempts).all()).toHaveLength(1);
      });
    }
  );

  it.each(['call', 'attempt', 'unsettled'] as const)(
    'rejects a mismatched %s receipt before canonical replay',
    async field => {
      const f = await fixture(),
        request = grantReply(await f.perform(f.claim()));
      const command = f.complete(request);
      expect(await f.perform(command)).toMatchObject({ status: 'accepted' });
      await f.use((store, state) => {
        const db = drizzle(state.storage),
          call = store.callsForRun(f.runId)[0];
        if (field === 'attempt')
          db.update(s.attempts)
            .set({ outcome: { status: 'cancelled' } })
            .where(eq(s.attempts.toolCallId, call.id))
            .run();
        else
          db.update(s.calls)
            .set(
              field === 'call'
                ? { data: { ...call.data, result: { status: 'cancelled' } } }
                : { state: 'executing', data: { ...call.data, state: 'executing', result: null } }
            )
            .where(eq(s.calls.id, call.id))
            .run();
      });
      expect(await f.perform(command)).toMatchObject({
        status: 'rejected',
        error: { code: 'invalid_output' },
      });
      await f.use((_store, state) =>
        expect(drizzle(state.storage).select().from(s.attempts).all()).toHaveLength(1)
      );
    }
  );

  it('preserves approval, client-read uncertainty, sequential calls, and backend settlement', async () => {
    const f = await fixture(['app.currentScreen', 'kilo.organizations']);
    const request = grantReply(await f.perform(f.claim()));
    expect(await f.perform(f.claim(f.phone.id, f.calls[1].id))).toMatchObject({
      status: 'rejected',
    });
    f.clock += 30001;
    await f.alarm();
    await f.use(store =>
      expect(store.snapshot()?.activeRun?.state).toMatchObject({
        status: 'waiting',
        waiting: { reason: 'reconciliation' },
      })
    );
    const result: ToolOutcome = {
      status: 'succeeded',
      output: { destination: { screen: 'preferences' }, data: {} },
    };
    expect(await f.perform(f.complete(request, result))).toMatchObject({ status: 'accepted' });
    await f.alarm();
    expect(f.executions).toEqual([f.calls[1].id]);
    const approval = await fixture();
    await approval.setMode('ask');
    expect(await approval.perform(approval.claim())).toMatchObject({
      status: 'accepted',
      result: { grant: null, decision: 'approval' },
    });
    await approval.use(async (store, state) => {
      const interaction = store.snapshot()!.unresolvedInteractions[0];
      expect(
        await approval.scheduler(store, state).resolveInteraction(
          {
            ...approval.base,
            type: 'resolveInteraction',
            commandId: crypto.randomUUID(),
            interactionId: interaction.id,
            resolution: { kind: 'approve' },
          },
          async () => ({
            conversation: approval.conversation,
            client: approval.phone,
            origin: 'user',
          })
        )
      ).toMatchObject({ status: 'accepted' });
    });
    const granted = grantReply(await approval.perform(approval.claim()));
    expect(granted.toolCall.approval?.decision).toBe('approve');
    await approval.setMode('yolo');
    await approval.setMode('ask');
    expect(await approval.perform(approval.complete(granted))).toMatchObject({
      status: 'accepted',
    });
  });
});
