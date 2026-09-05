import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The encrypted key-value table (DEC-01). Drizzle owns this schema: the
 * `drizzle/` migrations are generated from it, and
 * `src/lib/persist/encrypted-kv.ts` runs them on every open.
 */
export const kv = sqliteTable(
  'kv',
  {
    scope: text('scope').notNull(),
    k: text('k').notNull(),
    v: text('v').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => [primaryKey({ columns: [table.scope, table.k] })]
);

/**
 * One row per chat, which is what the chat list is drawn from.
 *
 * The conversation itself is not here: the harness SDK keeps the turns in its
 * own tables on this same database, and it knows nothing about who is signed in
 * or which organization they are in. So the app keeps what the SDK has no
 * business holding — the scope a chat belongs to, and when it last moved, which
 * is the order a list of conversations is read in.
 */
export const chats = sqliteTable(
  'chats',
  {
    /** The harness session this chat is, at the moment. A model switch moves it. */
    sessionId: text('session_id').primaryKey(),
    /** The account and organization it belongs to. See `chatScope`. */
    scope: text('scope').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => [index('chats_scope_updated_at').on(table.scope, table.updatedAt)]
);
