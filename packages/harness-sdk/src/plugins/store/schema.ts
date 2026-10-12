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
 * `prompted` is the one column here that changes: it is the provider's own
 * count of the last request's input, and it is what decides whether the next
 * question compacts first. It is stored because nothing estimates a token
 * count, so a session reopened without it would not know how full it is.
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
  prompted: integer('prompted'),
  /**
   * The tools the session offers, as a JSON array of names in the order the
   * model sees them. It is one column and not a table because nothing ever
   * queries it: it is read whole with the session and written once, at open.
   *
   * The names and not the definitions, because a definition lives in code. See
   * AGENTS.md, "A session names its tools; the registry defines them".
   */
  tools: text('tools'),
});

/**
 * One row per turn. A turn holds no content of its own: its content is its
 * parts, which is what makes an image or a piece of reasoning storable beside
 * text without a column per kind.
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
  },
  table => [index('turns_session_id_id').on(table.sessionId, table.id)]
);

/**
 * One row per piece of a turn, ordered by identifier like everything else.
 *
 * `session_id` repeats what `turn_id` could reach, and it is there for the
 * reader: loading a session is then two indexed scans over two tables with no
 * join at all, rather than a join whose cost grows with the conversation.
 *
 * `body` is the only payload column, because every kind has exactly one payload
 * — the text, the reasoning, the base64 of the image, the arguments of a call,
 * or what a tool gave back. `media` names the media type and is empty for
 * everything but an image. `signature` is what the provider issued with a
 * thinking block and reads back to know the thinking is its own; it is empty for
 * everything but reasoning, and for reasoning from a shape that issues none.
 *
 * The last three belong to tools. `call_id` is what the provider called the
 * call, and it is on both halves: a result names the call it answers, and every
 * shape refuses a call whose result is missing. `name` is the tool, on the call
 * only. `failed` says the tool did not do what it was asked, on the result only.
 */
const parts = sqliteTable(
  'parts',
  {
    id: text('id').primaryKey(),
    turnId: text('turn_id')
      .notNull()
      .references(() => turns.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    kind: text('kind', {
      enum: ['text', 'summary', 'reasoning', 'redacted', 'image', 'toolCall', 'toolResult'],
    }).notNull(),
    body: text('body').notNull(),
    media: text('media'),
    signature: text('signature'),
    callId: text('call_id'),
    name: text('name'),
    failed: integer('failed', { mode: 'boolean' }),
  },
  table => [index('parts_session_id_id').on(table.sessionId, table.id)]
);

export { parts, sessions, turns };
