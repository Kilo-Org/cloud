import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createHarnessClient, type ClientResult } from './client';
import { canonicalizeValidatedInput, type Command } from './commands';
import type { BridgeReadiness, ClientBridge } from './bridge';
import {
  CommandReplySchema,
  JournalSnapshotSchema,
  type CommandReply,
  type ExecutionRequest,
  type HarnessJournal,
  type JournalScope,
  type JournalSnapshot,
} from './journal';
import type { ToolOutcome } from './contracts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: JournalScope = { ownerUserId: 'owner', clientId: id(1), storageGeneration: id(2) };
const command: Extract<Command, { type: 'sendMessage' }> = {
  type: 'sendMessage',
  protocolVersion: 1,
  clientId: scope.clientId,
  commandId: id(3),
  conversationId: id(4),
  text: 'Keep this draft',
  modelId: 'test/model',
  permissionRevision: 0,
};
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const request: ExecutionRequest = {
  toolCall: {
    id: id(5),
    runId: id(6),
    name: 'app.openScreen',
    definitionVersion: '1',
    arguments: { screen: 'preferences' },
    context: { type: 'personal' },
    effect: 'side_effect',
    executionTarget: { kind: 'client', clientId: scope.clientId },
    approval: null,
    state: 'executing',
    result: null,
  },
  grant: {
    id: id(7),
    conversationId: command.conversationId,
    ownerUserId: scope.ownerUserId,
    clientId: scope.clientId,
    toolCallId: id(5),
    context: { type: 'personal' },
    definitionVersion: '1',
    inputDigest: digest(canonicalizeValidatedInput({ screen: 'preferences' })),
    generation: 1,
    expiresAt: '2026-08-29T00:00:00.000Z',
  },
  completionCommandId: id(8),
};
const unrelatedRequest: ExecutionRequest = {
  ...request,
  completionCommandId: id(21),
  toolCall: { ...request.toolCall, id: id(20), runId: id(24) },
  grant: { ...request.grant, id: id(22), toolCallId: id(20), conversationId: id(23) },
};
const receipt: ToolOutcome = { status: 'succeeded', output: { screen: 'preferences' } };
const ready: BridgeReadiness = {
  available: true,
  foreground: true,
  connectivity: 'confirmed',
  unlock: 'ready',
  gesture: 'not_required',
};
type Boundary =
  | 'read'
  | 'intent'
  | 'ack'
  | 'delete'
  | 'execution'
  | 'execution_wait'
  | 'receipt'
  | 'send'
  | 'effect'
  | 'reconcile';
