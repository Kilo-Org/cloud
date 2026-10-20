import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  max,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import {
  createEventQueries,
  prefixUpperBound,
  type EventQueryFilters,
  type InsertEventParams,
  type UpsertEventParams,
} from '../../session/queries/events.js';
import type { StoredEvent } from '../../websocket/types.js';
import { eventMutationCursor, events } from './sqlite-schema.js';

const columns = {
  id: events.id,
  execution_id: events.execution_id,
  session_id: events.session_id,
  stream_event_type: events.stream_event_type,
  payload: events.payload,
  timestamp: events.timestamp,
  mutation_cursor: events.mutation_cursor,
};

function conditions(filters: EventQueryFilters): SQL[] {
  const result: SQL[] = [];
  if (filters.fromId !== undefined) result.push(gt(events.id, filters.fromId));
  if (filters.toId !== undefined) result.push(lte(events.id, filters.toId));
  if (filters.afterCursor !== undefined)
    result.push(gt(events.mutation_cursor, filters.afterCursor));
  if (filters.throughCursor !== undefined)
    result.push(lte(events.mutation_cursor, filters.throughCursor));
  if (filters.executionIds?.length) result.push(inArray(events.execution_id, filters.executionIds));
  if (filters.eventTypes?.length)
    result.push(inArray(events.stream_event_type, filters.eventTypes));
  if (filters.startTime !== undefined) result.push(gte(events.timestamp, filters.startTime));
  if (filters.endTime !== undefined) result.push(lte(events.timestamp, filters.endTime));
  if (filters.materialized) {
    result.push(
      eq(events.stream_event_type, 'kilocode'),
      inArray(
        sql<string>`json_extract(${events.payload}, '$.event')`,
        filters.materialized === 'updates'
          ? ['message.updated', 'message.part.updated', 'autocommit_completed']
          : ['message.removed', 'message.part.removed']
      )
    );
  }
  return result;
}

