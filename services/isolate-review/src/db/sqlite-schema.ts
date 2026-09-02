import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const reviewApplicationState = sqliteTable('review_application_state', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
});
