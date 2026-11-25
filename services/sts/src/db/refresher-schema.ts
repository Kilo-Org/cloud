import type { PolicySnapshotEntry } from '../policy/load';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createAuditTables } from './audit-tables';

/** One row, id 1: the last manager read, sealed with the key in `refresher_key`. */
export const managerSnapshot = sqliteTable('manager_snapshot', {
  id: integer('id').primaryKey(),
  etag: text('etag'),
  fetchedAt: text('fetched_at').notNull(),
  iv: text('iv').notNull(),
  ciphertext: text('ciphertext').notNull(),
});

/** One row, id 1: the AES-GCM key that seals this object's manager snapshot. */
export const refresherKey = sqliteTable('refresher_key', {
  id: integer('id').primaryKey(),
  key: text('key').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** One row, id 1: the policy the last audit event was written for. */
export const policyState = sqliteTable('policy_state', {
  id: integer('id').primaryKey(),
  hash: text('hash').notNull(),
  snapshot: text('snapshot', { mode: 'json' }).$type<PolicySnapshotEntry[]>().notNull(),
});

/** One row, id 1: when the refresher is next due. */
export const refresherState = sqliteTable('refresher_state', {
  id: integer('id').primaryKey(),
  nextRefreshAt: integer('next_refresh_at').notNull(),
});

const auditTables = createAuditTables();

export const auditEvent = auditTables.auditEvent;
export const auditWatermark = auditTables.auditWatermark;
