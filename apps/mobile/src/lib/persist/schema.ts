import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
    /**
     * The session-sync id of this chat, minted once at first sync and never
     * changed afterwards: a harness clone moves `session_id`, never this.
     * Null until the chat first syncs (or forever, when sync stays off).
     */
    serverSessionId: text('server_session_id'),
    /** The registered source id (one per install and account) that writes this chat. */
    syncSourceId: text('sync_source_id'),
    /** One of `local | pending | synced | diverged | deleted`. See sync-state. */
    syncState: text('sync_state').notNull().default('local'),
    /** The server position this device last committed or pulled (the CAS `after`). */
    syncAcknowledged: integer('sync_acknowledged').notNull().default(0),
    syncAckBatch: text('sync_ack_batch'),
    syncAckDigest: text('sync_ack_digest'),
    /** The highest message `seq` this device has assigned or imported. */
    syncMaxSeq: integer('sync_max_seq').notNull().default(0),
    /** The highest `seq` the server has acknowledged from this device. */
    syncAckedSeq: integer('sync_acked_seq').notNull().default(0),
    /** The frozen outbox packet awaiting an acknowledgement, as JSON. Retries resend it byte-identically. */
    syncOutbox: text('sync_outbox'),
    /** Turn id to `{msgId, seq}` for every message this device mapped, as JSON. */
    syncMessageMap: text('sync_message_map'),
  },
  table => [
    index('chats_scope_updated_at').on(table.scope, table.updatedAt),
    uniqueIndex('chats_server_session_id').on(table.serverSessionId),
  ]
);
