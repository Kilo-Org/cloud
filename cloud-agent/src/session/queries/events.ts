import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { eq, gt, gte, lte, lt, inArray, and, asc, count, max } from 'drizzle-orm';
import { events } from '../../db/sqlite-schema.js';
import type { StoredEvent } from '../../websocket/types.js';
import type { EventId } from '../../types/ids.js';

type SqlStorage = DurableObjectState['storage']['sql'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsertEventParams = {
  executionId: string;
  sessionId: string;
  streamEventType: string;
  payload: string;
  timestamp: number;
};

export type EventQueryFilters = {
  fromId?: EventId;
  executionIds?: string[];
  eventTypes?: string[];
  startTime?: number;
  endTime?: number;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConditions(filters: Omit<EventQueryFilters, 'limit'>) {
  const conditions = [];
  if (filters.fromId !== undefined) conditions.push(gt(events.id, filters.fromId));
  if (filters.executionIds?.length)
    conditions.push(inArray(events.execution_id, filters.executionIds));
  if (filters.eventTypes?.length)
    conditions.push(inArray(events.stream_event_type, filters.eventTypes));
  if (filters.startTime !== undefined) conditions.push(gte(events.timestamp, filters.startTime));
  if (filters.endTime !== undefined) conditions.push(lte(events.timestamp, filters.endTime));
  return conditions;
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

export function createEventQueries(db: DrizzleSqliteDODatabase, rawSql: SqlStorage) {
  return {
    insert(params: InsertEventParams): EventId {
      const result = db
        .insert(events)
        .values({
          execution_id: params.executionId,
          session_id: params.sessionId,
          stream_event_type: params.streamEventType,
          payload: params.payload,
          timestamp: params.timestamp,
        })
        .returning({ id: events.id })
        .get();
      return result.id;
    },

    findByFilters(filters: EventQueryFilters): StoredEvent[] {
      const conditions = buildConditions(filters);
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      let query = db.select().from(events).where(where).orderBy(asc(events.id)).$dynamic();

      if (filters.limit !== undefined) {
        query = query.limit(filters.limit);
      }

      return query.all() satisfies StoredEvent[];
    },

    // Uses toSQL() + raw exec() for true lazy cursor-based iteration.
    // Drizzle's durable-sqlite .all() materializes everything; the raw
    // SqlStorageCursor lets callers break early without loading all rows.
    // The cursor returns plain objects whose shape is guaranteed to match
    // StoredEvent because the SELECT list is generated from the same Drizzle
    // schema columns — no runtime coercion is needed beyond the type annotation.
    *iterateByFilters(filters: Omit<EventQueryFilters, 'limit'>): Generator<StoredEvent> {
      const conditions = buildConditions(filters);
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const { sql: query, params } = db
        .select()
        .from(events)
        .where(where)
        .orderBy(asc(events.id))
        .toSQL();
      const cursor = rawSql.exec<StoredEvent>(query, ...params);
      for (const row of cursor) {
        yield row;
      }
    },

    deleteOlderThan(timestamp: number): number {
      const { sql: query, params } = db
        .delete(events)
        .where(lt(events.timestamp, timestamp))
        .toSQL();
      return rawSql.exec(query, ...params).rowsWritten;
    },

    countByExecutionId(executionId: string): number {
      const result = db
        .select({ count: count() })
        .from(events)
        .where(eq(events.execution_id, executionId))
        .get();
      return result?.count ?? 0;
    },

    getLatestEventId(): EventId | null {
      const result = db
        .select({ maxId: max(events.id) })
        .from(events)
        .get();
      return result?.maxId ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Type Export
// ---------------------------------------------------------------------------

export type EventQueries = ReturnType<typeof createEventQueries>;
