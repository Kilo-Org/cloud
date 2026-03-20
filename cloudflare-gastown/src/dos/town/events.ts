/**
 * Town event recording and draining for the reconciler.
 *
 * Events are facts recorded by RPC handlers. The reconciler drains them
 * on each alarm tick and applies state transitions. See reconciliation-spec.md §3.
 */

import { z } from 'zod';
import {
  town_events,
  TownEventRecord,
  createTableTownEvents,
  getIndexesTownEvents,
} from '../../db/tables/town-events.table';
import type { TownEventType } from '../../db/tables/town-events.table';
import { query } from '../../util/query.util';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/** Create the town_events table and indexes. Idempotent. */
export function initTownEventsTable(sql: SqlStorage): void {
  query(sql, createTableTownEvents(), []);
  for (const idx of getIndexesTownEvents()) {
    query(sql, idx, []);
  }
}

/**
 * Insert a new event into the town_events table.
 * Events start with processed_at = NULL and are consumed by drainEvents().
 */
export function insertEvent(
  sql: SqlStorage,
  eventType: TownEventType,
  params: {
    agent_id?: string | null;
    bead_id?: string | null;
    payload?: Record<string, unknown>;
  } = {}
): string {
  const eventId = generateId();
  query(
    sql,
    /* sql */ `
      INSERT INTO ${town_events} (
        ${town_events.columns.event_id},
        ${town_events.columns.event_type},
        ${town_events.columns.agent_id},
        ${town_events.columns.bead_id},
        ${town_events.columns.payload},
        ${town_events.columns.created_at},
        ${town_events.columns.processed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      eventId,
      eventType,
      params.agent_id ?? null,
      params.bead_id ?? null,
      JSON.stringify(params.payload ?? {}),
      now(),
      null,
    ]
  );
  return eventId;
}

/**
 * Upsert a container_status event for an agent. Instead of inserting a new
 * event every tick (which floods the table at 5s intervals × N agents),
 * this reuses an existing unprocessed container_status event for the same
 * agent if the status hasn't changed — just bumping the timestamp. A fresh
 * event is only inserted when the status actually changes or no prior
 * unprocessed event exists.
 */
export function upsertContainerStatus(
  sql: SqlStorage,
  agentId: string,
  payload: { status: string; exit_reason?: string | null }
): void {
  // Check for an existing unprocessed container_status event for this agent
  const existing = z
    .object({ event_id: z.string(), payload: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT ${town_events.columns.event_id} as event_id,
                 ${town_events.columns.payload} as payload
          FROM ${town_events}
          WHERE ${town_events.columns.event_type} = 'container_status'
            AND ${town_events.columns.agent_id} = ?
            AND ${town_events.columns.processed_at} IS NULL
          ORDER BY ${town_events.columns.created_at} DESC
          LIMIT 1
        `,
        [agentId]
      ),
    ]);

  if (existing.length > 0) {
    let prevPayload: Record<string, unknown> = {};
    try {
      prevPayload = JSON.parse(existing[0].payload) as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    if (prevPayload.status === payload.status) {
      // Same status — just bump the timestamp, don't create a new event
      query(
        sql,
        /* sql */ `
          UPDATE ${town_events}
          SET ${town_events.columns.created_at} = ?
          WHERE ${town_events.columns.event_id} = ?
        `,
        [now(), existing[0].event_id]
      );
      return;
    }
  }

  // Status changed or no prior event — insert a new one
  insertEvent(sql, 'container_status', {
    agent_id: agentId,
    payload: {
      status: payload.status,
      ...(payload.exit_reason ? { exit_reason: payload.exit_reason } : {}),
    },
  });
}

/**
 * Drain all unprocessed events, ordered by creation time.
 * Returns events with processed_at = NULL, oldest first.
 */
export function drainEvents(sql: SqlStorage): TownEventRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${town_events.event_id}, ${town_events.event_type},
               ${town_events.agent_id}, ${town_events.bead_id},
               ${town_events.payload}, ${town_events.created_at},
               ${town_events.processed_at}
        FROM ${town_events}
        WHERE ${town_events.processed_at} IS NULL
        ORDER BY ${town_events.created_at} ASC
      `,
      []
    ),
  ];
  return TownEventRecord.array().parse(rows);
}

/** Mark an event as processed so it won't be returned by drainEvents again. */
export function markProcessed(sql: SqlStorage, eventId: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${town_events}
      SET ${town_events.columns.processed_at} = ?
      WHERE ${town_events.event_id} = ?
    `,
    [now(), eventId]
  );
}

/**
 * Delete old processed events beyond the retention window.
 * Only deletes events that have been processed (processed_at IS NOT NULL)
 * and whose created_at is older than the cutoff.
 */
export function pruneOldEvents(sql: SqlStorage, retentionMs: number): number {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const deleted = [
    ...query(
      sql,
      /* sql */ `
        DELETE FROM ${town_events}
        WHERE ${town_events.processed_at} IS NOT NULL
          AND ${town_events.created_at} < ?
        RETURNING ${town_events.event_id}
      `,
      [cutoff]
    ),
  ];
  return deleted.length;
}

/** Count unprocessed events (useful for metrics). */
export function pendingEventCount(sql: SqlStorage): number {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT count(*) as cnt FROM ${town_events}
        WHERE ${town_events.processed_at} IS NULL
      `,
      []
    ),
  ];
  const row = rows[0];
  return typeof row?.cnt === 'number' ? row.cnt : 0;
}
