import type { AuditEvent } from '@kilocode/sts-contracts';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AppliedMigration, RunFailure, RunPhase, RunState } from '../api';
import type { PathPassed } from '../review';

/**
 * The SQLite schema of `MigrationRunDO`, the one object per environment (contract §1): runs, the
 * GitHub caches, the recorded session pairs, the sample log, the denial windows and the audit
 * outbox. Change it with `pnpm drizzle-kit generate` (drizzle.config.ts).
 */

export const runs = sqliteTable(
  'runs',
  {
    /** Creation order: "newest" always means the highest seq. */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    state: text('state').$type<RunState>().notNull(),
    phase: text('phase').$type<RunPhase>().notNull(),
    sha: text('sha').notNull(),
    attestedSha: text('attested_sha').notNull(),
    githubRunId: text('github_run_id').notNull(),
    githubRunAttempt: text('github_run_attempt').notNull(),
    eventName: text('event_name').notNull(),
    jobWorkflowRef: text('job_workflow_ref').notNull(),
    workload: text('workload').notNull(),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    heartbeatAt: integer('heartbeat_at'),
    pending: text('pending', { mode: 'json' }).$type<string[]>().notNull(),
    applied: text('applied', { mode: 'json' }).$type<AppliedMigration[]>().notNull(),
    failure: text('failure', { mode: 'json' }).$type<RunFailure>(),
    /** `meta/_journal.json`'s blob and each `<tag>.sql`'s blob at the run's sha, once walked. */
    journalBlob: text('journal_blob'),
    files: text('files', { mode: 'json' }).$type<Record<string, string>>(),
    reviewBase: text('review_base'),
    reviewed: text('reviewed', { mode: 'json' }).$type<PathPassed[]>(),
    /** Consecutive alarms without progress in the current phase. */
    stalledAlarms: integer('stalled_alarms').notNull().default(0),
    /** When the current phase last made progress; the reviewing timeout counts from it. */
    progressAt: integer('progress_at').notNull(),
    /** GitHub asked to wait until then (rate limit); no GitHub call before it. */
    githubRetryAt: integer('github_retry_at'),
    containerStartedAt: integer('container_started_at'),
    applySent: integer('apply_sent', { mode: 'boolean' }).notNull().default(false),
    /** Consecutive ticks with the container not running and `/status` failing. */
    lostTicks: integer('lost_ticks').notNull().default(0),
    terminatedSessions: integer('terminated_sessions'),
    unexpectedSessions: integer('unexpected_sessions'),
  },
  table => [
    index('runs_state').on(table.state),
    index('runs_attempt').on(table.githubRunId, table.githubRunAttempt),
  ]
);

/** Fetched blobs, keyed by git blob sha (verified against it before they are stored). */
export const blobs = sqliteTable('blobs', {
  sha: text('sha').primaryKey(),
  content: text('content').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

/**
 * GitHub answers that never change for their key: trees by sha, the newest commit touching a
 * path at a commit, the merged PR of a commit, the blob at a review's commit. A PR's reviews do
 * change; their entry is used only when fetched after the run was created.
 */
export const githubCache = sqliteTable('github_cache', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

/** Paths that passed the owner-approval check; `blob` is '' for a deletion. */
export const reviewVerdicts = sqliteTable(
  'review_verdicts',
  {
    path: text('path').notNull(),
    blob: text('blob').notNull(),
    pr: integer('pr').notNull(),
    approver: text('approver').notNull(),
  },
  table => [primaryKey({ columns: [table.path, table.blob] })]
);

/** `(pg_backend_pid(), backend_start)` of each run's and sample's own session (§2), 7 days. */
export const sessionPairs = sqliteTable(
  'session_pairs',
  {
    pid: integer('pid').notNull(),
    backendStart: text('backend_start').notNull(),
    owner: text('owner').notNull(),
    recordedAt: integer('recorded_at').notNull(),
  },
  table => [primaryKey({ columns: [table.pid, table.backendStart] })]
);

export const samples = sqliteTable('samples', {
  id: text('id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  result: text('result').$type<'ok' | 'failed'>(),
});

/** One `run_denied` per reason and actor per minute (§7). */
export const denialWindows = sqliteTable(
  'denial_windows',
  {
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    minute: integer('minute').notNull(),
  },
  table => [primaryKey({ columns: [table.reason, table.actor, table.minute] })]
);

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
