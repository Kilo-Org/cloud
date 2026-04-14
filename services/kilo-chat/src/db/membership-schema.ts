import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const conversations = sqliteTable('conversations', {
  conversation_id: text('conversation_id').primaryKey(),
  conversation_title: text('conversation_title'),
  last_message_id: text('last_message_id'),
  last_read_message_id: text('last_read_message_id'),
  joined_at: integer('joined_at').notNull(),
});
