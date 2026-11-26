import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ManagerFolder } from '../infisical/client';
import type { PolicySnapshotEntry } from '../policy/load';

export { auditEvent, auditPrune, auditWatermark } from './audit-tables';

/**
 * The last successful read of each manager folder, sealed with the refresher's seal key. Both rows are
 * written in one refresh, so they always come from the same read pair.
 */
export const managerFolder = sqliteTable('manager_folder', {
  folder: text('folder').$type<ManagerFolder>().primaryKey(),
  etag: text('etag'),
  fetchedAt: integer('fetched_at').notNull(),
  iv: text('iv').notNull(),
  ciphertext: text('ciphertext').notNull(),
});

/**
 * One row, id 1: the secret Infisical signs this environment's `secrets.modified` webhook with.
 * STS generates it; the break-glass owner copies it from Data Studio once (README). It stays in SQL
 * because Data Studio reads only SQL data.
 */
export const webhookKey = sqliteTable('webhook_key', {
  id: integer('id').primaryKey(),
  key: text('key').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** One row, id 1: the policy the last policy-change audit event was written for. */
export const policyState = sqliteTable('policy_state', {
  id: integer('id').primaryKey(),
  hash: text('hash').notNull(),
  snapshot: text('snapshot', { mode: 'json' }).$type<PolicySnapshotEntry[]>().notNull(),
});

/**
 * One row, id 1: the refresh schedule. `failures` counts consecutive failed `/workloads` or
 * `/shared` reads; while it is above zero `next_refresh_at` is a backoff deadline.
 * `webhook_refresh_at` is the end of an open webhook merge window, or null when none is open.
 * `ci_failed_at` is when the last `/ci` read failed, or null once one succeeds. While it is set,
 * the `/ci` copy is served stale, and a fill reads the manager for a CI bundle only after a refresh
 * interval has passed since it.
 */
export const refresherState = sqliteTable('refresher_state', {
  id: integer('id').primaryKey(),
  nextRefreshAt: integer('next_refresh_at').notNull(),
  failures: integer('failures').notNull(),
  webhookRefreshAt: integer('webhook_refresh_at'),
  lastRefreshAt: integer('last_refresh_at'),
  ciFailedAt: integer('ci_failed_at'),
});