type Side = 'before' | 'after';
const sides: Side[] = ['before', 'after'];
function fixture() {
  const f = {
    durable: {
      scope,
      revision: 0,
      intents: [],
      acknowledgments: [],
      executions: [],
    } as JournalSnapshot,
    active: scope as JournalScope | null,
    readiness: { ...ready },
    time: Date.parse('2026-08-28T00:00:00.000Z'),
    fault: undefined as { point: Boundary; side: Side } | undefined,
    hook: (_point: Boundary, _side: Side) => {},
    readOverride: undefined as (() => unknown) | undefined,
    reply: undefined as ((input: Command) => unknown) | undefined,
    evidence: (_execution: ExecutionRequest): unknown => null,
    effectResult: receipt as unknown,
    effects: [] as string[],
    attempts: [] as Command[],
    accepted: new Map<string, { canonical: string; reply: CommandReply }>(),
    reported: new Map<string, ToolOutcome>(),
    trace: [] as string[],
  };
  function edge(point: Boundary, side: Side) {
    f.trace.push(`${point}:${side}`);
    f.hook(point, side);
    if (f.fault?.point === point && f.fault.side === side) {
      f.fault = undefined;
      throw new Error(`Killed ${side} ${point}`);
    }
  }
  async function boundary<T>(point: Boundary, action: () => T): Promise<T> {
    edge(point, 'before');
    const value = action();
    edge(point, 'after');
    return value;
  }
  const journal: HarnessJournal = {
    read: async () =>
      boundary('read', () => (f.readOverride ? f.readOverride() : structuredClone(f.durable))),
    compareAndSwap: async (bound, expected, next) => {
      const point: Boundary =
        next.executions.length > f.durable.executions.length
          ? 'execution'
          : next.executions.length < f.durable.executions.length
            ? 'execution_wait'
            : next.acknowledgments.length > f.durable.acknowledgments.length
              ? 'ack'
              : next.intents.length > f.durable.intents.length
                ? 'intent'
                : next.intents.length < f.durable.intents.length
                  ? 'delete'
                  : 'receipt';
      return boundary(point, () => {
        if (canonicalizeValidatedInput(bound) !== canonicalizeValidatedInput(f.durable.scope))
          throw new Error('Scope changed');
        if (expected !== f.durable.revision) return false;
        f.durable = JournalSnapshotSchema.parse(structuredClone(next));
        return true;
      });
    },
  };
  const bridge: ClientBridge = {
    readiness: () => f.readiness,
    execute: async (bound, execution) =>
      boundary('effect', () => {
        if (canonicalizeValidatedInput(f.active) !== canonicalizeValidatedInput(bound))
          throw new Error('Account changed');
        if (
          !f.durable.executions.some(
            item => item.grant.id === execution.grant.id && item.receipt === null
          )
        )
          throw new Error('Effect without durable intent');
        f.effects.push(execution.toolCall.id);
        return f.effectResult;
      }),
    reconcileReceipt: async (_bound, execution) =>
      boundary('reconcile', () => f.evidence(execution)),
  };
  const open = () =>
    createHarnessClient({
      scope,
      currentScope: () => f.active,
      journal,
      bridge,
      now: () => f.time,
      digest,
      transport: {
        send: async (bound, input) =>
          boundary('send', () => {
            if (!f.durable.intents.some(item => item.command.commandId === input.commandId))
              throw new Error('Send without durable intent');
            if (
              input.type === 'completeClientTool' &&
              !f.durable.executions.some(
                item => item.completionCommandId === input.commandId && item.receipt !== null
              )
            )
              throw new Error('Completion without durable receipt');
            f.attempts.push(structuredClone(input));
            const key = `${bound.ownerUserId}:${bound.clientId}:${input.commandId}`;
            const canonical = canonicalizeValidatedInput(input);
            const prior = f.accepted.get(key);
            if (prior) {
              if (prior.canonical !== canonical)
                return {
                  status: 'rejected',
                  commandId: input.commandId,
                  error: { code: 'command_conflict', message: 'Conflict', retryable: false },
                };
              return prior.reply;
            }
            const reply = f.reply
              ? f.reply(input)
              : {
                  status: 'accepted',
                  commandId: input.commandId,
                  result: { position: f.accepted.size + 1 },
                };
            const parsed = parseReply(reply);
            if (parsed) {
              f.accepted.set(key, { canonical, reply: parsed });
              if (input.type === 'completeClientTool' && parsed.status === 'accepted')
                f.reported.set(input.toolCallId, input.result);
            }
            return reply;
          }),
      },
    });
  return Object.assign(f, { open, journal });
}
// Invalid transport fixtures must reach the client unchanged, not fail inside the adapter.
function parseReply(input: unknown) {
  const parsed = CommandReplySchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
const errorCode = (result: ClientResult) => ('error' in result ? result.error.code : undefined);

it.each(
  (['read', 'intent', 'send', 'ack', 'delete'] as const).flatMap(point =>
    sides.map(side => ({ point, side }))
  )
)(
  'relaunches across $side $point with one accepted command and its original result',
  async ({ point, side }) => {
    const f = fixture();
    f.fault = { point, side };
    const first = await f.open().submit(command);
    expect(first.status).toBe(point === 'intent' ? 'unsent' : 'unknown');
    const relaunched = f.open();
    await relaunched.recover();
    const result = await relaunched.submit(command);
    expect(result).toMatchObject({ status: 'accepted', command, result: { position: 1 } });
    expect(f.accepted.size).toBe(1);
    expect(f.durable.intents).toEqual([]);
    expect(f.durable.acknowledgments[0].intent.command).toEqual(command);
    expect(
      f.attempts.every(
        input => canonicalizeValidatedInput(input) === canonicalizeValidatedInput(command)
      )
    ).toBe(true);
    if (point === 'delete' || (point === 'ack' && side === 'after'))
      expect(f.attempts).toHaveLength(1);
  }
);
it('freezes the submitted input before queued work and ignores caller mutations', async () => {
  const f = fixture();
  const input = { ...command };
  const sending = f.open().submit(input);
  input.text = 'Changed after Send';
  await sending;
  expect(f.attempts).toEqual([command]);
  expect(f.durable.acknowledgments[0].intent.command).toEqual(command);
});
it.each(['pending', 'acknowledged'] as const)(
  'rejects changed input for a %s command ID',
  async state => {
    const f = fixture();
    if (state === 'pending') f.fault = { point: 'send', side: 'after' };
    await f.open().submit(command);
    const result = await f.open().submit({ ...command, text: 'Different input' });
    expect(errorCode(result)).toBe('command_conflict');
    expect(f.accepted.size).toBe(1);
    expect(f.attempts).toEqual([command]);
  }
);
it('latches failed storage until a verified recovery read, without new commands or effects', async () => {
  const f = fixture(),
    client = f.open();
  f.fault = { point: 'intent', side: 'before' };
  expect(await client.submit(command)).toMatchObject({
    status: 'unsent',
    error: { code: 'storage_unavailable' },
  });
  expect(errorCode(await client.submit({ ...command, commandId: id(30) }))).toBe(
    'storage_unavailable'
  );
  expect(errorCode(await client.dispatch(request))).toBe('storage_unavailable');
  expect(f.accepted.size).toBe(0);
  expect(f.effects).toEqual([]);
  expect(await client.recover()).toEqual([]);
  expect((await client.submit(command)).status).toBe('accepted');
});
it('retains a stale draft after relaunch and requires explicit review for a changed send', async () => {
  const f = fixture();
  f.reply = input => ({
    status: 'rejected',
    commandId: input.commandId,
    error: { code: 'stale_revision', message: 'Review the new mode', retryable: true },
  });
  await f.open().submit(command);
  f.reply = undefined;
  const client = f.open();
  expect(await client.recover()).toMatchObject([
    { status: 'rejected', command, error: { code: 'stale_revision' } },
  ]);
  const replacement = { ...command, commandId: id(30), permissionRevision: 1 };
  expect(await client.submit(replacement)).toMatchObject({
    status: 'rejected',
    command,
    error: { code: 'stale_revision' },
  });
  expect(f.accepted.size).toBe(1);
  expect((await client.submit(replacement, { reviewedCommandId: command.commandId })).status).toBe(
    'accepted'
  );
  expect(f.attempts).toEqual([command, replacement]);
  expect(f.durable.acknowledgments[0].intent.command).toEqual(command);
  expect(await f.open().recover()).toEqual([]);
});
it.each(['access_revoked', 'retired', 'unsupported_protocol'] as const)(
  'preserves a non-retryable %s rejection without replay',
  async code => {
    const f = fixture();
    f.reply = input => ({
      status: 'rejected',
      commandId: input.commandId,
      error: { code, message: 'Blocked', retryable: false },
    });
    expect(await f.open().submit(command)).toMatchObject({
      status: 'rejected',
      error: { code, retryable: false },
    });
    await f.open().recover();
    await f.open().submit(command);
    expect(f.attempts).toHaveLength(1);
  }
);
it.each(['access_revoked', 'retired'] as const)(
  'retains a %s completion without blocking a distinct authorized action',
  async code => {
    const f = fixture();
    f.reply = input => ({
      status: 'rejected',
      commandId: input.commandId,
      error: { code, message: 'Blocked', retryable: false },
    });
    const rejection = {
      status: 'rejected',
      command: { commandId: request.completionCommandId },
      error: { code, retryable: false },
    };
    expect(await f.open().dispatch(request)).toMatchObject(rejection);
    const retained = structuredClone(f.durable.executions[0]);
    f.reply = undefined;
    const client = f.open();
    expect(await client.recover()).toMatchObject([rejection]);
    const completion = {
      status: 'accepted',
      command: {
        commandId: unrelatedRequest.completionCommandId,
        conversationId: unrelatedRequest.grant.conversationId,
      },
    };
    expect(await client.dispatch(unrelatedRequest)).toMatchObject(completion);
    expect(await client.dispatch(unrelatedRequest)).toMatchObject(completion);
    expect(await f.open().dispatch(request)).toMatchObject(rejection);
    expect(await f.open().recover()).toMatchObject([rejection, completion]);
    expect(f.effects).toEqual([request.toolCall.id, unrelatedRequest.toolCall.id]);
    expect([...f.reported]).toEqual([[unrelatedRequest.toolCall.id, receipt]]);
    expect(f.attempts.map(input => input.commandId)).toEqual([
      request.completionCommandId,
      unrelatedRequest.completionCommandId,
    ]);
    expect(f.durable.executions[0]).toEqual(retained);
  }
);
it.each(['access_revoked', 'retired'] as const)(
  'does not bypass a retryable %s completion for an unrelated action',
  async code => {
    const f = fixture();
    f.reply = input => ({
      status: 'rejected',
      commandId: input.commandId,
      error: { code, message: 'Retry', retryable: true },
    });
    await f.open().dispatch(request);
    expect(await f.open().dispatch(unrelatedRequest)).toMatchObject({
      status: 'rejected',
      command: { commandId: request.completionCommandId },
      error: { code, retryable: true },
    });
    expect(f.effects).toEqual([request.toolCall.id]);
    expect(f.reported.size).toBe(0);
  }
);
it.each(sides)(
  'keeps a crash %s the effect unknown across readiness loss and restoration',
  async side => {
    const f = fixture();
    f.fault = { point: 'effect', side };
    await f.open().dispatch(request);
    const client = f.open();
    const unknown = { status: 'unknown', error: { code: 'outcome_unknown' } };
    f.readiness = { ...ready, foreground: false };
    expect(await client.dispatch(request)).toMatchObject(unknown);
    f.readiness = ready;
    expect(await client.dispatch(request)).toMatchObject(unknown);
    expect(await client.dispatch(unrelatedRequest)).toMatchObject(unknown);
    expect(f.effects).toEqual(side === 'before' ? [] : [request.toolCall.id]);
    expect(f.reported.size).toBe(0);
    expect(f.durable.executions).toHaveLength(1);
  }
);
it.each([null, {}, { status: 'accepted', commandId: id(99), result: {} }])(
  'retains the intent after an invalid acknowledgment: %j',
  async reply => {
    const f = fixture();
    f.reply = () => reply;
    expect(errorCode(await f.open().submit(command))).toBe('invalid_output');
    expect(f.durable.intents).toHaveLength(1);
    expect(f.durable.acknowledgments).toEqual([]);
  }
);
it.each(
  (['read', 'execution', 'effect', 'receipt', 'intent', 'send', 'ack', 'delete'] as const).flatMap(
    point => sides.map(side => ({ point, side }))
  )
)('never repeats an effect after a crash $side $point', async ({ point, side }) => {
  const f = fixture();
  f.fault = { point, side };
  await f.open().dispatch(request);
  const hadIntent = f.durable.executions.length > 0;
  const effects = f.effects.length;
  const client = f.open();
  await client.recover();
  await client.dispatch(request);
  expect(f.effects).toHaveLength(hadIntent ? effects : 1);
  expect(f.effects.length).toBeLessThanOrEqual(1);
  const execution = f.durable.executions[0];
  if (execution.receipt !== null) {
    expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
    expect(f.accepted.size).toBe(1);
  } else {
    expect(f.reported.size).toBe(0);
    expect(await client.dispatch(request)).toMatchObject({
      status: 'unknown',
      error: { code: 'outcome_unknown' },
    });
  }
});
it('rejects completion reports without a committed receipt', async () => {
  const f = fixture();
  const result = await f.open().submit({
    type: 'completeClientTool',
    protocolVersion: 1,
    clientId: scope.clientId,
    commandId: request.completionCommandId,
    conversationId: request.grant.conversationId,
    toolCallId: request.toolCall.id,
    grantId: request.grant.id,
    generation: request.grant.generation,
    result: receipt,
  });
  expect(errorCode(result)).toBe('invalid_input');
  expect(f.accepted.size).toBe(0);
});
it.each(sides)(
  'reconciles evidence without executing again after failure %s the evidence read',
  async side => {
    const f = fixture();
    f.fault = { point: 'effect', side: 'after' };
    await f.open().dispatch(request);
    f.evidence = () => receipt;
    f.fault = { point: 'reconcile', side };
    await f.open().recover();
    await f.open().recover();
    expect(f.effects).toEqual([request.toolCall.id]);
    expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
  }
);
it.each(['recover', 'dispatch'] as const)(
  'reports stored receipts before evidence queries during %s',
  async mode => {
    const f = fixture();
    const second = {
      ...request,
      completionCommandId: id(21),
      toolCall: { ...request.toolCall, id: id(20) },
      grant: { ...request.grant, id: id(22), toolCallId: id(20) },
    };
    f.durable.executions = [
      { ...request, receipt: null },
      { ...second, receipt },
    ];
    f.evidence = () => (f.reported.has(second.toolCall.id) ? receipt : null);
    if (mode === 'recover') await f.open().recover();
    else await f.open().dispatch(request);
    expect([...f.reported.keys()]).toEqual([second.toolCall.id, request.toolCall.id]);
    expect(f.effects).toEqual([]);
  }
);
it('does not transfer an uncertain execution to a replacement grant', async () => {
  const f = fixture();
  f.fault = { point: 'effect', side: 'after' };
  await f.open().dispatch(request);
  const result = await f
    .open()
    .dispatch({ ...request, grant: { ...request.grant, id: id(50), generation: 2 } });
  expect(errorCode(result)).toBe('outcome_unknown');
  expect(f.effects).toEqual([request.toolCall.id]);
  expect(f.durable.executions[0].grant).toEqual(request.grant);
});
it.each([
  [{ available: false }, 'unavailable'],
  [{ foreground: false }, 'background'],
  [{ connectivity: 'offline' }, 'offline'],
  [{ connectivity: 'unknown' }, 'offline'],
  [{ unlock: 'locked' }, 'locked'],
  [{ unlock: 'unknown' }, 'locked'],
  [{ gesture: 'required' }, 'gesture'],
] as const)('waits for bridge readiness %j without admitting an effect', async (change, reason) => {
  const f = fixture();
  f.readiness = { ...ready, ...change };
  expect(await f.open().dispatch(request)).toEqual({ status: 'waiting', reason });
  expect(f.effects).toEqual([]);
  expect(f.durable.executions).toEqual([]);
  f.readiness = ready;
  expect((await f.open().dispatch(request)).status).toBe('accepted');
  expect(f.effects).toEqual([request.toolCall.id]);
});
it.each(
  (
    [
      [{ available: false }, 'unavailable'],
      [{ foreground: false }, 'background'],
      [{ connectivity: 'offline' }, 'offline'],
      [{ connectivity: 'unknown' }, 'offline'],
      [{ unlock: 'locked' }, 'locked'],
      [{ unlock: 'unknown' }, 'locked'],
      [{ gesture: 'required' }, 'gesture'],
    ] as const
  ).flatMap(([change, reason]) =>
    (['same host', 'relaunch'] as const).map(resume => ({ change, reason, resume }))
  )
)(
  'resumes a $reason wait after the intent commit on $resume without repeating effects',
  async ({ change, reason, resume }) => {
    const f = fixture(),
      client = f.open();
    f.hook = (point, side) => {
      if (point === 'execution' && side === 'after') f.readiness = { ...ready, ...change };
    };
    expect(await client.dispatch(request)).toEqual({ status: 'waiting', reason });
    expect(f.effects).toEqual([]);
    expect(f.reported.size).toBe(0);
    f.hook = () => {};
    f.readiness = ready;
    const resumed = resume === 'same host' ? client : f.open();
    await resumed.recover();
    expect(f.effects).toEqual([]);
    expect(await resumed.dispatch(request)).toMatchObject({
      status: 'accepted',
      command: { commandId: request.completionCommandId },
    });
    await resumed.dispatch(request);
    await f.open().recover();
    expect(f.effects).toEqual([request.toolCall.id]);
    expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
    expect(f.attempts).toHaveLength(1);
  }
);
it('refuses a grant that expires during the execution intent commit', async () => {
  const f = fixture();
  f.hook = (point, side) => {
    if (point === 'execution' && side === 'after') f.time = Date.parse(request.grant.expiresAt);
  };
  expect(await f.open().dispatch(request)).toMatchObject({
    status: 'unsent',
    error: { code: 'access_revoked' },
  });
  f.hook = () => {};
  await f.open().recover();
  expect(f.effects).toEqual([]);
  expect(f.reported.size).toBe(0);
});
it.each(sides)('requires a durable wait release after a crash %s its commit', async side => {
  const f = fixture(),
    client = f.open();
  f.hook = (point, edge) => {
    if (point === 'execution' && edge === 'after') f.readiness = { ...ready, foreground: false };
  };
  f.fault = { point: 'execution_wait', side };
  expect(await client.dispatch(request)).toMatchObject({
    status: 'unsent',
    error: { code: 'storage_unavailable' },
  });
  expect(f.effects).toEqual([]);
  expect(f.reported.size).toBe(0);
  f.hook = () => {};
  f.readiness = ready;
  expect(errorCode(await client.dispatch(request))).toBe('storage_unavailable');
  const relaunched = f.open();
  await relaunched.recover();
  const result = await relaunched.dispatch(request);
  if (side === 'before') {
    expect(result).toMatchObject({ status: 'unknown', error: { code: 'outcome_unknown' } });
    expect(f.effects).toEqual([]);
    expect(f.reported.size).toBe(0);
  } else {
    expect(result.status).toBe('accepted');
    expect(f.effects).toEqual([request.toolCall.id]);
    expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
    await relaunched.dispatch(request);
    expect(f.effects).toHaveLength(1);
    expect(f.attempts).toHaveLength(1);
  }
});
it('retains the execution fence when a concurrent commit prevents the wait release', async () => {
  const f = fixture();
  f.hook = (point, side) => {
    if (point === 'execution' && side === 'after') f.readiness = { ...ready, foreground: false };
    if (point === 'execution_wait' && side === 'before') f.durable.revision++;
  };
  expect(await f.open().dispatch(request)).toMatchObject({
    status: 'unknown',
    error: { code: 'storage_unavailable' },
  });
  f.hook = () => {};
  f.readiness = ready;
  await f.open().recover();
  expect(await f.open().dispatch(request)).toMatchObject({
    status: 'unknown',
    error: { code: 'outcome_unknown' },
  });
  expect(f.effects).toEqual([]);
  expect(f.reported.size).toBe(0);
  expect(f.durable.executions).toHaveLength(1);
});
it('serializes competing hosts with an atomic execution fence', async () => {
  const f = fixture();
  const results = await Promise.all([f.open().dispatch(request), f.open().dispatch(request)]);
  expect(results).toContainEqual(
    expect.objectContaining({
      status: 'unknown',
      error: expect.objectContaining({ code: 'storage_unavailable' }),
    })
  );
  await f.open().recover();
  expect(f.effects).toEqual([request.toolCall.id]);
  expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
});
it.each(
  (
    [
      'read',
      'intent',
      'send',
      'ack',
      'delete',
      'execution',
      'execution_wait',
      'effect',
      'receipt',
      'reconcile',
    ] as const
  ).flatMap(point => sides.map(side => ({ point, side })))
)(
  'stops an old account at $side $point without exposing its result to the next account',
  async ({ point, side }) => {
    const f = fixture();
    if (point === 'reconcile') f.durable.executions = [{ ...request, receipt: null }];
    const client = f.open();
    f.hook = (at, edge) => {
      if (point === 'execution_wait' && at === 'execution' && edge === 'after')
        f.readiness = { ...ready, foreground: false };
      if (at === point && edge === side) f.active = { ...scope, ownerUserId: 'another-owner' };
    };
    const result =
      point === 'reconcile'
        ? await client.recover()
        : ['execution', 'execution_wait', 'effect', 'receipt'].includes(point)
          ? await client.dispatch(request)
          : await client.submit(command);
    expect(result).toMatchObject({
      status: ['intent', 'execution', 'execution_wait'].includes(point) ? 'unsent' : 'unknown',
      error: { code: 'access_revoked' },
    });
    const accepted = f.accepted.size,
      effects = f.effects.length;
    expect(errorCode(await client.submit({ ...command, commandId: id(80) }))).toBe(
      'access_revoked'
    );
    expect(errorCode(await client.dispatch(request))).toBe('access_revoked');
    expect(f.accepted.size).toBe(accepted);
    expect(f.effects).toHaveLength(effects);
    expect(f.durable.scope).toEqual(scope);
  }
);
it.each(['clientId', 'storageGeneration'] as const)(
  'invalidates the host when %s changes',
  async field => {
    const f = fixture(),
      client = f.open();
    f.active = { ...scope, [field]: id(90) };
    expect(errorCode(await client.submit(command))).toBe('access_revoked');
    f.active = scope;
    expect(errorCode(await client.dispatch(request))).toBe('access_revoked');
    expect(f.effects).toEqual([]);
  }
);
it('ignores a disposed host and restores the committed command on a new host', async () => {
  const f = fixture(),
    client = f.open();
  f.hook = (point, side) => {
    if (point === 'send' && side === 'after') client.dispose();
  };
  expect(errorCode(await client.submit(command))).toBe('access_revoked');
  f.hook = () => {};
  await f.open().recover();
  expect(f.accepted.size).toBe(1);
  expect(f.durable.intents).toEqual([]);
});
const corruptionCases: [string, (state: JournalSnapshot) => unknown][] = [
  ['missing storage', () => undefined],
  ['null storage', () => null],
  ['missing collections', state => ({ scope: state.scope, revision: state.revision })],
  ['extra fields', state => ({ ...state, extra: true })],
  ['wrong account', state => ({ ...state, scope: { ...scope, ownerUserId: 'other' } })],
  ['wrong client', state => ({ ...state, scope: { ...scope, clientId: id(40) } })],
  ['lost generation', state => ({ ...state, scope: { ...scope, storageGeneration: id(40) } })],
  ['invalid revision', state => ({ ...state, revision: -1 })],
  [
    'changed canonical input',
    state => ({ ...state, intents: [{ ...state.intents[0], canonicalInput: '{}' }] }),
  ],
  ['duplicate command', state => ({ ...state, intents: [...state.intents, ...state.intents] })],
  [
    'duplicate acknowledgment',
    state => ({ ...state, acknowledgments: [...state.acknowledgments, ...state.acknowledgments] }),
  ],
  [
    'unmatched acknowledgment',
    state => ({
      ...state,
      acknowledgments: [
        {
          ...state.acknowledgments[0],
          reply: { status: 'accepted', commandId: id(40), result: null },
        },
      ],
    }),
  ],
  [
    'duplicate execution',
    state => ({ ...state, executions: [...state.executions, ...state.executions] }),
  ],
  [
    'foreign execution',
    state => ({
      ...state,
      executions: [{ ...state.executions[0], grant: { ...request.grant, ownerUserId: 'other' } }],
    }),
  ],
  [
    'changed execution target',
    state => ({
      ...state,
      executions: [
        {
          ...state.executions[0],
          toolCall: { ...request.toolCall, executionTarget: { kind: 'client', clientId: id(40) } },
        },
      ],
    }),
  ],
  [
    'invalid receipt',
    state => ({
      ...state,
      executions: [{ ...state.executions[0], receipt: { status: 'succeeded' } }],
    }),
  ],
];
it.each(corruptionCases)(
  'blocks %s instead of replacing it with empty storage',
  async (_name, corrupt) => {
    const f = fixture();
    const intent = { command, canonicalInput: canonicalizeValidatedInput(command) };
    const stored: JournalSnapshot = {
      scope,
      revision: 4,
      intents: [intent],
      acknowledgments: [
        { intent, reply: { status: 'accepted', commandId: command.commandId, result: {} } },
      ],
      executions: [{ ...request, receipt }],
    };
    f.readOverride = () => corrupt(stored);
    expect(await f.open().submit({ ...command, commandId: id(60) })).toMatchObject({
      status: 'unknown',
      error: { code: 'storage_unavailable' },
    });
    expect(f.accepted.size).toBe(0);
    expect(f.durable.revision).toBe(0);
    expect(f.effects).toEqual([]);
  }
);

it('keeps an executed effect unknown when its completion intent cannot commit', async () => {
  const f = fixture();
  f.fault = { point: 'intent', side: 'before' };
  expect(await f.open().dispatch(request)).toMatchObject({
    status: 'unknown',
    error: { code: 'storage_unavailable' },
  });
  expect(f.effects).toEqual([request.toolCall.id]);
  expect(f.reported.size).toBe(0);
  await f.open().recover();
  expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
  expect(f.effects).toEqual([request.toolCall.id]);
});
it.each([
  { status: 'denied' },
  { status: 'cancelled' },
  { status: 'failed', error: { code: 'unavailable_tool', message: 'Retry', retryable: true } },
  { status: 'failed', error: { code: 'access_revoked', message: 'Blocked', retryable: false } },
  { status: 'outcome_unknown', reason: 'Provider reply lost' },
] satisfies ToolOutcome[])(
  'preserves a %j receipt without turning it into success or repeating the effect',
  async result => {
    const f = fixture();
    f.effectResult = result;
    expect((await f.open().dispatch(request)).status).toBe('accepted');
    await f.open().recover();
    expect(f.reported.get(request.toolCall.id)).toEqual(result);
    expect(f.effects).toEqual([request.toolCall.id]);
  }
);
it.each([undefined, { status: 'succeeded' }, { status: 'succeeded', output: {}, extra: true }])(
  'leaves an invalid executor receipt unknown: %j',
  async result => {
    const f = fixture();
    f.effectResult = result;
    expect(errorCode(await f.open().dispatch(request))).toBe('invalid_output');
    await f.open().recover();
    expect(f.effects).toEqual([request.toolCall.id]);
    expect(f.reported.size).toBe(0);
  }
);
it('preserves the first committed receipt when a concurrent reconciliation finishes', async () => {
  const f = fixture();
  f.durable.executions = [{ ...request, receipt: null }];
  f.evidence = () => ({ status: 'cancelled' });
  f.hook = (point, side) => {
    if (point === 'reconcile' && side === 'after') {
      f.durable.executions = [{ ...request, receipt }];
      f.durable.revision++;
    }
  };
  await f.open().recover();
  expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
  expect(f.durable.executions[0].receipt).toEqual(receipt);
  expect(f.effects).toEqual([]);
});
it('rejects a journal rollback instead of admitting new work into an empty snapshot', async () => {
  const f = fixture(),
    client = f.open();
  const empty = structuredClone(f.durable);
  await client.submit(command);
  f.readOverride = () => empty;
  expect(errorCode(await client.submit({ ...command, commandId: id(60) }))).toBe(
    'storage_unavailable'
  );
  expect(f.accepted.size).toBe(1);
  expect(f.durable.acknowledgments[0].intent.command).toEqual(command);
});
it.each([
  [null, 'invalid_input'],
  [{ ...request, grant: { ...request.grant, inputDigest: 'changed' } }, 'invalid_input'],
  [{ ...request, grant: { ...request.grant, ownerUserId: 'other' } }, 'access_revoked'],
  [
    {
      ...request,
      toolCall: { ...request.toolCall, executionTarget: { kind: 'client', clientId: id(60) } },
      grant: { ...request.grant, clientId: id(60) },
    },
    'access_revoked',
  ],
  [{ ...request, grant: { ...request.grant, definitionVersion: '2' } }, 'invalid_input'],
  [
    {
      ...request,
      grant: { ...request.grant, context: { type: 'organization', organizationId: id(60) } },
    },
    'invalid_input',
  ],
  [{ ...request, grant: { ...request.grant, toolCallId: id(60) } }, 'invalid_input'],
  [
    { ...request, toolCall: { ...request.toolCall, state: 'settled', result: receipt } },
    'invalid_input',
  ],
] as const)('refuses invalid or foreign execution authority %#', async (input, code) => {
  const f = fixture();
  expect(errorCode(await f.open().dispatch(input))).toBe(code);
  expect(f.effects).toEqual([]);
  expect(f.durable.executions).toEqual([]);
});
it('does not reuse a message command ID for an execution completion', async () => {
  const f = fixture();
  await f.open().submit(command);
  expect(
    errorCode(await f.open().dispatch({ ...request, completionCommandId: command.commandId }))
  ).toBe('invalid_input');
  expect(f.effects).toEqual([]);
  expect(f.accepted.size).toBe(1);
});
it.each([
  { available: true },
  { ...ready, unlock: undefined },
  { ...ready, connectivity: true },
] as const)('fails closed for missing or malformed readiness: %j', async readiness => {
  const f = fixture();
  f.readiness = readiness as BridgeReadiness;
  await f.open().dispatch(request);
  expect(f.effects).toEqual([]);
  expect(f.durable.executions).toEqual([]);
});
it.each(
  (['dispatch', 'recover'] as const).flatMap(mode =>
    (mode === 'dispatch' ? [2, 3, 4] : [1, 2, 3, 4, 5]).flatMap(ordinal =>
      sides.map(side => ({ mode, ordinal, side }))
    )
  )
)(
  'survives $side journal read $ordinal during $mode without repeating effects',
  async ({ mode, ordinal, side }) => {
    const f = fixture();
    if (mode === 'recover') {
      f.durable.executions = [{ ...request, receipt: null }];
      f.evidence = () => receipt;
    }
    let reads = 0,
      killed = false;
    f.hook = (point, edge) => {
      if (point === 'read' && edge === side && ++reads === ordinal) {
        killed = true;
        throw new Error('Killed during journal read');
      }
    };
    const first = mode === 'dispatch' ? await f.open().dispatch(request) : await f.open().recover();
    expect(first).toMatchObject({ status: 'unknown', error: { code: 'storage_unavailable' } });
    expect(killed).toBe(true);
    const hadIntent = f.durable.executions.length > 0,
      effects = f.effects.length;
    f.hook = () => {};
    const client = f.open();
    await client.recover();
    if (mode === 'dispatch') await client.dispatch(request);
    expect(f.effects).toHaveLength(hadIntent ? effects : 1);
    if (f.durable.executions[0].receipt !== null)
      expect(f.reported.get(request.toolCall.id)).toEqual(receipt);
  }
);
it.each([Number.NaN, Date.parse(request.grant.expiresAt)])(
  'refuses dispatch at an invalid or expired time: %s',
  async time => {
    const f = fixture();
    f.time = time;
    expect(errorCode(await f.open().dispatch(request))).toBe('access_revoked');
    expect(f.effects).toEqual([]);
    expect(f.durable.executions).toEqual([]);
  }
);
