import { count, max, eq, and, gt, gte, lte, lt, inArray, asc } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { StoredEvent } from '../../websocket/types.js';
import type { EventId } from '../../types/ids.js';
import { events } from '../../db/sqlite-schema.js';
import type { SQL } from 'drizzle-orm';

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
  /** Exclusive: id > fromId */
  fromId?: EventId;
  /** Only return events for these execution IDs */
  executionIds?: string[];
  /** Only return events of these types */
  eventTypes?: string[];
  /** Inclusive: timestamp >= startTime */
  startTime?: number;
  /** Inclusive: timestamp <= endTime */
  endTime?: number;
  /** Maximum number of events to return */
  limit?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConditions(filters: Omit<EventQueryFilters, 'limit'>): SQL[] {
  const conditions: SQL[] = [];

  if (filters.fromId !== undefined) {
    conditions.push(gt(events.id, filters.fromId));
  }
  if (filters.executionIds?.length) {
    conditions.push(inArray(events.execution_id, filters.executionIds));
  }
  if (filters.eventTypes?.length) {
    conditions.push(inArray(events.stream_event_type, filters.eventTypes));
  }
  if (filters.startTime !== undefined) {
    conditions.push(gte(events.timestamp, filters.startTime));
  }
  if (filters.endTime !== undefined) {
    conditions.push(lte(events.timestamp, filters.endTime));
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

export function createEventQueries(db: DrizzleSqliteDODatabase, rawSql: SqlStorage) {
  return {
    insert(params: InsertEventParams): EventId {
      const row = db
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

      return row.id;
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
    *iterateByFilters(filters: Omit<EventQueryFilters, 'limit'>): Generator<StoredEvent> {
      const conditions = buildConditions(filters);
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const { sql: query, params } = db
        .select()
        .from(events)
        .where(where)
        .orderBy(asc(events.id))
        .toSQL();
      const cursor = rawSql.exec(query, ...params);
      for (const row of cursor) {
        // rawSql.exec yields Record<string, SqlStorageValue>; narrow each field
        // explicitly rather than a blanket `as` cast on the whole row object.
        yield {
          id: row.id as number,
          execution_id: row.execution_id as string,
          session_id: row.session_id as string,
          stream_event_type: row.stream_event_type as string,
          payload: row.payload as string,
          timestamp: row.timestamp as number,
        } satisfies StoredEvent;
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
      const row = db
        .select({ count: count() })
        .from(events)
        .where(eq(events.execution_id, executionId))
        .get();

      return row?.count ?? 0;
    },

    getLatestEventId(): EventId | null {
      const row = db
        .select({ maxId: max(events.id) })
        .from(events)
        .get();
      return row?.maxId ?? null;
    },
  };
}

export type EventQueries = ReturnType<typeof createEventQueries>;
