import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const pendingUsageMutations = sqliteTable(
  'pending_usage_mutations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    idempotency_key: text('idempotency_key').notNull().unique(),
    operation: text('operation', { enum: ['start', 'heartbeat', 'stop'] }).notNull(),
    interval_id: text('interval_id').notNull(),
    context_fingerprint: text('context_fingerprint'),
    payload: text('payload').notNull(),
    received_at_ms: integer('received_at_ms').notNull(),
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at_ms: integer('next_attempt_at_ms').notNull(),
  },
  table => [
    index('pending_usage_mutations_drain_idx').on(table.next_attempt_at_ms, table.id),
    index('pending_usage_mutations_received_idx').on(table.received_at_ms, table.id),
    index('pending_usage_mutations_interval_context_idx').on(
      table.interval_id,
      table.context_fingerprint
    ),
  ]
);

export const startAdmissions = sqliteTable(
  'start_admissions',
  {
    idempotency_key: text('idempotency_key').primaryKey(),
    interval_id: text('interval_id').notNull(),
    context_fingerprint: text('context_fingerprint').notNull(),
    payload: text('payload').notNull(),
    received_at_ms: integer('received_at_ms').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] }).notNull(),
    error_code: text('error_code', {
      enum: ['sku_not_found', 'sku_unit_mismatch', 'sku_not_accepting_new_usage'],
    }),
    error_message: text('error_message'),
    decided_at_ms: integer('decided_at_ms'),
  },
  table => [index('start_admissions_interval_status_idx').on(table.interval_id, table.status)]
);
