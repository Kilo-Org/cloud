import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * What a store holds. Two tables, no nesting and no join on the read path.
 *
 * The schema is written here and the SQL is generated from it, so a migration
 * and a query can never disagree about a column. What the schema cannot say is
 * whether the database on disk matches it. That is checked at the edge with a
 * validator, not assumed from these types.
 */

/**
 * What `SessionOptions` freezes, stored so a session can be continued. Without
 * these a resumed session would take whatever the caller passed the second
 * time, and a system prompt that differs by one byte drops the whole prefix.
 *
 * There is no created column. The identifier is a ULID, so it already carries
 * the time and sorts by it.
 */
const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  system: text('system').notNull(),
  model: text('model').notNull(),
  effort: text('effort', { enum: ['low', 'medium', 'high', 'xhigh', 'max'] }),
  maxTokens: integer('max_tokens'),
});

/**
 * One row per turn, in the flat shape `Turn` already has.
 *
 * The index covers the pair, not the session alone: every read asks for one
 * session's turns in identifier order, and the pair answers that straight from
 * the index without a sort.
 */
const turns = sqliteTable(
  'turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
  },
  table => [index('turns_session_id_id').on(table.sessionId, table.id)]
);

export { sessions, turns };
