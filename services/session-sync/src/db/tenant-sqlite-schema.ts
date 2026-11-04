import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const leases = sqliteTable('leases', {
  session_id: text('session_id').primaryKey(),
  bytes: integer('bytes').notNull(),
});

export const usage = sqliteTable('usage', {
  id: integer('id').primaryKey(),
  sessions: integer('sessions').notNull(),
  bytes: integer('bytes').notNull(),
});
