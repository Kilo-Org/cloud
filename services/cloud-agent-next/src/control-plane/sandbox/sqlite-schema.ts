import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ALLOCATION_KINDS } from './allocation.js';

/**
 * The Sandbox DO stores exactly one allocation row (id `current`) and one row
 * per session route. The allocation row is the persisted reducer state plus the
 * provider pin (how to address and configure the physical sandbox) that must
 * survive eviction. The provider kind is owned by the pin, not by a separate
 * column (M1). The route table is owned by routes.ts (B3).
 */
export const allocation = sqliteTable('allocation', {
  id: text('id').primaryKey(),
  state: text('state', { enum: ALLOCATION_KINDS }).notNull(),
  allocation_id: text('allocation_id'),
  connection_id: text('connection_id'),
  provider_ref: text('provider_ref'),
  wrapper_id: text('wrapper_id'),
  last_frame_at: integer('last_frame_at'),
  last_activity_at: integer('last_activity_at'),
  create_deadline_at: integer('create_deadline_at'),
  first_connect_deadline_at: integer('first_connect_deadline_at'),
  stop_attempt: integer('stop_attempt').notNull(),
  stop_pending: integer('stop_pending', { mode: 'boolean' }).notNull(),
  stop_at: integer('stop_at'),
  unconfirmed_provider_ref: text('unconfirmed_provider_ref'),
  provider_pin: text('provider_pin'),
});

export const routes = sqliteTable('routes', {
  session_id: text('session_id').primaryKey(),
  spec: text('spec').notNull(),
  grant: text('grant'),
  credential_source: text('credential_source'),
  state: text('state').notNull(),
  attempt_id: text('attempt_id').notNull(),
  attempt_deadline_at: integer('attempt_deadline_at'),
  reason: text('reason'),
  updated_at: integer('updated_at').notNull(),
});
