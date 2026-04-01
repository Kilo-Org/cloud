import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Registry DO SQLite table: tracks instance ownership per registry (user or org). */
export const registryInstances = sqliteTable('instances', {
  instance_id: text('instance_id').primaryKey(),
  do_key: text('do_key').notNull(),
  assigned_user_id: text('assigned_user_id').notNull(),
  created_at: text('created_at').notNull(),
  destroyed_at: text('destroyed_at'),
});
