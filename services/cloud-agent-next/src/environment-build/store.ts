import { and, asc, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';
import {
  autoAttempts,
  buildLogs,
  builds,
  environmentRecord,
  publishedSnapshot,
  type BuildOutcome,
  type BuildState,
} from './sqlite-schema.js';
import {
  BUILD_HISTORY_RETENTION_MS,
  MAX_BUILD_LOG_BYTES,
  MAX_TERMINAL_BUILDS,
  publishedSnapshotSchema,
  type AutoAttempt,
  type PublishedSnapshot,
} from './policy.js';
import { environmentScopeV1Schema, environmentScopeV2Schema } from './reference.js';

/**
 * Synchronous Durable SQLite access for one `EnvironmentBuild` DO. Every write
 * that must be atomic runs in one call here, never across provider I/O.
 */

export type BuildRow = typeof builds.$inferSelect;
export type BuildPatch = Partial<Omit<BuildRow, 'id' | 'request_id' | 'created_at'>>;

export const TERMINAL_STATES: readonly BuildState[] = [
  'succeeded',
  'failed',
  'canceled',
  'obsolete',
];
const ACTIVE_STATES: readonly BuildState[] = [
  'queued',
  'preparing',
  'capturing',
  'publishing',
  'stopping',
];

export function isTerminal(state: BuildState): state is BuildOutcome {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The stored build input JSON. The reference is the environment scope, because a
 * builder clones every repository at its default branch. A V1 build stores
 * `repoFullName`, the path the clone URL is built from. A V2 build stores its
 * repositories in the reference. Exactly one alternative.
 */
export const buildInputRecordSchema = z.union([
  z
    .object({
      reference: environmentScopeV1Schema,
      repoFullName: z.string().min(1),
      commands: z.array(z.string()),
      plainVars: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      reference: environmentScopeV2Schema,
      repoFullName: z.undefined().optional(),
      commands: z.array(z.string()),
      plainVars: z.record(z.string(), z.string()),
    })
    .strict(),
]);
export type BuildInputRecord = z.infer<typeof buildInputRecordSchema>;

const LOG_TRUNCATED_MARKER = '[build log truncated: later output was not kept]';
const LOG_ROWS_PER_INSERT = 30;

export class BuildStore {
  constructor(private readonly db: DrizzleSqliteDODatabase) {}

  activeBuild(): BuildRow | null {
    return (
      this.db
        .select()
        .from(builds)
        .where(inArray(builds.state, [...ACTIVE_STATES]))
        .orderBy(desc(builds.created_at))
        .get() ?? null
    );
  }

  build(buildId: string): BuildRow | null {
    return this.db.select().from(builds).where(eq(builds.id, buildId)).get() ?? null;
  }

  buildByRequest(requestId: string): BuildRow | null {
    return this.db.select().from(builds).where(eq(builds.request_id, requestId)).get() ?? null;
  }

  latestTerminal(): BuildRow | null {
    return (
      this.db
        .select()
        .from(builds)
        .where(inArray(builds.state, [...TERMINAL_STATES]))
        .orderBy(desc(builds.created_at))
        .get() ?? null
    );
  }

  insertBuild(row: typeof builds.$inferInsert): void {
    this.db.insert(builds).values(row).run();
  }

  /**
   * Compare-and-set: apply `patch` only while the build is still in one of
   * `from`. Concurrent RPCs interleave with alarm work across awaits, so every
   * transition re-checks the state it expects.
   */
  transition(buildId: string, from: readonly BuildState[], patch: BuildPatch): BuildRow | null {
    const updated = this.db
      .update(builds)
      .set(patch)
      .where(and(eq(builds.id, buildId), inArray(builds.state, [...from])))
      .returning()
      .get();
    return updated ?? null;
  }

  update(buildId: string, patch: BuildPatch): void {
    this.db.update(builds).set(patch).where(eq(builds.id, buildId)).run();
  }

  /**
   * Append redacted lines within the per-build byte bound. Past the bound one
   * truncation marker is kept and later lines are dropped.
   */
  appendLogs(build: BuildRow, lines: readonly string[]): void {
    let seq = build.log_seq;
    let bytes = build.log_bytes;
    let truncated = build.log_truncated;
    const rows: Array<typeof buildLogs.$inferInsert> = [];
    for (const line of lines) {
      if (truncated) break;
      const size = new TextEncoder().encode(line).byteLength;
      if (bytes + size > MAX_BUILD_LOG_BYTES) {
        truncated = true;
        rows.push({ build_id: build.id, seq: ++seq, text: LOG_TRUNCATED_MARKER });
        break;
      }
      bytes += size;
      rows.push({ build_id: build.id, seq: ++seq, text: line });
    }
    if (rows.length === 0) return;
    // Durable Object SQLite binds at most 100 variables per statement; a row
    // has three.
    for (let index = 0; index < rows.length; index += LOG_ROWS_PER_INSERT) {
      this.db
        .insert(buildLogs)
        .values(rows.slice(index, index + LOG_ROWS_PER_INSERT))
        .run();
    }
    this.update(build.id, { log_seq: seq, log_bytes: bytes, log_truncated: truncated });
  }

  readLogs(buildId: string, cursor: number, limit: number): Array<{ seq: number; text: string }> {
    return this.db
      .select({ seq: buildLogs.seq, text: buildLogs.text })
      .from(buildLogs)
      .where(and(eq(buildLogs.build_id, buildId), gt(buildLogs.seq, cursor)))
      .orderBy(asc(buildLogs.seq))
      .limit(limit)
      .all();
  }

  readRecentLogs(buildId: string, limit: number): Array<{ seq: number; text: string }> {
    return this.db
      .select({ seq: buildLogs.seq, text: buildLogs.text })
      .from(buildLogs)
      .where(eq(buildLogs.build_id, buildId))
      .orderBy(desc(buildLogs.seq))
      .limit(limit)
      .all()
      .reverse();
  }

  published(): PublishedSnapshot | null {
    const row = this.db
      .select()
      .from(publishedSnapshot)
      .where(eq(publishedSnapshot.id, 'current'))
      .get();
    if (!row) return null;
    const parsed = publishedSnapshotSchema.safeParse(JSON.parse(row.descriptor));
    return parsed.success ? parsed.data : null;
  }

  /** Replace the published descriptor; the previous one is gone in the same write. */
  publish(descriptor: PublishedSnapshot): void {
    const value = JSON.stringify(publishedSnapshotSchema.parse(descriptor));
    this.db
      .insert(publishedSnapshot)
      .values({ id: 'current', descriptor: value })
      .onConflictDoUpdate({ target: publishedSnapshot.id, set: { descriptor: value } })
      .run();
  }

  autoAttempt(revision: number): AutoAttempt | null {
    const row = this.db
      .select()
      .from(autoAttempts)
      .where(eq(autoAttempts.revision, revision))
      .get();
    if (!row) return null;
    return {
      failures: row.failures,
      lastFailureAt: row.last_failure_at,
      lastAdmittedAt: row.last_admitted_at,
    };
  }

  recordAutoAdmitted(revision: number, now: number): void {
    this.db
      .insert(autoAttempts)
      .values({ revision, failures: 0, last_failure_at: null, last_admitted_at: now })
      .onConflictDoUpdate({ target: autoAttempts.revision, set: { last_admitted_at: now } })
      .run();
  }

  recordAutoFailure(revision: number, now: number): void {
    const current = this.autoAttempt(revision);
    this.db
      .insert(autoAttempts)
      .values({ revision, failures: 1, last_failure_at: now, last_admitted_at: null })
      .onConflictDoUpdate({
        target: autoAttempts.revision,
        set: { failures: (current?.failures ?? 0) + 1, last_failure_at: now },
      })
      .run();
  }

  recordAutoSuccess(revision: number): void {
    this.db
      .update(autoAttempts)
      .set({ failures: 0, last_failure_at: null })
      .where(eq(autoAttempts.revision, revision))
      .run();
  }

  environment(): { environmentId: string; deletedAt: number | null } | null {
    const row = this.db
      .select()
      .from(environmentRecord)
      .where(eq(environmentRecord.id, 'current'))
      .get();
    return row ? { environmentId: row.environment_id, deletedAt: row.deleted_at } : null;
  }

  /** Remember the environment this DO serves; a different id is a routing defect. */
  bindEnvironment(environmentId: string): void {
    const current = this.environment();
    if (current !== null) {
      if (current.environmentId !== environmentId) {
        throw new Error('Environment build coordinator serves another environment');
      }
      return;
    }
    this.db
      .insert(environmentRecord)
      .values({ id: 'current', environment_id: environmentId, deleted_at: null })
      .run();
  }

  markDeleted(now: number): void {
    this.db
      .update(environmentRecord)
      .set({ deleted_at: now })
      .where(eq(environmentRecord.id, 'current'))
      .run();
  }

  /**
   * Bound history: keep at most `MAX_TERMINAL_BUILDS` terminal records, none
   * older than the retention window, and their logs. Active builds and the
   * published descriptor are never pruned.
   */
  prune(now: number): void {
    const terminal = this.db
      .select({ id: builds.id, created_at: builds.created_at })
      .from(builds)
      .where(inArray(builds.state, [...TERMINAL_STATES]))
      .orderBy(desc(builds.created_at))
      .all();
    const keep = new Set(
      terminal
        .filter(
          (row, index) =>
            index < MAX_TERMINAL_BUILDS && now - row.created_at < BUILD_HISTORY_RETENTION_MS
        )
        .map(row => row.id)
    );
    const remove = terminal.filter(row => !keep.has(row.id)).map(row => row.id);
    if (remove.length === 0) return;
    for (let index = 0; index < remove.length; index += 50) {
      const chunk = remove.slice(index, index + 50);
      this.db.delete(buildLogs).where(inArray(buildLogs.build_id, chunk)).run();
      this.db.delete(builds).where(inArray(builds.id, chunk)).run();
    }
  }

  /** Builds whose stop is due for another attempt, oldest first. */
  dueCleanups(now: number): BuildRow[] {
    return this.db
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.state, 'stopping'),
          or(lt(builds.next_cleanup_at, now + 1), eq(builds.cleanup_attempts, 0))
        )
      )
      .orderBy(asc(builds.created_at))
      .all();
  }

  /** Secret envelopes are kept only while an allocation may still need them. */
  clearSecrets(buildId: string): void {
    this.update(buildId, { encrypted_secrets: null });
  }
}

export function parseBuildInput(row: BuildRow): BuildInputRecord {
  return buildInputRecordSchema.parse(JSON.parse(row.input));
}

export function stageTimes(row: BuildRow): Record<string, number> {
  const parsed = z.record(z.string(), z.number()).safeParse(JSON.parse(row.stage_times));
  return parsed.success ? parsed.data : {};
}

export function withStage(row: BuildRow, stage: string, at: number): string {
  return JSON.stringify({ ...stageTimes(row), [stage]: at });
}
