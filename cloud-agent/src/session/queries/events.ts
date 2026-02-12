/**
 * Event queries module for CloudAgentSession Durable Object.
 *
 * Provides type-safe SQL operations for storing and retrieving
 * execution events from SQLite storage.
 */

import type { StoredEvent } from '../../websocket/types.js';
import type { EventId } from '../../types/ids.js';
import { events, EventRecord, CountResult, MaxIdResult } from '../../db/tables/index.js';
import { pushInClause, pushCondition, buildWhereClause } from '../../utils/sql-helpers.js';

type SqlStorage = DurableObjectState['storage']['sql'];

// Destructure for convenient access to columns
const { columns: cols } = events;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for inserting a new event */
export type InsertEventParams = {
  executionId: string;
  sessionId: string;
  streamEventType: string;
  payload: string; // JSON stringified
  timestamp: number;
};

/** Query filters for finding events */
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

/** Build the base SELECT query and args from filters (without LIMIT). */
function buildEventFilterQuery(filters: Omit<EventQueryFilters, 'limit'>): {
  query: string;
  args: unknown[];
} {
  const conditions: string[] = [];
  const args: unknown[] = [];

  pushCondition(conditions, args, `${events.id}`, '>', filters.fromId);
  pushInClause(conditions, args, `${events.execution_id}`, filters.executionIds);
  pushInClause(conditions, args, `${events.stream_event_type}`, filters.eventTypes);
  pushCondition(conditions, args, `${events.timestamp}`, '>=', filters.startTime);
  pushCondition(conditions, args, `${events.timestamp}`, '<=', filters.endTime);

  let query = `SELECT ${events.id}, ${events.execution_id}, ${events.session_id}, ${events.stream_event_type}, ${events.payload}, ${events.timestamp} FROM ${events}`;
  query += buildWhereClause(conditions);
  query += ` ORDER BY ${events.id} ASC`;

  return { query, args };
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create event queries for the CloudAgentSession Durable Object.
 *
 * @param sql - SqlStorage instance from the DO context
 * @returns Object with event query methods
 */
export function createEventQueries(sql: SqlStorage) {
  return {
    /**
     * Insert a new event, returning the auto-generated ID.
     *
     * @param params - Event data to insert
     * @returns The auto-generated event ID
     */
    insert(params: InsertEventParams): EventId {
      const result = sql.exec(
        `INSERT INTO ${events} (${cols.execution_id}, ${cols.session_id}, ${cols.stream_event_type}, ${cols.payload}, ${cols.timestamp})
         VALUES (?, ?, ?, ?, ?)
         RETURNING ${cols.id}`,
        params.executionId,
        params.sessionId,
        params.streamEventType,
        params.payload,
        params.timestamp
      );

      const row = [...result][0];
      return EventRecord.pick({ id: true }).parse(row).id;
    },

    /**
     * Find events by filters with pagination.
     * Results are ordered by ID ascending.
     *
     * @param filters - Query filters to apply
     * @returns Array of stored events matching the filters
     */
    findByFilters(filters: EventQueryFilters): StoredEvent[] {
      const { query, args } = buildEventFilterQuery(filters);

      let finalQuery = query;
      if (filters.limit !== undefined) {
        finalQuery += ' LIMIT ?';
        args.push(filters.limit);
      }

      const result = sql.exec(finalQuery, ...args);
      return [...result].map(row => EventRecord.parse(row) as StoredEvent);
    },

    /**
     * Lazily iterate events by filters, yielding one row at a time.
     *
     * Unlike findByFilters, this does not materialize all matching rows
     * into an array. The underlying SqlStorageCursor is consumed lazily,
     * so breaking out of iteration stops reading from SQLite.
     * No LIMIT clause is applied -- the caller controls how far to iterate.
     *
     * @param filters - Query filters to apply (limit field is ignored)
     */
    *iterateByFilters(filters: Omit<EventQueryFilters, 'limit'>): Generator<StoredEvent> {
      const { query, args } = buildEventFilterQuery(filters);
      const cursor = sql.exec(query, ...args);
      for (const row of cursor) {
        yield EventRecord.parse(row) as StoredEvent;
      }
    },

    /**
     * Delete events older than a given timestamp.
     *
     * @param timestamp - Unix timestamp threshold
     * @returns Number of events deleted
     */
    deleteOlderThan(timestamp: number): number {
      const result = sql.exec(`DELETE FROM ${events} WHERE ${events.timestamp} < ?`, timestamp);
      return result.rowsWritten;
    },

    /**
     * Get event count for an execution.
     *
     * @param executionId - Execution ID to count events for
     * @returns Number of events for the execution
     */
    countByExecutionId(executionId: string): number {
      const result = sql.exec(
        `SELECT COUNT(*) as count FROM ${events} WHERE ${events.execution_id} = ?`,
        executionId
      );
      const row = [...result][0];
      if (!row) return 0;
      return CountResult.parse(row).count;
    },

    /**
     * Get the latest event ID (for tracking).
     *
     * @returns The highest event ID, or null if no events exist
     */
    getLatestEventId(): EventId | null {
      const result = sql.exec(`SELECT MAX(${cols.id}) as max_id FROM ${events}`);
      const row = [...result][0];
      if (!row) return null;
      const parsed = MaxIdResult.parse(row);
      return parsed.max_id !== null ? parsed.max_id : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Type Export
// ---------------------------------------------------------------------------

/** Type of the event queries object returned by createEventQueries */
export type EventQueries = ReturnType<typeof createEventQueries>;
