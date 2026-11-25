import type { AuditEvent } from '@kilocode/sts-contracts';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The audit log each Durable Object keeps, its relay watermark, and when rows past retention
 * were last deleted. Every schema that owns an audit stream re-exports these same tables, so
 * `AuditLog` reads one shape everywhere.
 */
export const auditEvent = sqliteTable('audit_event', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  event: text('event', { mode: 'json' }).$type<AuditEvent>().notNull(),
  createdAt: integer('created_at').notNull(),
});

/** One row, id 1: the highest sequence the queue accepted. */
export const auditWatermark = sqliteTable('audit_watermark', {
  id: integer('id').primaryKey(),
  relayedSeq: integer('relayed_seq').notNull(),
});

/** One row, id 1: when rows past retention were last deleted. */
export const auditPrune = sqliteTable('audit_prune', {
  id: integer('id').primaryKey(),
  prunedAt: integer('pruned_at').notNull(),
});
