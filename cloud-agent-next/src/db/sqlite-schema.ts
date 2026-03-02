import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    execution_id: text('execution_id').notNull(),
    session_id: text('session_id').notNull(),
    stream_event_type: text('stream_event_type').notNull(),
    payload: text('payload').notNull(),
    timestamp: integer('timestamp').notNull(),
  },
  table => [
    index('idx_events_execution').on(table.execution_id),
    index('idx_events_type').on(table.stream_event_type),
    index('idx_events_timestamp').on(table.timestamp),
    index('idx_events_id_execution').on(table.id, table.execution_id),
  ]
);

export const executionLeases = sqliteTable(
  'execution_leases',
  {
    execution_id: text('execution_id').primaryKey(),
    lease_id: text('lease_id').notNull(),
    lease_expires_at: integer('lease_expires_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    message_id: text('message_id'),
  },
  table => [index('idx_leases_expires').on(table.lease_expires_at)]
);

export const commandQueue = sqliteTable(
  'command_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    session_id: text('session_id').notNull(),
    execution_id: text('execution_id').notNull(),
    message_json: text('message_json').notNull(),
    created_at: integer('created_at').notNull(),
  },
  table => [index('idx_command_queue_session').on(table.session_id)]
);
