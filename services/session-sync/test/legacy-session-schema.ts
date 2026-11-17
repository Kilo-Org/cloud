import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const legacySession = sqliteTable('session', {
  key: integer('key').primaryKey(),
  session_id: text('session_id').notNull(),
  tenant_type: text('tenant_type').notNull(),
  tenant_id: text('tenant_id').notNull(),
  creator_id: text('creator_id').notNull(),
  source_id: text('source_id').notNull(),
  position: integer('position').notNull(),
  revision: integer('revision').notNull(),
  batches: integer('batches').notNull(),
  entity_count: integer('entity_count').notNull(),
  inline_bytes: integer('inline_bytes').notNull(),
  blob_bytes: integer('blob_bytes').notNull(),
  tenant_lease: integer('tenant_lease').notNull(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  last_write_at: integer('last_write_at').notNull(),
  deleted_at: integer('deleted_at'),
});
