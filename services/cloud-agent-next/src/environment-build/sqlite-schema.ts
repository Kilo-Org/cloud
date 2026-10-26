import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Durable SQLite of one `EnvironmentBuild` Durable Object (one per environment
 * id). PostgreSQL stays authoritative for configuration and access; this DO owns
 * build records, admission, progress, deadlines, cleanup and the published
 * snapshot descriptor. Nothing here is mirrored to PostgreSQL.
 */

export const BUILD_STATES = [
  'queued',
  'preparing',
  'capturing',
  'publishing',
  'stopping',
  'succeeded',
  'failed',
  'canceled',
  'obsolete',
] as const;
export type BuildState = (typeof BUILD_STATES)[number];

export const BUILD_OUTCOMES = ['succeeded', 'failed', 'canceled', 'obsolete'] as const;
export type BuildOutcome = (typeof BUILD_OUTCOMES)[number];

export const BUILD_TRIGGERS = ['manual', 'session'] as const;
export type BuildTrigger = (typeof BUILD_TRIGGERS)[number];

/**
 * One build. `state` is the single execution state; while `stopping`, `outcome`
 * holds the terminal state the build enters once cleanup is confirmed. Inputs
 * are immutable after admission; the encrypted secrets are cleared once the
 * allocation is gone.
 */
export const builds = sqliteTable(
  'builds',
  {
    id: text('id').primaryKey(),
    request_id: text('request_id').notNull(),
    revision: integer('revision').notNull(),
    trigger: text('trigger', { enum: BUILD_TRIGGERS }).notNull(),
    actor_user_id: text('actor_user_id').notNull(),
    /** JSON: reference, repository path, commands and plaintext variables. */
    input: text('input').notNull(),
    /** JSON envelopes; null once the builder allocation ended. */
    encrypted_secrets: text('encrypted_secrets'),
    instance: text('instance').notNull(),
    /** SHA-256 of the selected runtime release descriptor; null for the baked image. */
    runtime_release: text('runtime_release'),
    state: text('state', { enum: BUILD_STATES }).notNull(),
    outcome: text('outcome', { enum: BUILD_OUTCOMES }),
    failure_reason: text('failure_reason'),
    failure_detail: text('failure_detail'),
    /** Builder allocation; written before the provider request is issued. */
    allocation_id: text('allocation_id'),
    credential_hash: text('credential_hash'),
    launched_at: integer('launched_at'),
    last_heartbeat_at: integer('last_heartbeat_at'),
    last_event_sequence: integer('last_event_sequence'),
    runner_step: text('runner_step'),
    source_commit: text('source_commit'),
    source_branch: text('source_branch'),
    setup_duration_ms: integer('setup_duration_ms'),
    /** Written before the capture request; the capture result is read back by it. */
    capture_id: text('capture_id'),
    /** JSON of the stored capture result. */
    capture_result: text('capture_result'),
    cleanup_attempts: integer('cleanup_attempts').notNull(),
    cleanup_error: text('cleanup_error'),
    next_cleanup_at: integer('next_cleanup_at'),
    log_seq: integer('log_seq').notNull(),
    log_bytes: integer('log_bytes').notNull(),
    log_truncated: integer('log_truncated', { mode: 'boolean' }).notNull(),
    /** JSON map of stage name to epoch ms. */
    stage_times: text('stage_times').notNull(),
    created_at: integer('created_at').notNull(),
    deadline_at: integer('deadline_at').notNull(),
    finished_at: integer('finished_at'),
  },
  table => [
    uniqueIndex('builds_request_id').on(table.request_id),
    index('builds_state').on(table.state),
    index('builds_created_at').on(table.created_at),
  ]
);

/** Redacted output lines of one build, bounded per build. */
export const buildLogs = sqliteTable(
  'build_logs',
  {
    build_id: text('build_id').notNull(),
    seq: integer('seq').notNull(),
    text: text('text').notNull(),
  },
  table => [primaryKey({ columns: [table.build_id, table.seq] })]
);

/**
 * The single published snapshot descriptor (`id = 'current'`). It is replaced
 * atomically by a successful publication and survives history pruning.
 */
export const publishedSnapshot = sqliteTable('published_snapshot', {
  id: text('id').primaryKey(),
  descriptor: text('descriptor').notNull(),
});

/** Automatic-build backoff per configuration revision. */
export const autoAttempts = sqliteTable('auto_attempts', {
  revision: integer('revision').primaryKey(),
  failures: integer('failures').notNull(),
  last_failure_at: integer('last_failure_at'),
  last_admitted_at: integer('last_admitted_at'),
});

/**
 * The environment this DO serves (`id = 'current'`). A recorded deletion stops
 * every later admission and publication, so a late callback cannot recreate it.
 */
export const environmentRecord = sqliteTable('environment', {
  id: text('id').primaryKey(),
  environment_id: text('environment_id').notNull(),
  deleted_at: integer('deleted_at'),
});
