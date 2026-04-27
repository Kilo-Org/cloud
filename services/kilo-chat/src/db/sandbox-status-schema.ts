import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Singleton row keyed by id=1. Holds the last bot heartbeat.
export const botStatus = sqliteTable(
  'bot_status',
  {
    id: integer('id').primaryKey(),
    online: integer('online', { mode: 'boolean' }).notNull(),
    at: integer('at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => ({
    singletonCheck: check('bot_status_singleton_check', sql`${table.id} = 1`),
  })
);

// One row per conversationId. Holds the last post-turn payload for that conversation.
export const conversationStatus = sqliteTable('conversation_status', {
  conversationId: text('conversation_id').primaryKey(),
  contextTokens: integer('context_tokens').notNull(),
  contextWindow: integer('context_window').notNull(),
  model: text('model'),
  provider: text('provider'),
  at: integer('at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
