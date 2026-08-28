import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';
import { canonicalizeValidatedInput } from '@kilocode/agent-harness/commands';
import {
  ConversationSchema,
  ExecutionGrantSchema,
  InteractionSchema,
  MessageSchema,
  RunSchema,
  ToolCallSchema,
  type EventEnvelope,
  type ToolCall,
} from '@kilocode/agent-harness/contracts';
import * as s from './sqlite-schema';
import { StoreError } from './wake';

export type StoreDatabase = DrizzleSqliteDODatabase;
export const pageLimit = (limit: number) => z.int().min(1).max(200).parse(limit);
const same = (left: unknown, right: unknown) =>
  canonicalizeValidatedInput(left) === canonicalizeValidatedInput(right);
const active = (status: string) => ['running', 'waiting', 'stopping'].includes(status);

export function conversationRow(db: StoreDatabase) {
  const row = db.select().from(s.conversation).where(eq(s.conversation.singleton, 1)).get();
  if (!row) throw new StoreError('invalid_input');
  return row;
}
export function readConversation(db: StoreDatabase) {
  const { id, ownerUserId, context, permissionMode, permissionRevision } = conversationRow(db);
  return ConversationSchema.parse({ id, ownerUserId, context, permissionMode, permissionRevision });
}
export function compareAndSetActiveRun(
  db: StoreDatabase,
  expected: string | null,
  next: string | null
) {
  return Boolean(
    db
      .update(s.conversation)
      .set({ activeRunId: next })
      .where(
        and(
          eq(s.conversation.singleton, 1),
          expected === null
            ? isNull(s.conversation.activeRunId)
            : eq(s.conversation.activeRunId, expected)
        )
      )
      .returning({ id: s.conversation.id })
      .get()
  );
}

