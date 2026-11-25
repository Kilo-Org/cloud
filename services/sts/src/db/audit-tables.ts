import type { AuditEvent } from '@kilocode/sts-contracts';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The audit log each Durable Object keeps, and the relay watermark over it.
 * Both Durable Object roots define these tables through this factory so the
 * relay never sees two different shapes.
 */
export function createAuditTables() {
  return {
    auditEvent: sqliteTable('audit_event', {
      seq: integer('seq').primaryKey({ autoIncrement: true }),
      event: text('event', { mode: 'json' }).$type<AuditEvent>().notNull(),
      createdAt: integer('created_at').notNull(),
    }),
    auditWatermark: sqliteTable('audit_watermark', {
      id: integer('id').primaryKey(),
      relayedSeq: integer('relayed_seq').notNull(),
    }),
  };
}
