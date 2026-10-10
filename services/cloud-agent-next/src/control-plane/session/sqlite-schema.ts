import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { events } from '../../db/sqlite-schema.js';
import { SESSION_MESSAGE_STATES } from './messages.js';

/**
 * The V2 Session DO reuses the shared `events` table unchanged so
 * `session/queries/events.ts` and the stream handler keep working (Contracts,
 * "Storage cutover"). It adds one message row per spec §5: identity, immutable
 * intent, one state, timestamps and a terminal reason.
 */
export { events };

export const controlPlaneMessages = sqliteTable('control_plane_messages', {
  message_id: text('message_id').primaryKey(),
  intent: text('intent').notNull(),
  state: text('state', { enum: SESSION_MESSAGE_STATES }).notNull(),
  created_at: integer('created_at').notNull(),
  accepted_at: integer('accepted_at'),
  settled_at: integer('settled_at'),
  reason: text('reason'),
});
