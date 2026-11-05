import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Advertisements exceed the platform's small hibernation attachment limit. */
export const presenceAdvertisements = sqliteTable('presence_advertisements', {
  connection_id: text('connection_id').primaryKey(),
  advertisement: text('advertisement').notNull(),
});