export function createSessionEventQueries(
  db: DrizzleSqliteDODatabase,
  storage: DurableObjectStorage
) {
  const read = (filters: EventQueryFilters) =>
    db
      .select(columns)
      .from(events)
      .where(and(...conditions(filters)))
      .orderBy(filters.afterCursor === undefined ? asc(events.id) : asc(events.mutation_cursor))
      .$dynamic();

  const write = (params: InsertEventParams & { entityId?: string }, unique: boolean) =>
    storage.transactionSync(() => {
      if (unique && params.entityId !== undefined) {
        const existing = db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.entity_id, params.entityId))
          .get();
        if (existing !== undefined) return null;
      }
      const { cursor } = db
        .insert(eventMutationCursor)
        .values({ id: 1, cursor: 1 })
        .onConflictDoUpdate({
          target: eventMutationCursor.id,
          set: { cursor: sql`${eventMutationCursor.cursor} + 1` },
        })
        .returning({ cursor: eventMutationCursor.cursor })
        .get();
      if (!Number.isSafeInteger(cursor)) throw new Error('Session mutation cursor exhausted');
      return db
        .insert(events)
        .values({
          execution_id: params.executionId,
          session_id: params.sessionId,
          stream_event_type: params.streamEventType,
          payload: params.payload,
          timestamp: params.timestamp,
          entity_id: params.entityId,
          mutation_cursor: cursor,
        })
        .onConflictDoUpdate({
          target: events.entity_id,
          set: { payload: params.payload, timestamp: params.timestamp, mutation_cursor: cursor },
        })
        .returning({ id: events.id })
        .get().id;
    });

  return {
    ...createEventQueries(db, storage.sql),
    insert(params: InsertEventParams): number {
      const id = write(params, false);
      if (id === null) throw new Error('Event insert failed');
      return id;
    },
    upsert(params: UpsertEventParams): number {
      const id = write(params, false);
      if (id === null) throw new Error('Event upsert failed');
      return id;
    },
    insertUnique(params: UpsertEventParams): number | null {
      return write(params, true);
    },
    findById(id: number): StoredEvent | null {
      return db.select(columns).from(events).where(eq(events.id, id)).get() ?? null;
    },
    findByEntityId(entityId: string): StoredEvent | null {
      return db.select(columns).from(events).where(eq(events.entity_id, entityId)).get() ?? null;
    },
    findByEntityPrefix(prefix: string): StoredEvent[] {
      const upper = prefixUpperBound(prefix);
      return db
        .select(columns)
        .from(events)
        .where(
          and(
            gte(events.entity_id, prefix),
            upper === null ? undefined : lt(events.entity_id, upper)
          )
        )
        .orderBy(asc(events.entity_id), asc(events.id))
        .all();
    },
    findByFilters(filters: EventQueryFilters): StoredEvent[] {
      const query = read(filters);
      return (filters.limit === undefined ? query : query.limit(filters.limit)).all();
    },
    *iterateByFilters(filters: Omit<EventQueryFilters, 'limit'>): Generator<StoredEvent> {
      const query = read(filters).toSQL();
      for (const row of storage.sql.exec<StoredEvent & Record<string, SqlStorageValue>>(
        query.sql,
        ...query.params
      )) {
        yield row;
      }
    },
    getUpdateCursor(): number {
      return (
        db
          .select({ cursor: eventMutationCursor.cursor })
          .from(eventMutationCursor)
          .where(eq(eventMutationCursor.id, 1))
          .get()?.cursor ?? 0
      );
    },
    getLatestEventId(): number | null {
      return (
        db
          .select({ id: max(events.id) })
          .from(events)
          .get()?.id ?? null
      );
    },
    getLatestNativeStatus(kiloSessionId: string): StoredEvent | null {
      return (
        db
          .select(columns)
          .from(events)
          .where(
            and(
              eq(events.stream_event_type, 'kilocode'),
              eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'session.status'),
              eq(
                sql<string>`json_extract(${events.payload}, '$.properties.sessionID')`,
                kiloSessionId
              )
            )
          )
          .orderBy(desc(events.mutation_cursor), desc(events.id))
          .limit(1)
          .get() ?? null
      );
    },
    getTotalCostMicrodollars(sessionId: string, kiloSessionId: string): number {
      const cost = sql<number>`coalesce(sum(case when json_type(${events.payload}, '$.properties.info.cost') in ('integer', 'real') then max(0, json_extract(${events.payload}, '$.properties.info.cost')) else 0 end), 0)`;
      const dollars =
        db
          .select({ cost })
          .from(events)
          .where(
            and(
              eq(events.session_id, sessionId),
              eq(events.stream_event_type, 'kilocode'),
              eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'message.updated'),
              eq(
                sql<string>`json_extract(${events.payload}, '$.properties.info.sessionID')`,
                kiloSessionId
              ),
              eq(
                sql<string>`json_extract(${events.payload}, '$.properties.info.role')`,
                'assistant'
              )
            )
          )
          .get()?.cost ?? 0;
      return Number.isFinite(dollars)
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(dollars * 1_000_000)))
        : 0;
    },
    readAncillaryBootstrap(
      maximumBytes = 1_048_576,
      limit = 100
    ): { events: StoredEvent[]; omittedItemCount: number } {
      const commit = and(
        eq(events.stream_event_type, 'kilocode'),
        gte(events.entity_id, 'commit/'),
        lt(events.entity_id, 'commit0'),
        eq(sql<string>`json_extract(${events.payload}, '$.event')`, 'autocommit_completed')
      );
      const total = db.select({ count: count() }).from(events).where(commit).get()?.count ?? 0;
      const candidates = db
        .select({ id: events.id, bytes: sql<number>`length(cast(${events.payload} as blob))` })
        .from(events)
        .where(commit)
        .orderBy(desc(events.timestamp), desc(events.id))
        .limit(limit)
        .all();
      const result: StoredEvent[] = [];
      let bytes = 0;
      for (const candidate of candidates) {
        if (bytes + candidate.bytes + 512 > maximumBytes) continue;
        const row = db.select(columns).from(events).where(eq(events.id, candidate.id)).get();
        if (row === undefined) continue;
        bytes += candidate.bytes + 512;
        result.push(row);
      }
      return { events: result.reverse(), omittedItemCount: total - result.length };
    },
  };
}

export type SessionEventQueries = ReturnType<typeof createSessionEventQueries>;
