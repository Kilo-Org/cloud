import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Advertisements exceed the platform's small hibernation attachment limit. */
export const presenceAdvertisements = sqliteTable('presence_advertisements', {
  connection_id: text('connection_id').primaryKey(),
  advertisement: text('advertisement').notNull(),
});

/** Live reply routing only: never persist command or reply bodies. */
export const presenceCommandRoutes = sqliteTable(
  'presence_command_routes',
  {
    command_id: text('command_id').primaryKey(),
    controller_connection_id: text('controller_connection_id'),
    runner_connection_id: text('runner_connection_id').notNull(),
    tenant_type: text('tenant_type', { enum: ['user', 'organization'] }).notNull(),
    tenant_id: text('tenant_id').notNull(),
    instance_id: text('instance_id').notNull(),
    expires_at: integer('expires_at').notNull(),
  },
  table => [
    index('presence_command_expiry_idx').on(table.expires_at),
    index('presence_command_runner_idx').on(table.runner_connection_id),
    index('presence_command_controller_idx').on(table.controller_connection_id),
  ]
);

/** Shared HTTP/socket admission per controller principal and tenant. */
export const presenceCommandRates = sqliteTable('presence_command_rates', {
  key: text('key').primaryKey(),
  window: integer('window').notNull(),
  count: integer('count').notNull(),
});
