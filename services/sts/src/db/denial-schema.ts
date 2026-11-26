import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Denial } from '../audit/denials';

export { auditEvent, auditPrune, auditWatermark } from './audit-tables';

/**
 * Denials merged per UTC minute (`YYYY-MM-DDTHH:MM`) and key until the alarm after that minute
 * writes one audit event per row with the count.
 */
export const denialWindow = sqliteTable(
  'denial_window',
  {
    minute: text('minute').notNull(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    denial: text('denial', { mode: 'json' }).$type<Denial>().notNull(),
  },
  table => [primaryKey({ columns: [table.minute, table.key] })]
);
