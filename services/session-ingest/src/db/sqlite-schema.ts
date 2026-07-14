import { index, sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const ingestItems = sqliteTable(
  'ingest_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    item_id: text('item_id').notNull().unique(),
    item_type: text('item_type').notNull(),
    item_data: text('item_data').notNull(),
    item_data_r2_key: text('item_data_r2_key'),
    ingested_at: integer('ingested_at'),
  },
  table => [index('ingest_items_ingested_at_id_idx').on(table.ingested_at, table.id)]
);

export const ingestMeta = sqliteTable('ingest_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const sessions = sqliteTable('sessions', {
  session_id: text('session_id').primaryKey(),
});

/**
 * Per-session durable outbox for human-attention pushes. One row per stable
 * request id (e.g. a question id from the CLI). Status is set to a terminal
 * value once dispatch is no longer needed; `pending` rows drive the alarm
 * retry loop.
 */
export const attentionOutbox = sqliteTable(
  'attention_outbox',
  {
    request_id: text('request_id').primaryKey(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    attempt_count: integer('attempt_count').notNull().default(0),
    next_attempt_at: integer('next_attempt_at'),
    last_error: text('last_error'),
    raised_at: integer('raised_at').notNull(),
    resolved_at: integer('resolved_at'),
  },
  table => [index('attention_outbox_pending_idx').on(table.status, table.next_attempt_at)]
);
