import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import {
  canonicalizeValidatedInput,
  commandReplayDecision,
} from '@kilocode/agent-harness/commands';
import {
  ConversationSchema,
  EventCursorSchema,
  EventEnvelopeSchema,
  InteractionSchema,
  LegacyMessageSchema,
  MessageSchema,
  PendingClientActionSchema,
  RunSchema,
  SnapshotSchema,
  ToolCallSchema,
  type ConversationProducer,
  type EventEnvelope,
  type Snapshot,
} from '@kilocode/agent-harness/contracts';
import { CommandReplySchema, type CommandReply } from '@kilocode/agent-harness/journal';
import migrations from '../../drizzle/migrations.js';
import * as s from './sqlite-schema';
import {
  applyEvent,
  conversationRow,
  pageLimit,
  readConversation,
  type StoreDatabase,
} from './records';
import { StoreError, transitionWithWake, type AlarmStorage } from './wake';

const maxPageBytes = 256 * 1024;
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const HistoryCursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });
type Changes = { events: EventEnvelope['event'][]; reply?: CommandReply };
type Transition = { command?: { id: string; fingerprint: string }; wakeAt: number | null };

// Call from the Durable Object constructor's blockConcurrencyWhile, before serving any operation.
export async function openStore(state: DurableObjectState, alarms: AlarmStorage = state.storage) {
  const db = drizzle(state.storage);
  await migrate(db, migrations);

  function appendEvents(inputs: EventEnvelope['event'][], wakeAt: number | null) {
    const meta = conversationRow(db);
    let sequence = meta.sequence;
    for (const input of inputs) {
      const envelope = EventEnvelopeSchema.parse({
        protocolVersion: 1,
        conversationId: meta.id,
        sequence: ++sequence,
        event: input,
      });
      if (
        envelope.event.type === 'run' &&
        ['queued', 'running', 'stopping'].includes(envelope.event.run.state.status) &&
        wakeAt === null
      )
        throw new StoreError('invalid_input');
      // Deployed legacy text has no size cap. Oversized legacy deltas recover through snapshots.
      if (
        byteLength({ status: 'events', events: [envelope] }) > maxPageBytes &&
        (envelope.event.type !== 'message' || envelope.event.message.provenance !== 'legacy')
      )
        throw new StoreError('limit_exceeded');
      applyEvent(db, envelope.event, sequence);
      db.insert(s.events).values({ sequence, data: envelope }).run();
    }
    db.update(s.conversation).set({ sequence }).where(eq(s.conversation.singleton, 1)).run();
    return sequence;
  }
  function history(before: string | null = null, limit = 50) {
    pageLimit(limit);
    let cursor: z.infer<typeof HistoryCursorSchema> | null = null;
    if (before !== null) {
      try {
        cursor = HistoryCursorSchema.parse(
          JSON.parse(atob(before.replace(/-/g, '+').replace(/_/g, '/')))
        );
      } catch {
        throw new StoreError('invalid_input');
      }
    }
    const rows = db
      .select()
      .from(s.messages)
      .where(
        cursor
          ? or(
              lt(s.messages.createdAt, cursor.createdAt),
              and(eq(s.messages.createdAt, cursor.createdAt), lt(s.messages.id, cursor.id))
            )
          : undefined
      )
      .orderBy(desc(s.messages.createdAt), desc(s.messages.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit),
      oldest = page.at(-1);
    return {
      messages: page.reverse().map(row => MessageSchema.parse(row.data)),
      historyCursor:
        rows.length > limit && oldest
          ? btoa(JSON.stringify({ createdAt: oldest.createdAt, id: oldest.id }))
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '')
          : null,
    };
  }
  function buildSnapshot(): Snapshot | null {
    const meta = db.select().from(s.conversation).where(eq(s.conversation.singleton, 1)).get();
    if (!meta) return null;
    const recent = history();
    const queued = db
      .select()
      .from(s.runs)
      .where(eq(s.runs.status, 'queued'))
      .orderBy(asc(s.runs.position))
      .limit(201)
      .all();
    const unresolved = db
      .select()
      .from(s.interactions)
      .where(eq(s.interactions.resolved, false))
      .orderBy(asc(s.interactions.sequence))
      .limit(201)
      .all();
    const actions = db
      .select()
      .from(s.clientActions)
      .orderBy(asc(s.clientActions.sequence))
      .limit(201)
      .all();
    // A bounded snapshot must fail, not silently hide unresolved work.
    if ([queued, unresolved, actions].some(rows => rows.length > 200))
      throw new StoreError('limit_exceeded');
    const current = meta.activeRunId
      ? db.select().from(s.runs).where(eq(s.runs.id, meta.activeRunId)).get()
      : null;
    if (meta.activeRunId && !current) throw new StoreError('invalid_input');
    return SnapshotSchema.parse({
      protocolVersion: 1,
      conversation: readConversation(db),
      recentMessages: recent.messages,
      historyCursor: recent.historyCursor,
      activeRun: current ? RunSchema.parse(current.data) : null,
      queuedRuns: queued.map(row => RunSchema.parse(row.data)),
      unresolvedInteractions: unresolved.map(row => InteractionSchema.parse(row.data)),
      pendingClientActions: actions.map(row => PendingClientActionSchema.parse(row.data)),
      eventCursor: meta.sequence,
    });
  }
  function getCommand(id: string) {
    const row = db
      .select()
      .from(s.commands)
      .where(eq(s.commands.id, z.uuid().parse(id)))
      .get();
    return row
      ? {
          fingerprint: row.fingerprint,
          reply: CommandReplySchema.parse(row.reply),
          sequence: row.sequence,
        }
      : null;
  }
  return {
    // Authority must come from the authenticated PostgreSQL lookup, never a client-selected new ID.
    bindExistingConversation(input: ConversationProducer) {
      const value = ConversationSchema.parse(input);
      return db.transaction(() => {
        const old = db.select().from(s.conversation).where(eq(s.conversation.singleton, 1)).get();
        if (old) {
          if (
            old.id !== value.id ||
            old.ownerUserId !== value.ownerUserId ||
            canonicalizeValidatedInput(old.context) !== canonicalizeValidatedInput(value.context)
          )
            throw new StoreError('invalid_input');
        } else db.insert(s.conversation).values(value).run();
        return readConversation(db);
      });
    },
    getCommand,
    transition(options: Transition, write: (transaction: StoreDatabase) => Changes) {
      return transitionWithWake<CommandReply | undefined>(
        state,
        () => {
          const command = options.command;
          if (command) {
            z.string().min(1).parse(command.fingerprint);
            const prior = getCommand(command.id);
            const decision = commandReplayDecision(prior?.fingerprint, command.fingerprint);
            if (decision === 'replay' && prior) return { value: prior.reply };
            if (decision === 'command_conflict')
              return {
                value: {
                  status: 'rejected',
                  commandId: command.id,
                  error: {
                    code: 'command_conflict',
                    message: 'This command has different stored input.',
                    retryable: false,
                  },
                },
              };
          }
          return {
            wakeAt: options.wakeAt,
            commit: () => {
              const activeRunId = conversationRow(db).activeRunId;
              const changes = write(db);
              const reply = changes.reply ? CommandReplySchema.parse(changes.reply) : undefined;
              if (command && (!reply || reply.commandId !== command.id))
                throw new StoreError('invalid_input');
              const sequence = appendEvents(changes.events, options.wakeAt);
              // Include callback writes: releasing the active run can make the existing queue runnable.
              if (
                options.wakeAt === null &&
                activeRunId !== null &&
                conversationRow(db).activeRunId === null &&
                db
                  .select({ id: s.runs.id })
                  .from(s.runs)
                  .where(eq(s.runs.status, 'queued'))
                  .limit(1)
                  .get()
              )
                throw new StoreError('invalid_input');
              if (command)
                db.insert(s.commands)
                  .values({ id: command.id, fingerprint: command.fingerprint, reply, sequence })
                  .run();
              return reply;
            },
          };
        },
        alarms
      );
    },
    snapshot: () => db.transaction(buildSnapshot),
    history,
    eventsAfter(after: number, limit = 200) {
      EventCursorSchema.parse(after);
      pageLimit(limit);
      return db.transaction(() => {
        const meta = conversationRow(db);
        if (after < meta.compactedThrough || after > meta.sequence)
          return { status: 'cursor_expired' } as const;
        const page: EventEnvelope[] = [];
        let bytes = byteLength({ status: 'events', events: page }),
          cursor = after;
        // Read at most one extra record, rather than loading 200 maximum-size records into memory.
        for (let count = 0; count < limit; count++) {
          const row = db
            .select()
            .from(s.events)
            .where(gt(s.events.sequence, cursor))
            .orderBy(asc(s.events.sequence))
            .limit(1)
            .get();
          if (!row) break;
          const event = EventEnvelopeSchema.parse(row.data);
          const size = byteLength(event) + (page.length ? 1 : 0);
          if (bytes + size > maxPageBytes) {
            if (!page.length) return { status: 'cursor_expired' } as const;
            break;
          }
          page.push(event);
          bytes += size;
          cursor = event.sequence;
        }
        return { status: 'events', events: page } as const;
      });
    },
    queuedRuns(afterPosition = 0, limit = 200) {
      EventCursorSchema.parse(afterPosition);
      return db
        .select()
        .from(s.runs)
        .where(and(eq(s.runs.status, 'queued'), gt(s.runs.position, afterPosition)))
        .orderBy(asc(s.runs.position))
        .limit(pageLimit(limit))
        .all()
        .map(row => ({ ...row, data: RunSchema.parse(row.data) }));
    },
    callsForRun(runId: string, afterPosition = -1, limit = 200) {
      z.int().min(-1).parse(afterPosition);
      return db
        .select()
        .from(s.calls)
        .where(and(eq(s.calls.runId, z.uuid().parse(runId)), gt(s.calls.position, afterPosition)))
        .orderBy(asc(s.calls.position))
        .limit(pageLimit(limit))
        .all()
        .map(row => ({
          ...row,
          data: ToolCallSchema.parse(row.data),
          policy: z.json().parse(row.policy),
        }));
    },
    compactEvents(limit = 200) {
      pageLimit(limit);
      return db.transaction(() => {
        const snapshot = buildSnapshot();
        if (!snapshot) return 0;
        const rows = db
          .select({ sequence: s.events.sequence })
          .from(s.events)
          .where(lte(s.events.sequence, snapshot.eventCursor))
          .orderBy(asc(s.events.sequence))
          .limit(limit)
          .all();
        const last = rows.at(-1);
        if (!last) return 0;
        db.insert(s.snapshots)
          .values({ cursor: snapshot.eventCursor, data: snapshot })
          .onConflictDoUpdate({
            target: s.snapshots.singleton,
            set: { cursor: snapshot.eventCursor, data: snapshot },
          })
          .run();
        db.delete(s.events)
          .where(
            inArray(
              s.events.sequence,
              rows.map(row => row.sequence)
            )
          )
          .run();
        db.update(s.conversation)
          .set({ compactedThrough: last.sequence })
          .where(eq(s.conversation.singleton, 1))
          .run();
        // Keep original commands, canonical messages/parts, checkpoints, and unresolved records.
        return rows.length;
      });
    },
    importLegacy(input: unknown, appendSequence: number) {
      const message = LegacyMessageSchema.parse(input);
      EventCursorSchema.positive().parse(appendSequence);
      return transitionWithWake(
        state,
        () => ({
          wakeAt: null,
          commit: () => {
            const meta = conversationRow(db);
            const exists = db
              .select({ id: s.messages.id })
              .from(s.messages)
              .where(eq(s.messages.id, message.id))
              .get();
            if (!exists) appendEvents([{ type: 'message', message }], null);
            db.update(s.conversation)
              .set({ legacyCursor: Math.max(meta.legacyCursor, appendSequence) })
              .where(eq(s.conversation.singleton, 1))
              .run();
            return !exists;
          },
        }),
        alarms
      );
    },
    pendingProjections(now: number, limit = 200) {
      z.int().nonnegative().parse(now);
      return db
        .select()
        .from(s.projectionWork)
        .where(and(isNull(s.projectionWork.acknowledgedAt), lte(s.projectionWork.dueAt, now)))
        .orderBy(asc(s.projectionWork.dueAt), asc(s.projectionWork.id))
        .limit(pageLimit(limit))
        .all()
        .map(row => ({ ...row, data: z.json().parse(row.data) }));
    },
    acknowledgeProjection(id: string, revision: number, acknowledgedAt: string) {
      z.int().nonnegative().parse(revision);
      z.iso.datetime().parse(acknowledgedAt);
      return db.transaction(() =>
        Boolean(
          db
            .update(s.projectionWork)
            .set({ acknowledgedAt, revision: sql`${s.projectionWork.revision} + 1` })
            .where(
              and(
                eq(s.projectionWork.id, id),
                eq(s.projectionWork.revision, revision),
                isNull(s.projectionWork.acknowledgedAt)
              )
            )
            .returning({ id: s.projectionWork.id })
            .get()
        )
      );
    },
  };
}
export type ConversationStore = Awaited<ReturnType<typeof openStore>>;
