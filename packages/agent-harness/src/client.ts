import type { z } from 'zod';
import { canonicalizeValidatedInput, CommandSchema, type Command } from './commands';
import { ErrorSchema, ToolOutcomeSchema } from './contracts';
import { bridgeWaitReason, type ClientBridge } from './bridge';
import {
  CommandReplySchema,
  ExecutionIntentSchema,
  ExecutionRequestSchema,
  JournalScopeSchema,
  JournalSnapshotSchema,
  completionCommand,
  executionKey,
  type CommandIntent,
  type CommandReply,
  type ExecutionIntent,
  type HarnessJournal,
  type JournalScope,
  type JournalSnapshot,
} from './journal';

type Failure = z.infer<typeof ErrorSchema>;
export type ClientProblem = { status: 'unsent' | 'unknown'; error: Failure };
export type ClientResult =
  | {
      status: 'accepted';
      command: Command;
      result: Extract<CommandReply, { status: 'accepted' }>['result'];
    }
  | { status: 'rejected'; command: Command; error: Failure }
  | { status: 'waiting'; reason: NonNullable<ReturnType<typeof bridgeWaitReason>> }
  | ClientProblem;
export type CommandTransport = {
  // Resolve only a committed command result. Reject ambiguous transport failures. The adapter must
  // bind authentication to this exact scope, not whichever account is active after an await.
  send: (scope: JournalScope, command: Command) => Promise<unknown>;
};
export type ClientOptions = {
  scope: JournalScope;
  currentScope: () => JournalScope | null;
  journal: HarnessJournal;
  transport: CommandTransport;
  bridge: ClientBridge;
  now: () => number;
  digest: (canonicalArguments: string) => string | Promise<string>;
};
const problem = (code: Failure['code'], message: string, retryable = false): Failure => ({
  code,
  message,
  retryable,
});
const same = (left: unknown, right: unknown) =>
  canonicalizeValidatedInput(left) === canonicalizeValidatedInput(right);
const rejected = (command: Command, code: Failure['code']): ClientResult => ({
  status: 'rejected',
  command,
  error: problem(code, code),
});
const acknowledged = (intent: CommandIntent, reply: CommandReply): ClientResult =>
  reply.status === 'accepted'
    ? { status: 'accepted', command: intent.command, result: reply.result }
    : { status: 'rejected', command: intent.command, error: reply.error };
const blocksUnrelatedDispatch = (result: ClientResult) =>
  result.status !== 'accepted' &&
  !(
    result.status === 'rejected' &&
    !result.error.retryable &&
    (result.error.code === 'access_revoked' || result.error.code === 'retired')
  );

