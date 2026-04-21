import { count, max, eq, and, gt, gte, lte, lt, inArray, asc } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import * as z from 'zod';
import type { StoredEvent } from '../../websocket/types.js';
import type { EventId } from '../../types/ids.js';
import type { AssistantMessagePart, LatestAssistantMessage } from '../types.js';
import { events } from '../../db/sqlite-schema.js';
import type { SQL } from 'drizzle-orm';

type SqlStorage = DurableObjectState['storage']['sql'];

const storedEventRowSchema = z.object({
  id: z.number(),
  execution_id: z.string(),
  session_id: z.string(),
  stream_event_type: z.string(),
  payload: z.string(),
  timestamp: z.number(),
});

const assistantMessageInfoSchema = z
  .object({
    id: z.string(),
    role: z.literal('assistant'),
  })
  .passthrough();

const assistantMessageUpdatedPayloadSchema = z
  .object({
    event: z.literal('message.updated'),
    properties: z
      .object({
        info: assistantMessageInfoSchema,
      })
      .passthrough(),
  })
  .passthrough();

const assistantMessagePartSchema = z
  .object({
    id: z.string(),
    messageID: z.string(),
  })
  .passthrough();

const assistantMessagePartUpdatedPayloadSchema = z
  .object({
    event: z.literal('message.part.updated'),
    properties: z
      .object({
        part: assistantMessagePartSchema,
      })
      .passthrough(),
  })
  .passthrough();

const assistantMessagePartRemovedPayloadSchema = z
  .object({
    event: z.literal('message.part.removed'),
    properties: z
      .object({
        messageID: z.string(),
        partID: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

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

export type UpsertEventParams = InsertEventParams & {
  entityId: string;
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

function parseJsonPayload<T>(payload: string, schema: z.ZodType<T>): T | null {
  try {
    const raw: unknown = JSON.parse(payload);
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseStoredEventRow(row: unknown): StoredEvent | null {
  const parsed = storedEventRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
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

    upsert(params: UpsertEventParams): EventId {
      const row = db
        .insert(events)
        .values({
          execution_id: params.executionId,
          session_id: params.sessionId,
          stream_event_type: params.streamEventType,
          payload: params.payload,
          timestamp: params.timestamp,
          entity_id: params.entityId,
        })
        .onConflictDoUpdate({
          target: events.entity_id,
          set: {
            payload: params.payload,
            timestamp: params.timestamp,
          },
        })
        .returning({ id: events.id })
        .get();

      return row.id;
    },

    findByFilters(filters: EventQueryFilters): StoredEvent[] {
      const conditions = buildConditions(filters);
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const columns = {
        id: events.id,
        execution_id: events.execution_id,
        session_id: events.session_id,
        stream_event_type: events.stream_event_type,
        payload: events.payload,
        timestamp: events.timestamp,
      };
      let query = db.select(columns).from(events).where(where).orderBy(asc(events.id)).$dynamic();

      if (filters.limit !== undefined) {
        query = query.limit(filters.limit);
      }

      return query.all() satisfies StoredEvent[];
    },

    getLatestAssistantMessage(
      sessionId: string,
      kiloSessionId: string
    ): LatestAssistantMessage | null {
      const messageRow = parseStoredEventRow(
        rawSql
          .exec(
            `
            SELECT id, execution_id, session_id, stream_event_type, payload, timestamp
            FROM events
            WHERE session_id = ?
              AND stream_event_type = 'kilocode'
              AND entity_id IS NOT NULL
              AND substr(entity_id, 1, 8) = 'message/'
              AND json_extract(payload, '$.event') = 'message.updated'
              AND json_extract(payload, '$.properties.info.role') = 'assistant'
              AND json_extract(payload, '$.properties.info.sessionID') = ?
            ORDER BY entity_id DESC
            LIMIT 1
            `,
            sessionId,
            kiloSessionId
          )
          .toArray()[0]
      );
      if (!messageRow) return null;

      const messagePayload = parseJsonPayload(
        messageRow.payload,
        assistantMessageUpdatedPayloadSchema
      );
      if (!messagePayload) return null;

      const messageId = messagePayload.properties.info.id;
      const partPrefix = `part/${messageId}/`;
      const partsById = new Map<string, AssistantMessagePart>();

      for (const rawPartRow of rawSql.exec(
        `
        SELECT id, execution_id, session_id, stream_event_type, payload, timestamp
        FROM events
        WHERE session_id = ?
          AND stream_event_type = 'kilocode'
          AND (
            (
              entity_id IS NOT NULL
              AND substr(entity_id, 1, ?) = ?
              AND json_extract(payload, '$.event') = 'message.part.updated'
            )
            OR (
              json_extract(payload, '$.event') = 'message.part.removed'
              AND json_extract(payload, '$.properties.messageID') = ?
            )
          )
        ORDER BY timestamp ASC, id ASC
        `,
        sessionId,
        partPrefix.length,
        partPrefix,
        messageId
      )) {
        const partRow = parseStoredEventRow(rawPartRow);
        if (!partRow) continue;

        const updatedPartPayload = parseJsonPayload(
          partRow.payload,
          assistantMessagePartUpdatedPayloadSchema
        );
        if (updatedPartPayload?.properties.part.messageID === messageId) {
          const part = updatedPartPayload.properties.part;
          partsById.set(part.id, part);
          continue;
        }

        const removedPartPayload = parseJsonPayload(
          partRow.payload,
          assistantMessagePartRemovedPayloadSchema
        );
        if (removedPartPayload?.properties.messageID === messageId) {
          partsById.delete(removedPartPayload.properties.partID);
        }
      }

      const parts = [...partsById.values()].sort((a, b) => a.id.localeCompare(b.id));

      return {
        eventId: messageRow.id,
        timestamp: messageRow.timestamp,
        info: messagePayload.properties.info,
        parts,
      } satisfies LatestAssistantMessage;
    },

    // Uses toSQL() + raw exec() for true lazy cursor-based iteration.
    // Drizzle's durable-sqlite .all() materializes everything; the raw
    // SqlStorageCursor lets callers break early without loading all rows.
    *iterateByFilters(filters: Omit<EventQueryFilters, 'limit'>): Generator<StoredEvent> {
      const conditions = buildConditions(filters);
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const columns = {
        id: events.id,
        execution_id: events.execution_id,
        session_id: events.session_id,
        stream_event_type: events.stream_event_type,
        payload: events.payload,
        timestamp: events.timestamp,
      };
      const { sql: query, params } = db
        .select(columns)
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
