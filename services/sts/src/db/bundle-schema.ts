import type { SecretName, StsEnvironment, WorkloadName } from '@kilocode/sts-contracts';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export { auditEvent, auditPrune, auditWatermark } from './audit-tables';

/** One row, id 1: the workload's current bundle, sealed with `bundle_key.seal_key`. */
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
 * One row, id 1: the AES-GCM key that seals the bundle and the HMAC key its ETag is computed
 * under. Both are generated in this object and never leave it.
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