export function createHarnessClient(options: ClientOptions) {
  const scope = JournalScopeSchema.parse(options.scope);
  let blocked: Failure | undefined;
  let disposed = false,
    revision = -1,
    uncertain = false;
  let outcome: ClientProblem['status'] = 'unknown';
  let queue = Promise.resolve();
  function guard() {
    if (disposed || !same(options.currentScope(), scope)) {
      disposed = true;
      throw problem('access_revoked', 'The journal scope is no longer active.');
    }
  }
  async function storage<T>(operation: () => Promise<T>): Promise<T> {
    guard();
    let result: T;
    try {
      result = await operation();
    } catch {
      blocked = problem('storage_unavailable', 'Durable storage is unavailable.', true);
      throw blocked;
    }
    guard();
    return result;
  }
  async function load() {
    return storage(async () => {
      const state = JournalSnapshotSchema.parse(await options.journal.read(scope));
      if (!same(state.scope, scope) || state.revision < revision)
        throw new Error('Journal scope or revision changed');
      revision = state.revision;
      return state;
    });
  }
  async function commit(before: JournalSnapshot, next: JournalSnapshot) {
    const state = await storage(async () => {
      const checked = JournalSnapshotSchema.parse({ ...next, revision: before.revision + 1 });
      if ((await options.journal.compareAndSwap(scope, before.revision, checked)) !== true) {
        outcome = 'unknown';
        throw new Error('Concurrent journal change');
      }
      return checked;
    });
    revision = state.revision;
    return state;
  }
  function run<T>(operation: () => Promise<T>, recovering = false): Promise<T | ClientProblem> {
    const task = queue.then(async () => {
      outcome = 'unknown';
      uncertain = recovering;
      try {
        guard();
        if (blocked && !recovering) throw blocked;
        return await operation();
      } catch (error) {
        let failure = error;
        try {
          guard();
        } catch (scopeError) {
          failure = scopeError;
        }
        const parsed = ErrorSchema.safeParse(failure);
        return {
          status: outcome,
          error: parsed.success
            ? parsed.data
            : problem('outcome_unknown', 'The outcome requires reconciliation.', true),
        };
      }
    });
    queue = task.then(() => {});
    return task;
  }
  async function send(command: Command, reviewOf?: string): Promise<ClientResult> {
    if (command.clientId !== scope.clientId) return rejected(command, 'access_revoked');
    let state = await load();
    const canonicalInput = canonicalizeValidatedInput(command);
    const ack = state.acknowledgments.find(item => item.reply.commandId === command.commandId);
    const existing = state.intents.find(item => item.command.commandId === command.commandId);
    if (
      (ack && ack.intent.canonicalInput !== canonicalInput) ||
      (existing && existing.canonicalInput !== canonicalInput)
    )
      return rejected(command, 'command_conflict');
    if (ack) {
      if (existing)
        await commit(state, { ...state, intents: state.intents.filter(item => item !== existing) });
      return acknowledged(ack.intent, ack.reply);
    }
    if (!existing && command.type === 'sendMessage') {
      const records = [...state.intents, ...state.acknowledgments.map(item => item.intent)];
      const stale = state.acknowledgments.find(
        item =>
          item.reply.status === 'rejected' &&
          item.reply.error.code === 'stale_revision' &&
          item.intent.command.type === 'sendMessage' &&
          item.intent.command.conversationId === command.conversationId &&
          !records.some(record => record.reviewOf === item.reply.commandId)
      );
      if (stale && reviewOf !== stale.reply.commandId)
        return acknowledged(stale.intent, stale.reply);
      if (reviewOf && !stale) return rejected(command, 'invalid_input');
    }
    if (
      command.type === 'completeClientTool' &&
      !state.executions.some(
        execution => execution.receipt !== null && same(completionCommand(execution), command)
      )
    )
      return rejected(command, 'invalid_input');
    if (reviewOf && command.type !== 'sendMessage') return rejected(command, 'invalid_input');
    const intent = existing ?? { command, canonicalInput, ...(reviewOf ? { reviewOf } : {}) };
    if (!existing) {
      outcome = uncertain ? 'unknown' : 'unsent';
      state = await commit(state, { ...state, intents: [...state.intents, intent] });
    }
    guard();
    uncertain = true;
    outcome = 'unknown';
    const raw = await options.transport.send(scope, CommandSchema.parse(intent.command));
    guard();
    const parsed = CommandReplySchema.safeParse(raw);
    if (!parsed.success || parsed.data.commandId !== command.commandId)
      throw problem('invalid_output', 'Invalid command acknowledgment.');
    const reply = parsed.data;
    state = await commit(state, {
      ...state,
      acknowledgments: [...state.acknowledgments, { intent, reply }],
    });
    await commit(state, {
      ...state,
      intents: state.intents.filter(item => item.command.commandId !== command.commandId),
    });
    return acknowledged(intent, reply);
  }
  async function saveReceipt(execution: ExecutionIntent, raw: unknown) {
    const receipt = ToolOutcomeSchema.safeParse(raw);
    if (!receipt.success) throw problem('invalid_output', 'Invalid execution receipt.');
    const state = await load();
    const stored = state.executions.find(item => executionKey(item) === executionKey(execution));
    if (!stored || !same({ ...stored, receipt: null }, { ...execution, receipt: null })) {
      blocked = problem('storage_unavailable', 'The execution journal changed.', true);
      throw blocked;
    }
    // Another host can reconcile while an executor is returning. Never replace its committed result.
    if (stored.receipt !== null) return stored;
    const settled = { ...stored, receipt: receipt.data };
    await commit(state, {
      ...state,
      executions: state.executions.map(item => (item === stored ? settled : item)),
    });
    return settled;
  }
  async function reconcile(execution: ExecutionIntent): Promise<ClientResult> {
    uncertain = true;
    outcome = 'unknown';
    if (execution.receipt === null) {
      guard();
      const raw = await options.bridge.reconcileReceipt(
        scope,
        ExecutionIntentSchema.parse(execution)
      );
      guard();
      if (raw === null)
        return {
          status: 'unknown',
          error: problem('outcome_unknown', 'Execution has no confirmed receipt.'),
        };
      execution = await saveReceipt(execution, raw);
    }
    return send(completionCommand(execution));
  }
  async function reconcileExecutions(state: JournalSnapshot) {
    const results: ClientResult[] = [];
    // Existing receipts precede evidence queries; neither path calls execute.
    for (const execution of [
      ...state.executions.filter(item => item.receipt !== null),
      ...state.executions.filter(item => item.receipt === null),
    ])
      results.push(await reconcile(execution));
    return results;
  }
  return {
    submit(input: unknown, review?: { reviewedCommandId: string }) {
      const parsed = CommandSchema.safeParse(input);
      const reviewedCommandId = review?.reviewedCommandId;
      return run(() => {
        if (!parsed.success) throw problem('invalid_input', 'Invalid command.');
        return send(parsed.data, reviewedCommandId);
      });
    },
    recover() {
      return run(async () => {
        const state = await load();
        blocked = undefined;
        const results = await reconcileExecutions(state);
        for (const intent of (await load()).intents)
          results.push(await send(intent.command, intent.reviewOf));
        const restored = await load();
        const reviewed = new Set(
          [...restored.intents, ...restored.acknowledgments.map(item => item.intent)].map(
            item => item.reviewOf
          )
        );
        for (const ack of restored.acknowledgments)
          if (
            ack.reply.status === 'rejected' &&
            ack.reply.error.code === 'stale_revision' &&
            !reviewed.has(ack.reply.commandId) &&
            !results.some(
              result => 'command' in result && result.command.commandId === ack.reply.commandId
            )
          )
            results.push(acknowledged(ack.intent, ack.reply));
        return results;
      }, true);
    },
    dispatch(input: unknown) {
      const parsed = ExecutionRequestSchema.safeParse(input);
      return run(async (): Promise<ClientResult> => {
        if (!parsed.success) throw problem('invalid_input', 'Invalid execution request.');
        const validated = ExecutionIntentSchema.safeParse({ ...parsed.data, receipt: null });
        if (!validated.success || validated.data.toolCall.state === 'settled')
          throw problem('invalid_input', 'Invalid execution intent.');
        const execution = validated.data;
        if (
          execution.grant.ownerUserId !== scope.ownerUserId ||
          execution.grant.clientId !== scope.clientId
        )
          throw problem('access_revoked', 'Execution belongs to another scope.');
        let state = await load();
        const existing = state.executions.find(
          item => executionKey(item) === executionKey(execution)
        );
        if (existing) {
          if (
            !same(existing.grant, execution.grant) ||
            !same(existing.toolCall, execution.toolCall)
          )
            throw problem(
              'outcome_unknown',
              'An existing execution cannot change grants or input.'
            );
          for (const stored of state.executions.filter(
            item => item !== existing && item.receipt !== null
          )) {
            const result = await reconcile(stored);
            if (blocksUnrelatedDispatch(result)) return result;
          }
          return reconcile(existing);
        }
        const pending = (await reconcileExecutions(state)).find(blocksUnrelatedDispatch);
        if (pending) return pending;
        state = await load();
        if (
          [...state.intents, ...state.acknowledgments.map(item => item.intent)].some(
            item => item.command.commandId === execution.completionCommandId
          ) ||
          state.executions.some(item => item.completionCommandId === execution.completionCommandId)
        )
          throw problem('invalid_input', 'The completion command ID is already reserved.');
        if (
          execution.grant.inputDigest !==
          (await options.digest(canonicalizeValidatedInput(execution.toolCall.arguments)))
        )
          throw problem('invalid_input', 'Execution input does not match the grant.');
        guard();
        const readiness = () => {
          guard();
          const now = options.now();
          if (!Number.isFinite(now) || Date.parse(execution.grant.expiresAt) <= now)
            throw problem('access_revoked', 'Execution grant expired or clock unavailable.');
          return bridgeWaitReason(options.bridge.readiness(scope, execution));
        };
        const wait = readiness();
        if (wait) return { status: 'waiting', reason: wait };
        outcome = uncertain ? 'unknown' : 'unsent';
        const committed = await commit(state, {
          ...state,
          executions: [...state.executions, execution],
        });
        const changed = readiness();
        if (changed) {
          // Only this live dispatch proves execute was never called. Release its fence atomically;
          // a crash before the release leaves the intent uncertain, never permission to replay.
          await commit(committed, { ...committed, executions: state.executions });
          return { status: 'waiting', reason: changed };
        }
        uncertain = true;
        outcome = 'unknown';
        const raw = await options.bridge.execute(scope, ExecutionIntentSchema.parse(execution));
        guard();
        return reconcile(await saveReceipt(execution, raw));
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
export type HarnessClient = ReturnType<typeof createHarnessClient>;