// Materialized state and replay deltas always share the caller's synchronous transaction.
export function applyEvent(db: StoreDatabase, event: EventEnvelope['event'], sequence: number) {
  switch (event.type) {
    case 'conversation': {
      const current = readConversation(db),
        next = event.conversation;
      if (
        current.id !== next.id ||
        current.ownerUserId !== next.ownerUserId ||
        !same(current.context, next.context)
      )
        throw new StoreError('invalid_input');
      if (!same(current, next) && next.permissionRevision !== current.permissionRevision + 1)
        throw new StoreError('command_conflict');
      db.update(s.conversation)
        .set({ permissionMode: next.permissionMode, permissionRevision: next.permissionRevision })
        .where(eq(s.conversation.singleton, 1))
        .run();
      break;
    }
    case 'message': {
      const message = event.message;
      const old = db.select().from(s.messages).where(eq(s.messages.id, message.id)).get();
      if (old) {
        const prior = MessageSchema.parse(old.data);
        if (
          prior.createdAt !== message.createdAt ||
          prior.role !== message.role ||
          prior.provenance !== message.provenance ||
          ('runId' in prior && (!('runId' in message) || prior.runId !== message.runId))
        )
          throw new StoreError('invalid_input');
      }
      db.insert(s.messages)
        .values({ id: message.id, createdAt: message.createdAt, sequence, data: message })
        .onConflictDoUpdate({ target: s.messages.id, set: { data: message } })
        .run();
      break;
    }
    case 'run': {
      const run = event.run,
        meta = conversationRow(db);
      if (run.conversationId !== meta.id) throw new StoreError('invalid_input');
      const old = db.select().from(s.runs).where(eq(s.runs.id, run.id)).get();
      if (old) {
        const prior = RunSchema.parse(old.data);
        if (!same({ ...prior, state: null }, { ...run, state: null }))
          throw new StoreError('invalid_input');
        if (
          ['completed', 'cancelled', 'failed'].includes(prior.state.status) &&
          !same(prior.state, run.state)
        )
          throw new StoreError('command_conflict');
      } else if (run.state.status !== 'queued') throw new StoreError('invalid_input');
      const position = old?.position ?? sequence;
      if (active(run.state.status)) {
        if (meta.activeRunId !== null && meta.activeRunId !== run.id)
          throw new StoreError('command_conflict');
        const earlier = db
          .select({ id: s.runs.id })
          .from(s.runs)
          .where(and(eq(s.runs.status, 'queued'), lt(s.runs.position, position)))
          .orderBy(asc(s.runs.position))
          .limit(1)
          .get();
        if (earlier) throw new StoreError('command_conflict');
        if (!compareAndSetActiveRun(db, meta.activeRunId, run.id))
          throw new StoreError('command_conflict');
      } else if (meta.activeRunId === run.id) {
        if (!compareAndSetActiveRun(db, run.id, null)) throw new StoreError('command_conflict');
      }
      const values = {
        status: run.state.status,
        data: run,
        activeSlot: active(run.state.status) ? 1 : null,
        revision: old ? old.revision + 1 : 0,
      };
      db.insert(s.runs)
        .values({ id: run.id, position, ...values })
        .onConflictDoUpdate({ target: s.runs.id, set: values })
        .run();
      break;
    }
    case 'interaction': {
      const interaction = event.interaction;
      const old = db
        .select()
        .from(s.interactions)
        .where(eq(s.interactions.id, interaction.id))
        .get();
      if (old) {
        const prior = InteractionSchema.parse(old.data);
        if (
          !same(
            { ...prior, resolution: null, toolCall: null },
            { ...interaction, resolution: null, toolCall: null }
          ) ||
          !same(callIdentity(prior.toolCall), callIdentity(interaction.toolCall))
        )
          throw new StoreError('invalid_input');
        if (prior.resolution !== null && !same(prior.resolution, interaction.resolution))
          throw new StoreError('command_conflict');
      }
      const values = { data: interaction, resolved: interaction.resolution !== null };
      db.insert(s.interactions)
        .values({ id: interaction.id, sequence, ...values })
        .onConflictDoUpdate({ target: s.interactions.id, set: values })
        .run();
      break;
    }
    case 'client_action':
      if (event.action) {
        if (event.toolCallId !== event.action.toolCall.id) throw new StoreError('invalid_input');
        db.insert(s.clientActions)
          .values({ toolCallId: event.toolCallId, sequence, data: event.action })
          .onConflictDoUpdate({ target: s.clientActions.toolCallId, set: { data: event.action } })
          .run();
      } else
        db.delete(s.clientActions).where(eq(s.clientActions.toolCallId, event.toolCallId)).run();
  }
}

