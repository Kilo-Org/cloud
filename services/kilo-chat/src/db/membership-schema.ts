import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const conversations = sqliteTable(
  'conversations',
  {
    conversation_id: text('conversation_id').primaryKey(),
    conversation_title: text('conversation_title'),
    sandbox_id: text('sandbox_id').notNull(),
    last_activity_at: integer('last_activity_at'),
    last_read_at: integer('last_read_at'),
    joined_at: integer('joined_at').notNull(),
  },
  table => [index('conversations_sandbox_id_idx').on(table.sandbox_id)]
);
