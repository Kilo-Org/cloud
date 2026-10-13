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
 * business holding — the scope a chat belongs to, when it last moved, which
 * is the order a list of conversations is read in, and the name a person gave it.
 */
export const chats = sqliteTable(
  'chats',
  {
    /** The harness session this chat is, at the moment. A model switch moves it. */
    sessionId: text('session_id').primaryKey(),
    /** The account and organization it belongs to. See `chatScope`. */
    scope: text('scope').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** The name the person gave the chat. Null means the first thing they said names it. */
    title: text('title'),
    /**
     * When the chat was started. A model switch keeps it, because it moves this
     * row rather than adding one. Null for a chat started before it was kept,
     * which is also a chat whose usage was not counted from its first answer.
     */
    createdAt: integer('created_at'),
    /** What the chat has used, per model, as JSON. See `src/lib/chat/chat-usage.ts`. */
    usage: text('usage'),
  },
  table => [index('chats_scope_updated_at').on(table.scope, table.updatedAt)]
);
