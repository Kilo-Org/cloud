import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const conversation = sqliteTable('conversation', {
  id: text('id').primaryKey(),
  title: text('title'),
  created_by: text('created_by').notNull(),
  created_at: integer('created_at').notNull(),
});

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  joined_at: integer('joined_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sender_id: text('sender_id').notNull(),
  content: text('content').notNull(),
  in_reply_to_message_id: text('in_reply_to_message_id'),
  version: integer('version').notNull().default(1),
  updated_at: integer('updated_at'),
  deleted: integer('deleted').notNull().default(0),
});
