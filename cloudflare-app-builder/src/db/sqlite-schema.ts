import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const gitObjects = sqliteTable(
  'git_objects',
  {
    path: text('path').primaryKey(),
    parent_path: text('parent_path').notNull().default(''),
    data: text('data').notNull(),
    is_dir: integer('is_dir').notNull().default(0),
    mtime: integer('mtime').notNull(),
  },
  table => [
    index('idx_git_objects_parent').on(table.parent_path, table.path),
    index('idx_git_objects_is_dir').on(table.is_dir, table.path),
  ]
);
