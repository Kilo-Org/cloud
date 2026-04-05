import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const ingestItems = sqliteTable('ingest_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  item_id: text('item_id').notNull().unique(),
  item_type: text('item_type').notNull(),
  item_data: text('item_data').notNull(),
  item_data_r2_key: text('item_data_r2_key'),
  ingested_at: integer('ingested_at'),
});

export const ingestMeta = sqliteTable('ingest_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const sessions = sqliteTable('sessions', {
  session_id: text('session_id').primaryKey(),
});