function callIdentity(call: ToolCall) {
  const { state: _state, result: _result, approval: _approval, ...identity } = call;
  return identity;
}
const CheckpointSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  step: z.int().nonnegative(),
  status: z.enum(['partial', 'complete', 'failed']),
  data: z.json(),
  definitionVersions: z.record(z.string(), z.string().min(1)),
});
export function insertCheckpoint(db: StoreDatabase, input: z.input<typeof CheckpointSchema>) {
  db.insert(s.checkpoints).values(CheckpointSchema.parse(input)).run();
}
export function executableCheckpoint(db: StoreDatabase, id: string) {
  const row = db
    .select()
    .from(s.checkpoints)
    .where(and(eq(s.checkpoints.id, id), eq(s.checkpoints.status, 'complete')))
    .get();
  return row ? CheckpointSchema.parse(row) : null;
}
export function insertCall(
  db: StoreDatabase,
  input: ToolCall,
  details: { checkpointId: string; inputDigest: string; position: number; policy: unknown }
) {
  const call = ToolCallSchema.parse(input),
    checkpoint = executableCheckpoint(db, details.checkpointId);
  if (
    !checkpoint ||
    checkpoint.runId !== call.runId ||
    !same(call.context, readConversation(db).context) ||
    checkpoint.definitionVersions[call.name] !== call.definitionVersion ||
    !['pending', 'waiting'].includes(call.state)
  )
    throw new StoreError('invalid_input');
  db.insert(s.calls)
    .values({
      id: call.id,
      runId: call.runId,
      checkpointId: checkpoint.id,
      inputDigest: z.string().min(1).parse(details.inputDigest),
      position: z.int().nonnegative().parse(details.position),
      policy: z.json().parse(details.policy),
      data: call,
      state: call.state,
    })
    .run();
}
export function insertGrant(db: StoreDatabase, input: unknown) {
  const grant = ExecutionGrantSchema.parse(input);
  const stored = db.select().from(s.calls).where(eq(s.calls.id, grant.toolCallId)).get();
  const scope = readConversation(db);
  if (!stored) throw new StoreError('invalid_input');
  const call = ToolCallSchema.parse(stored.data);
  if (
    grant.conversationId !== scope.id ||
    grant.ownerUserId !== scope.ownerUserId ||
    !same(grant.context, call.context) ||
    grant.definitionVersion !== call.definitionVersion ||
    grant.inputDigest !== stored.inputDigest ||
    call.executionTarget.kind !== 'client' ||
    call.executionTarget.clientId !== grant.clientId
  )
    throw new StoreError('invalid_input');
  db.insert(s.grants)
    .values({
      id: grant.id,
      toolCallId: grant.toolCallId,
      generation: grant.generation,
      data: grant,
    })
    .run();
}
export function insertAttempt(
  db: StoreDatabase,
  input: { id: string; toolCallId: string; generation: number; grantId?: string }
) {
  const row = db.select().from(s.calls).where(eq(s.calls.id, input.toolCallId)).get();
  if (!row || !executableCheckpoint(db, row.checkpointId)) throw new StoreError('invalid_input');
  const call = ToolCallSchema.parse(row.data);
  const storedGrant = input.grantId
    ? db.select().from(s.grants).where(eq(s.grants.id, input.grantId)).get()
    : undefined;
  const grant = storedGrant ? ExecutionGrantSchema.parse(storedGrant.data) : null;
  if (
    (input.grantId && !grant) ||
    (grant && (grant.toolCallId !== call.id || grant.generation !== input.generation))
  )
    throw new StoreError('invalid_input');
  if (call.executionTarget.kind === 'client' && !grant) throw new StoreError('invalid_input');
  db.insert(s.attempts)
    .values({
      id: z.uuid().parse(input.id),
      toolCallId: call.id,
      generation: z.int().nonnegative().parse(input.generation),
      intent: {
        toolCall: call,
        inputDigest: row.inputDigest,
        policy: z.json().parse(row.policy),
        grant,
      },
    })
    .run();
}
export function compareAndSetCall(
  db: StoreDatabase,
  id: string,
  revision: number,
  changes: Pick<ToolCall, 'state' | 'approval' | 'result'>
) {
  const row = db
    .select()
    .from(s.calls)
    .where(and(eq(s.calls.id, id), eq(s.calls.revision, revision)))
    .get();
  if (!row) return false;
  const old = ToolCallSchema.parse(row.data),
    call = ToolCallSchema.parse({ ...old, ...changes });
  if (!same(callIdentity(old), callIdentity(call)) || old.state === 'settled')
    throw new StoreError('invalid_input');
  if (
    call.state === 'executing' &&
    !db
      .select({ id: s.attempts.id })
      .from(s.attempts)
      .where(eq(s.attempts.toolCallId, id))
      .limit(1)
      .get()
  )
    throw new StoreError('invalid_input');
  return Boolean(
    db
      .update(s.calls)
      .set({ data: call, state: call.state, revision: sql`${s.calls.revision} + 1` })
      .where(and(eq(s.calls.id, id), eq(s.calls.revision, revision)))
      .returning({ id: s.calls.id })
      .get()
  );
}
