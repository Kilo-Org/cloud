import { sql } from 'drizzle-orm';
import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Registry DO SQLite table: tracks routable instance ownership per registry (user or org). */
export const registryInstances = sqliteTable('instances', {
  instance_id: text('instance_id').primaryKey(),
  do_key: text('do_key').notNull(),
  assigned_user_id: text('assigned_user_id').notNull(),
  created_at: text('created_at').notNull(),
  destroyed_at: text('destroyed_at'),
});

export const registryProvisionReservations = sqliteTable(
  'provision_reservations',
  {
    instance_id: text('instance_id').primaryKey(),
    do_key: text('do_key').notNull(),
    assigned_user_id: text('assigned_user_id').notNull(),
    status: text('status', {
      enum: ['in_progress', 'completed', 'failed_requires_reconciliation', 'released'],
    }).notNull(),
    started_at: text('started_at').notNull(),
    updated_at: text('updated_at').notNull(),
    completed_at: text('completed_at'),
    failure_code: text('failure_code'),
    resolution_reason: text('resolution_reason'),
  },
  table => [
    uniqueIndex('uq_provision_reservations_unresolved_user')
      .on(table.assigned_user_id)
      .where(sql`${table.status} IN ('in_progress', 'failed_requires_reconciliation')`),
  ]
);
