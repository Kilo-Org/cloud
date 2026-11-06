import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ALLOCATION_KINDS } from './allocation.js';

/**
 * The Sandbox DO stores exactly one allocation row (id `current`) and one row
 * per session route. The allocation row is the persisted reducer state plus the
 * provider pin (how to address and configure the physical sandbox) that must
 * survive eviction. The provider kind is owned by the pin, not by a separate
 * column (M1). The route table is owned by routes.ts (B3).
 */
export const allocation = sqliteTable('allocation', {
  id: text('id').primaryKey(),
  state: text('state', { enum: ALLOCATION_KINDS }).notNull(),
  allocation_id: text('allocation_id'),
  connection_id: text('connection_id'),
  provider_ref: text('provider_ref'),
  wrapper_id: text('wrapper_id'),
  last_frame_at: integer('last_frame_at'),
  last_activity_at: integer('last_activity_at'),
  create_deadline_at: integer('create_deadline_at'),
  first_connect_deadline_at: integer('first_connect_deadline_at'),
  stop_attempt: integer('stop_attempt').notNull(),
  stop_pending: integer('stop_pending', { mode: 'boolean' }).notNull(),
  stop_at: integer('stop_at'),
  unconfirmed_provider_ref: text('unconfirmed_provider_ref'),
  provider_pin: text('provider_pin'),
});

export const routes = sqliteTable('routes', {
  session_id: text('session_id').primaryKey(),
  spec: text('spec').notNull(),
  // A reference to scope_grants.id, not a credential snapshot.
  grant: text('grant'),
  credential_source: text('credential_source'),
  /**
   * Retired repository snapshot key. Kept for the rollback window; no longer
   * written or read.
   */
  repo_key: text('repo_key'),
  /** JSON of the admitted environment reference; null when the session has none. */
  environment: text('environment'),
  state: text('state').notNull(),
  attempt_id: text('attempt_id').notNull(),
  attempt_deadline_at: integer('attempt_deadline_at'),
  reason: text('reason'),
  updated_at: integer('updated_at').notNull(),
});

export const scopeGrants = sqliteTable('scope_grants', {
  id: text('id').primaryKey(),
  grant: text('grant').notNull(),
});

export const workspaceDiskSnapshots = sqliteTable('workspace_disk_snapshots', {
  workspace_id: text('workspace_id').primaryKey(),
  data: text('data', { mode: 'json' }).notNull(),
});

export const workspaceDiskAllocation = sqliteTable('workspace_disk_allocation', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).notNull(),
});

export const workspaceArtifacts = sqliteTable('workspace_artifacts', {
  relative_path: text('relative_path').primaryKey(),
  object_key: text('object_key').notNull(),
  content_hash: text('content_hash').notNull(),
  size_bytes: integer('size_bytes').notNull(),
  content_type: text('content_type').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const workspaceArtifactOrphans = sqliteTable('workspace_artifact_orphans', {
  object_key: text('object_key').primaryKey(),
  queued_at: integer('queued_at').notNull(),
});
