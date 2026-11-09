import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const leases = sqliteTable('leases', {
  session_id: text('session_id').primaryKey(),
  bytes: integer('bytes').notNull(),
});

export const usage = sqliteTable('usage', {
  id: integer('id').primaryKey(),
  sessions: integer('sessions').notNull(),
  bytes: integer('bytes').notNull(),
});

/** The personal tenant also indexes sessions its user creates in any tenant. */
export const createdSessions = sqliteTable(
  'created_sessions',
  {
    target: text('target').primaryKey(),
    tenant_type: text('tenant_type', { enum: ['user', 'organization'] }).notNull(),
    tenant_id: text('tenant_id').notNull(),
    session_id: text('session_id').notNull(),
    created_at: integer('created_at').notNull().default(0),
  },
  table => [index('created_sessions_newest').on(table.created_at, table.target)]
);

/** Permanent admission fence; content cleanup is alarm-driven. */
export const userErasure = sqliteTable('user_erasure', {
  id: integer('id').primaryKey(),
  user_id: text('user_id').notNull(),
});
