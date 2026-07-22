import { index, sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const ingestItems = sqliteTable(
  'ingest_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    item_id: text('item_id').notNull().unique(),
    item_type: text('item_type').notNull(),
    item_data: text('item_data').notNull(),
    item_data_r2_key: text('item_data_r2_key'),
    ingested_at: integer('ingested_at'),
  },
  table => [index('ingest_items_ingested_at_id_idx').on(table.ingested_at, table.id)]
);

export const ingestMeta = sqliteTable('ingest_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    session_id: text('session_id').primaryKey(),
    organization_id: text('organization_id'),
    authorization_expires_at: integer('authorization_expires_at').notNull().default(0),
  },
  table => [index('sessions_organization_id_idx').on(table.organization_id)]
);

/**
 * Durable per-identity dispatch state for `agent_notification` items (§4.10).
 *
 * Insert-if-absent on ingest; the DO emits the `agent_notification` signal in the ingest
 * response WHENEVER state is `pending` (fresh insert or replay). The dispatching caller
 * flips the state to `dispatched` once the attempt reaches a terminal local decision.
 *
 * `identity` is `agent_notification/<data.id>` — the same form the ingest item table
 * uses (`getItemIdentity()` returns `agent_notification/<data.id>`; we use the typed
 * dispatch table form for clarity, but a downstream marker query joins on the
 * well-known prefix).
 */
export const agentNotificationDispatch = sqliteTable('agent_notification_dispatch', {
  identity: text('identity').primaryKey(),
  state: text('state', { enum: ['pending', 'dispatched'] }).notNull(),
  created_at: integer('created_at').notNull(),
});
