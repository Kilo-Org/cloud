/**
 * Events table schema for CloudAgentSession Durable Object.
 */

import { z } from 'zod';
import { getTableFromZodSchema } from '../../utils/table.js';

/**
 * Full event record schema.
 * Use for full-row queries like findByFilters().
 */
export const EventRecord = z.object({
  id: z.number(),
  execution_id: z.string(),
  session_id: z.string(),
  stream_event_type: z.string(),
  payload: z.string(),
  timestamp: z.number(),
});

export type EventRecord = z.infer<typeof EventRecord>;

/**
 * Partial schemas for queries returning fewer columns.
 */
export const EventIdOnly = EventRecord.pick({ id: true });
export type EventIdOnly = z.infer<typeof EventIdOnly>;

/**
 * Schema for getLatestEventId() which returns MAX(id).
 */
export const MaxIdResult = z.object({
  max_id: z.number().nullable(),
});
export type MaxIdResult = z.infer<typeof MaxIdResult>;

/**
 * Schema for countByExecutionId() which returns COUNT(*).
 */
export const CountResult = z.object({
  count: z.number(),
});
export type CountResult = z.infer<typeof CountResult>;

/**
 * Table interpolator for type-safe SQL queries.
 *
 * @example
 * // Use events.columns.* for INSERT column lists (unqualified)
 * const { columns: cols } = events;
 * sql.exec(`INSERT INTO ${events} (${cols.execution_id}, ...) VALUES (?, ...)`, ...);
 *
 * // Use events.* for SELECT/WHERE/ORDER (qualified)
 * sql.exec(`SELECT ${events.id} FROM ${events} WHERE ${events.execution_id} = ?`, ...);
 */
export const events = getTableFromZodSchema('events', EventRecord);
