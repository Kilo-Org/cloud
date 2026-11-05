import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Reserved sequence ceiling: hibernation skips unused values rather than reusing them. */
export const relayState = sqliteTable('relay_state', {
  id: integer('id').primaryKey(),
  seq: integer('seq').notNull(),
  purged: integer('purged', { mode: 'boolean' }).notNull().default(false),
});

export const relayCommands = sqliteTable(
  'relay_commands',
  {
    ordinal: integer('ordinal').primaryKey({ autoIncrement: true }),
    command_id: text('command_id').notNull(),
    from: text('from').notNull(),
    type: text('type').notNull(),
    payload: text('payload'),
    bytes: integer('bytes').notNull(),
    live_only: integer('live_only', { mode: 'boolean' }).notNull(),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at').notNull(),
    delivered_at: integer('delivered_at'),
    status: text('status', { enum: ['queued', 'delivered', 'expired'] }).notNull(),
    finished_at: integer('finished_at'),
  },
  table => [
    uniqueIndex('relay_commands_id_idx').on(table.command_id),
    index('relay_commands_expiry_idx').on(table.status, table.expires_at),
  ]
);

/** Shared by sockets and HTTP so reconnecting cannot replenish the rate budget. */
export const relayRates = sqliteTable('relay_rates', {
  key: text('key').primaryKey(),
  window: integer('window').notNull(),
  count: integer('count').notNull(),
});

/** Retained until a watch(false) RPC succeeds, including across purge retries. */
export const relayWatches = sqliteTable('relay_watches', {
  user_id: text('user_id').primaryKey(),
  tenant: text('tenant', { mode: 'json' }).notNull(),
  session_id: text('session_id').notNull(),
});
