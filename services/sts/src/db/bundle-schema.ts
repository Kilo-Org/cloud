import type { SecretName, StsEnvironment, WorkloadName } from '@kilocode/sts-contracts';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createAuditTables } from './audit-tables';

/** One row, id 1: the workload's current bundle, sealed with the key in `bundle_key`. */
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

/** One row, id 1: the AES-GCM key that seals this object's bundle. */
export const bundleKey = sqliteTable('bundle_key', {
  id: integer('id').primaryKey(),
  key: text('key').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Revalidations that returned 304, counted per UTC minute. */
export const deliveryCounter = sqliteTable('delivery_counter', {
  minute: text('minute').primaryKey(),
  count: integer('count').notNull(),
});

const auditTables = createAuditTables();

export const auditEvent = auditTables.auditEvent;
export const auditWatermark = auditTables.auditWatermark;
