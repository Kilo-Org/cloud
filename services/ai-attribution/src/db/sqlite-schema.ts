import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const attributionsMetadata = sqliteTable(
  'attributions_metadata',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user_id: text('user_id').notNull(),
    project_id: text('project_id').notNull(),
    organization_id: text('organization_id'),
    branch: text('branch').notNull(),
    file_path: text('file_path').notNull(),
    status: text('status', { enum: ['accepted', 'rejected'] }).notNull(),
    task_id: text('task_id'),
    created_at: text('created_at')
      .notNull()
      .default(sql`current_timestamp`),
  },
  table => [
    index('idx_file_path').on(table.file_path),
    index('idx_created_at').on(table.created_at),
    index('idx_user_org').on(table.user_id, table.organization_id),
    check('status_check', sql`status in ('accepted', 'rejected')`),
  ]
);

export const linesAdded = sqliteTable(
  'lines_added',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    attributions_metadata_id: integer('attributions_metadata_id')
      .notNull()
      .references(() => attributionsMetadata.id),
    line_number: integer('line_number').notNull(),
    line_hash: text('line_hash').notNull(),
  },
  table => [
    index('idx_attribution_added').on(table.attributions_metadata_id),
    index('idx_hash_added').on(table.line_hash),
  ]
);

export const linesRemoved = sqliteTable(
  'lines_removed',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    attributions_metadata_id: integer('attributions_metadata_id')
      .notNull()
      .references(() => attributionsMetadata.id),
    line_number: integer('line_number').notNull(),
    line_hash: text('line_hash').notNull(),
  },
  table => [
    index('idx_attribution_removed').on(table.attributions_metadata_id),
    index('idx_hash_removed').on(table.line_hash),
  ]
);

export type AttributionsMetadataInsert = typeof attributionsMetadata.$inferInsert;
export type LinesAddedInsert = typeof linesAdded.$inferInsert;
export type LinesRemovedInsert = typeof linesRemoved.$inferInsert;

export type AttributionsMetadataSelect = typeof attributionsMetadata.$inferSelect;
export type LinesAddedSelect = typeof linesAdded.$inferSelect;
export type LinesRemovedSelect = typeof linesRemoved.$inferSelect;
