import type { SecretName, StsEnvironment, WorkloadName } from '@kilocode/sts-contracts';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export { auditEvent, auditPrune, auditWatermark } from './audit-tables';

/** One row, id 1: the workload's current bundle, sealed with the object's seal key. */
export const bundle = sqliteTable('bundle', {
  id: integer('id').primaryKey(),
  workload: text('workload').$type<WorkloadName>().notNull(),
  environment: text('environment').$type<StsEnvironment>().notNull(),
  etag: text('etag').notNull(),
  policyHash: text('policy_hash').notNull(),
  fetchedAt: text('fetched_at').notNull(),
  stale: integer('stale', { mode: 'boolean' }).notNull(),
  missing: text('missing', { mode: 'json' }).$type<SecretName[]>().notNull(),
  iv: text('iv').notNull(),
  ciphertext: text('ciphertext').notNull(),
});

/**
 * Legacy: an earlier revision kept the seal and ETag keys here. `BundleDO` moves a row it finds to
 * KV storage once and deletes it; nothing writes this table, so no SQL statement binds a key.
 */
export const bundleKey = sqliteTable('bundle_key', {
  id: integer('id').primaryKey(),
  sealKey: text('seal_key').notNull(),
  etagKey: text('etag_key').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Revalidations that returned 304, counted per UTC minute (`YYYY-MM-DDTHH:MM`). */
export const deliveryCounter = sqliteTable('delivery_counter', {
  minute: text('minute').primaryKey(),
  count: integer('count').notNull(),
});
