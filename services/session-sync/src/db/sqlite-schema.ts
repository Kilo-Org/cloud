import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Producer binding, committed position, and usage counters. The object holds at
 * most one row (`key` = 1). A row with `deleted_at` set is the permanent
 * tombstone; no code path removes this row.
 */
export const session = sqliteTable('session', {
  key: integer('key').primaryKey(),
  session_id: text('session_id').notNull(),
  tenant_type: text('tenant_type', { enum: ['user', 'organization'] }).notNull(),
  tenant_id: text('tenant_id').notNull(),
  creator_id: text('creator_id').notNull(),
  source_id: text('source_id').notNull(),
  position: integer('position').notNull(),
  revision: integer('revision').notNull(),
  batches: integer('batches').notNull(),
  entity_count: integer('entity_count').notNull(),
  inline_bytes: integer('inline_bytes').notNull(),
  blob_bytes: integer('blob_bytes').notNull(),
  tenant_lease: integer('tenant_lease').notNull().default(0),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  /** Registration anchors empty sessions; only accepted batches/blob commits refresh it. */
  last_write_at: integer('last_write_at').notNull().default(0),
  deleted_at: integer('deleted_at'),
});

/** Session-local principal grants; only the creator receives an owner grant today. */
export const sessionRoles = sqliteTable('session_roles', {
  principal_id: text('principal_id').primaryKey(),
  role: text('role', { enum: ['owner', 'viewer', 'editor'] }).notNull(),
});

/** Current portable entities. A row holds an inline JSON value or a blob reference. */
export const entities = sqliteTable(
  'entities',
  {
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    revision: integer('revision').notNull(),
    value: text('value'),
    blob_hash: text('blob_hash'),
    blob_bytes: integer('blob_bytes'),
    inline_bytes: integer('inline_bytes').notNull(),
  },
  table => [
    primaryKey({ columns: [table.kind, table.id] }),
    index('entities_blob_hash_idx')
      .on(table.blob_hash)
      .where(sql`${table.blob_hash} IS NOT NULL`),
  ]
);

/** Bounded tail of durable batch receipts, keyed by the producer batch ID. */
export const receipts = sqliteTable(
  'receipts',
  {
    batch_id: text('batch_id').primaryKey(),
    digest: text('digest').notNull(),
    after: integer('after').notNull(),
    through: integer('through').notNull(),
    revision: integer('revision').notNull(),
    changes: integer('changes').notNull(),
    committed_at: integer('committed_at').notNull(),
  },
  table => [index('receipts_through_idx').on(table.through)]
);

/**
 * One admitted upload attempt per hash. Verified rows can satisfy references.
 * Each attempt has its own R2 key; unfinished attempts and unreferenced blobs
 * retain their deadline until cleanup deletes the object and releases the row.
 */
export const blobs = sqliteTable(
  'blobs',
  {
    hash: text('hash').primaryKey(),
    attempt: text('attempt').notNull(),
    bytes: integer('bytes').notNull(),
    state: text('state', { enum: ['pending', 'unreferenced', 'ready', 'cleaning'] }).notNull(),
    deadline: integer('deadline').notNull(),
    created_at: integer('created_at').notNull(),
  },
  table => [
    index('blobs_cleanup_idx')
      .on(table.deadline, table.hash)
      .where(sql`${table.state} <> 'ready'`),
  ]
);
