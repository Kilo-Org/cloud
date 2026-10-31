import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { SESSION_MESSAGE_STATES } from './messages.js';

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    execution_id: text('execution_id').notNull(),
    session_id: text('session_id').notNull(),
    stream_event_type: text('stream_event_type').notNull(),
    payload: text('payload').notNull(),
    timestamp: integer('timestamp').notNull(),
    entity_id: text('entity_id').unique(),
    mutation_cursor: integer('mutation_cursor').notNull().default(0),
  },
  table => [
    index('idx_events_execution').on(table.execution_id),
    index('idx_events_type').on(table.stream_event_type),
    index('idx_events_timestamp').on(table.timestamp),
    index('idx_events_id_execution').on(table.id, table.execution_id),
    index('idx_events_mutation_cursor').on(table.mutation_cursor),
  ]
);

export const eventMutationCursor = sqliteTable('event_mutation_cursor', {
  id: integer('id').primaryKey(),
  cursor: integer('cursor').notNull().default(0),
});

export const historyImport = sqliteTable(
  'history_import',
  {
    entity_id: text('entity_id').primaryKey(),
    kilo_session_id: text('kilo_session_id').notNull().default(''),
    payload: text('payload').notNull(),
    timestamp: integer('timestamp').notNull(),
  },
  table => [
    index('idx_history_import_scope_timestamp_entity').on(
      table.kilo_session_id,
      table.timestamp,
      table.entity_id
    ),
  ]
);

export const controlPlaneMessages = sqliteTable('control_plane_messages', {
  message_id: text('message_id').primaryKey(),
  intent: text('intent').notNull(),
  state: text('state', { enum: SESSION_MESSAGE_STATES }).notNull(),
  created_at: integer('created_at').notNull(),
  accepted_at: integer('accepted_at'),
  settled_at: integer('settled_at'),
  reason: text('reason'),
  container: text('container'),
});
