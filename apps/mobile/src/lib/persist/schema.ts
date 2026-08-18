import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The encrypted key-value table (DEC-01). Drizzle owns this schema: the
 * `drizzle/` migrations are generated from it, and
 * `src/lib/persist/encrypted-kv.ts` runs them on every open.
 */
export const kv = sqliteTable(
  'kv',
  {
    scope: text('scope').notNull(),
    k: text('k').notNull(),
    v: text('v').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => [primaryKey({ columns: [table.scope, table.k] })]
);
