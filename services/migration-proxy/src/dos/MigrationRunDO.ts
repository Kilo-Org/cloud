import { createWorkerSecrets, type Secrets } from '@kilocode/secrets-client';
import { createWorkerServiceTokens, type ServiceTokens } from '@kilocode/service-token-client';
import {
  STS_GITHUB_RELAY_MIGRATION_PROXY_READ,
  migrationProxyAuditStream,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle/migrations';
import {
  FAILURE_CODES,
  PROBE_REASONS,
  isRetryable,
  type AppliedMigration,
  type CreateOutcome,
  type DeniedReason,
  type FailureCode,
  type RunFailure,
  type RunView,
} from '../api';
import type { Attested } from '../attest';
import { AuditLog, auditEventOf, capped, SYSTEM_ACTOR } from '../audit';
import { readConfig, type ProxyConfig } from '../config';
import { blobs, denialWindows, reviewVerdicts, runs, samples, sessionPairs } from '../db/schema';
import type { Env } from '../env';
import {
  GithubUnavailableError,
  createGithubClient,
  gitBlobSha,
  type GithubClient,
} from '../github';
import { cachedGithub } from '../github-cache';
import { parseJournal } from '../journal';
import { checkCodeowners } from '../owners';
import {
  MIGRATIONS_DIR,
  changedPaths,
  reviewChanges,
  subtreeSha,
  type TreeReader,
} from '../review';

/**
 * `MigrationRunDO` (contract §1, §6): one object per environment, addressed only as `runs`. It is
 * the single-run lock. It holds the runs, the blob and GitHub caches, the recorded session pairs
 * and the audit outbox, and it owns the Container through `ctx.container`: it starts it only from
 * a run's `starting` phase or a sample, polls it from 15-second alarms, and destroys it at every
 * final state.
 */

type RunRow = typeof runs.$inferSelect;
type RunValues = Partial<Omit<typeof runs.$inferInsert, 'id' | 'state' | 'phase'>>;

/** The state and phase pairs a run can be in (contract §4); nothing else is ever written. */
type Stage =
  | { state: 'pending'; phase: 'fetching' | 'reviewing' | 'starting' | 'probing' }
  | { state: 'running'; phase: 'migrating' }
  | { state: 'succeeded' | 'failed'; phase: 'done' };
type Run = Omit<RunRow, 'state' | 'phase'> & Stage;
type ActiveRun = Run & { state: 'pending' | 'running' };

const PENDING_PHASES: readonly string[] = ['fetching', 'reviewing', 'starting', 'probing'];

/** A stored run, checked to be in one of the stages above. */
function asRun(row: RunRow): Run {
  const { state, phase } = row;
  const valid =
    (state === 'pending' && PENDING_PHASES.includes(phase)) ||
    (state === 'running' && phase === 'migrating') ||
    ((state === 'succeeded' || state === 'failed') && phase === 'done');
  if (!valid) throw new Error(`run ${row.id} is in no known stage: ${state}/${phase}`);
  // Checked just above: the pair is one of Stage's.
  return row as Run;
}

function isActive(run: Run | null): run is ActiveRun {
  return run !== null && (run.state === 'pending' || run.state === 'running');
}

/** Lost ticks before `container_lost`: the contract's 2 with the container down, more while it is up. */
const LOST_TICKS_DOWN = 2;
const LOST_TICKS_UP = 8;
const APPLY_DEADLINE_MS = 30_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const RELAY_BACKOFF_MAX_MS = 5 * 60 * 1000;

/** The documented maximum (§1); the 15-second alarm keeps the object active during a run. */
export const INACTIVITY_TIMEOUT_MS = 21_600_000;
export const TICK_MS = 15_000;
const RUN_LOCK_HOURLY_CREATIONS = 12;
const RUNS_PER_ATTEMPT = 3;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** §5 step 4: one alarm fetches at most this many blobs, this many at once, for this long. */
const BLOBS_PER_ALARM = 200;
const BLOB_CONCURRENCY = 6;
const FETCH_WALL_MS = 10 * MINUTE_MS;
const MAX_STALLED_ALARMS = 5;
const REVIEW_STALL_MS = 30 * MINUTE_MS;
const CONTAINER_PORT = 8080;
const CONTAINER_READY_WAIT_MS = 20_000;
const CONTAINER_START_LIMIT_MS = 3 * MINUTE_MS;
const SAMPLE_READY_WAIT_MS = 60_000;
const STATUS_DEADLINE_MS = 10_000;
const PAIR_RETENTION_MS = 7 * 24 * HOUR_MS;
const MAX_PAIRS = 100;
const AUDIT_RETRY_MS = 5_000;
const POLL_AFTER_SECONDS = 20;
const GITHUB_RETRY_SECONDS = 30;
const DB_PASSWORD = 'MIGRATION_PROXY_DB_PASSWORD';
const GITHUB_APP_KEY = 'MIGRATION_PROXY_GITHUB_APP_KEY';
const ACTIVE_STATES = ['pending', 'running'] as const;

const PairSchema = z.object({ pid: z.number().int(), backendStart: z.string() });

/** `GET /status` of the container (container/src/apply.ts `RunStatus`). */
const StatusSchema = z.object({
  runId: z.string(),
  phase: z.enum(['probing', 'migrating', 'done']),
  pair: PairSchema.nullable(),
  pending: z.array(z.string()).nullable(),
  applied: z.array(z.object({ tag: z.string(), hash: z.string(), createdAt: z.number() })),
  cleanup: z.object({ terminated: z.number().int(), unexpected: z.number().int() }).nullable(),
  failure: z
    .object({
      code: z.enum(FAILURE_CODES),
      reason: z.enum(PROBE_REASONS).nullable(),
      sqlstate: z.string().nullable(),
      migrationTag: z.string().nullable(),
      indexes: z.array(z.string()),
    })
    .nullable(),
});

/** `POST /sample` of the container. */
const SampleResultSchema = z.object({
  result: z.enum(['ok', 'failed']),
  pair: PairSchema.nullable(),
  unexpected: z.number().int(),
  leftover: z.number().int(),
});

type ProxyContainer = Omit<Container, 'start'> & {
  start(options: { image: string; instance?: 'basic'; enableInternet: true }): void;
};

function failure(
  code: FailureCode,
  detail: Partial<Omit<RunFailure, 'code' | 'retryable'>> = {}
): RunFailure {
  return {
    code,
    retryable: isRetryable(code, detail),
    sqlstate: null,
    migrationTag: null,
    ...detail,
  };
}

function retryAfter(error: GithubUnavailableError, now: number): number {
  if (error.retryAt === null) return GITHUB_RETRY_SECONDS;
  return Math.min(3600, Math.max(1, Math.ceil((error.retryAt - now) / 1000)));
}

export class MigrationRunDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase;
  private readonly audit: AuditLog;
  private secrets: Secrets | null = null;
  private githubClient: { key: string; client: GithubClient } | null = null;
  private serviceTokens: ServiceTokens | null = null;
  /** Run creation and samples run one at a time (§3, §6). */
  private chain: Promise<unknown> = Promise.resolve();
  /** A step finished a phase: the next alarm comes at once instead of after the 15 s tick. */
  private nextPhaseReady = false;
  /** When rows past retention were last pruned; pruning runs at most hourly. */
  private prunedAt = 0;
  /** Consecutive failed audit relays; the retry backs off from 5 s to 5 minutes. */
  private relayFailures = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    this.audit = new AuditLog(this.db, env.AUDIT_QUEUE);
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      // A restarted object re-applies the container's timeout before any alarm or request.
      const container = ctx.container;
      if (container?.running === true) await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    });
  }

  // ---- RPC ----

  async createRun(input: { attested: Attested; sha: string }): Promise<CreateOutcome> {
    return await this.serialized(() => this.create(input));
  }

  async getRun(id: string): Promise<RunView | null> {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    if (row === undefined) return null;
    // CI polls every 20 s: re-arm a lost alarm while the run is active, which staging, with no
    // cron, relies on.
    if (row.state === 'pending' || row.state === 'running') await this.ensureAlarm(Date.now());
    return this.view(row);
  }

  /** `run_denied`, at most one per reason and actor per minute (§7). */
  async recordDenial(input: {
    reason: string;
    actor: string;
    githubRunId: string | null;
  }): Promise<void> {
    const environment = this.environment();
    if (environment === null) return;
    const now = Date.now();
    const inserted = this.db
      .insert(denialWindows)
      .values({ reason: input.reason, actor: input.actor, minute: Math.floor(now / MINUTE_MS) })
      .onConflictDoNothing()
      .returning()
      .all();
    if (inserted.length === 0) return;
    await this.audit.append(
      migrationProxyAuditStream(environment),
      auditEventOf({
        environment,
        type: 'runDenied',
        outcome: 'denied',
        actor: { kind: 'workload', id: input.actor },
        attributes: { reason: input.reason, githubRunId: input.githubRunId },
        now,
      })
    );
    await this.ensureAlarm(now);
  }

  /** Called by the Worker's cron, so the sampled check starts without a run. */
  async wake(): Promise<void> {
    await this.ensureAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const config = readConfig(this.env);
    const stream = config.ok ? migrationProxyAuditStream(config.config.environment) : null;
    await this.relay(stream);
    if (config.ok) {
      const run = this.activeRun();
      try {
        if (run !== undefined) await this.tick(run, config.config, now);
        else await this.serialized(() => this.sampleIfDue(config.config, Date.now()));
      } catch (error) {
        // The object holds no password and no SQL; its own errors name code paths and URLs only.
        console.error(
          'migration-proxy: alarm step failed',
          error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'
        );
      }
    }
    await this.relay(stream);
    const pruneNow = Date.now();
    if (pruneNow >= this.prunedAt + PRUNE_EVERY_MS) {
      this.prune(pruneNow);
      this.prunedAt = pruneNow;
    }
    await this.scheduleNext(config.ok ? config.config : null);
  }

  // ---- creation (§4, §5 step 3, §6) ----

  private async create({
    attested,
    sha,
  }: {
    attested: Attested;
    sha: string;
  }): Promise<CreateOutcome> {
    const loaded = readConfig(this.env);
    if (!loaded.ok) return { kind: 'config_invalid' };
    const config = loaded.config;
    const now = Date.now();
    const { github } = attested;

    const attempt = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.githubRunId, github.runId), eq(runs.githubRunAttempt, github.runAttempt)))
      .orderBy(desc(runs.seq))
      .all();
    const newestOfAttempt = attempt[0];
    if (newestOfAttempt !== undefined) {
      const retryableFailure =
        newestOfAttempt.state === 'failed' && newestOfAttempt.failure?.retryable === true;
      if (!retryableFailure) return { kind: 'existing', run: this.view(newestOfAttempt) };
      if (attempt.length >= RUNS_PER_ATTEMPT) {
        return { kind: 'limited', reason: 'too_many_attempts', retryAfterSeconds: 3600 };
      }
    }

    const active = this.activeRun();
    if (active !== undefined) return { kind: 'busy', activeRunId: active.id };

    const lastHour = this.db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(gt(runs.createdAt, now - HOUR_MS))
      .orderBy(asc(runs.createdAt))
      .all();
    if (lastHour.length >= RUN_LOCK_HOURLY_CREATIONS) {
      const oldest = lastHour[0]?.createdAt ?? now;
      return {
        kind: 'limited',
        reason: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)),
      };
    }

    const deny = async (reason: DeniedReason, attemptedSha?: string): Promise<CreateOutcome> => {
      await this.recordDenial({ reason, actor: attested.workload, githubRunId: github.runId });
      return { kind: 'denied', reason, ...(attemptedSha === undefined ? {} : { attemptedSha }) };
    };

    try {
      const client = this.github(config);
      const toAttested = await client.compare(sha, github.sha);
      if (toAttested !== 'identical' && toAttested !== 'ahead')
        return await deny('sha_not_attested');
      const toMain = await client.compare(github.sha, 'main');
      if (toMain !== 'identical' && toMain !== 'ahead') return await deny('sha_not_on_main');

      // Downgrade guard: nothing at or before the newest succeeded sha, nothing behind the newest
      // attempted one.
      const succeeded = this.newestRun('succeeded');
      if (
        succeeded !== undefined &&
        (succeeded.sha === sha || (await client.compare(sha, succeeded.sha)) === 'ahead')
      ) {
        return { kind: 'already_applied', run: this.view(succeeded) };
      }
      const attempted = this.newestRun();
      if (attempted !== undefined && attempted.sha !== sha) {
        const fromAttempted = await client.compare(attempted.sha, sha);
        if (fromAttempted === 'behind') return await deny('sha_behind_attempted', attempted.sha);
        if (fromAttempted !== 'ahead' && fromAttempted !== 'identical') {
          return await deny('sha_diverged', attempted.sha);
        }
      }
    } catch (error) {
      if (!(error instanceof GithubUnavailableError)) throw error;
      return {
        kind: 'unavailable',
        reason: 'github_unavailable',
        retryAfterSeconds: retryAfter(error, now),
      };
    }

    const id = crypto.randomUUID();
    const row = this.db
      .insert(runs)
      .values({
        id,
        state: 'pending',
        phase: 'fetching',
        sha,
        attestedSha: github.sha,
        githubRunId: github.runId,
        githubRunAttempt: github.runAttempt,
        eventName: github.eventName,
        jobWorkflowRef: github.jobWorkflowRef,
        workload: attested.workload,
        createdAt: now,
        pending: [],
        applied: [],
        progressAt: now,
      })
      .returning()
      .get();
    await this.appendAudit(config.environment, {
      type: 'runStarted',
      outcome: 'success',
      actor: { kind: 'workload', id: attested.workload },
      attributes: {
        runId: id,
        sha,
        attestedSha: github.sha,
        githubRunId: github.runId,
        githubRunAttempt: github.runAttempt,
        eventName: github.eventName,
        jobWorkflowRef: github.jobWorkflowRef,
        repositoryId: github.repositoryId,
      },
    });
    // The first alarm, set for now, starts the fetch.
    await this.ctx.storage.setAlarm(now);
    return { kind: 'accepted', run: this.view(row) };
  }

  // ---- the run's alarm (§5 steps 4-5, §6) ----

  private async tick(run: ActiveRun, config: ProxyConfig, now: number): Promise<void> {
    if (now >= run.createdAt + config.runDeadlineSeconds * 1000) {
      await this.containerFetch('/cancel', { method: 'POST' }).catch(() => null);
      await this.finish(run, config, failure('deadline_exceeded'));
      return;
    }
    switch (run.phase) {
      case 'fetching':
        return await this.fetchStep(run, config, now);
      case 'reviewing':
        return await this.reviewStep(run, config, now);
      case 'starting':
        return await this.startStep(run, config, now);
      case 'probing':
      case 'migrating':
        return await this.pollStep(run, config, now);
    }
  }

  private async fetchStep(run: ActiveRun, config: ProxyConfig, now: number): Promise<void> {
    if (run.githubRetryAt !== null && now < run.githubRetryAt) return;
    let progressed = false;
    const github = cachedGithub(this.db, this.github(config), run.createdAt, Date.now, () => {
      progressed = true;
    });
    try {
      let { journalBlob, files } = run;
      if (journalBlob === null || files === null) {
        const migrationsTree = await subtreeSha(sha => github.tree(sha), run.sha, MIGRATIONS_DIR);
        const entries = migrationsTree === null ? null : await github.tree(migrationsTree);
        const metaTree = entries?.find(entry => entry.name === 'meta' && entry.type === 'tree');
        const meta = metaTree === undefined ? null : await github.tree(metaTree.sha);
        const journal = meta?.find(
          entry => entry.name === '_journal.json' && entry.type === 'blob'
        );
        if (entries === null || journal === undefined) {
          return await this.finish(run, config, failure('journal_invalid'));
        }
        const journalText = await this.storedBlob(github, journal.sha);
        if (journalText === undefined)
          return await this.finish(run, config, failure('journal_invalid'));
        progressed = true;
        const sqlBlobs = new Map(
          entries
            .filter(entry => entry.type === 'blob' && entry.name.endsWith('.sql'))
            .map(entry => [entry.name, entry.sha])
        );
        const parsed = parseJournal(journalText, new Set(sqlBlobs.keys()));
        if (!parsed.ok) return await this.finish(run, config, failure('journal_invalid'));
        journalBlob = journal.sha;
        files = Object.fromEntries(
          parsed.entries.map(entry => [`${entry.tag}.sql`, sqlBlobs.get(`${entry.tag}.sql`) ?? ''])
        );
        if (this.record(run, { journalBlob, files }) === null) return;
      }

      // Every stored sha, not an IN list: a statement binds at most 100 parameters, and the cache
      // holds a few hundred small rows.
      const storedShas = () =>
        new Set(
          this.db
            .select({ sha: blobs.sha })
            .from(blobs)
            .all()
            .map(row => row.sha)
        );
      const needed = [...new Set(Object.values(files))];
      const stored = storedShas();
      const missing = needed.filter(sha => !stored.has(sha)).slice(0, BLOBS_PER_ALARM);
      const stopAt = now + FETCH_WALL_MS;
      let next = 0;
      let invalidText = false;
      let stop = false;
      const worker = async () => {
        while (next < missing.length && Date.now() < stopAt && !stop) {
          const sha = missing[next];
          next += 1;
          try {
            if ((await this.storedBlob(github, sha)) === undefined) {
              invalidText = true;
              stop = true;
            } else {
              progressed = true;
            }
          } catch (error) {
            stop = true;
            throw error;
          }
        }
      };
      // Settle every worker before the alarm moves on, then surface the first failure.
      const settled = await Promise.allSettled(Array.from({ length: BLOB_CONCURRENCY }, worker));
      const rejected = settled.find(result => result.status === 'rejected');
      if (rejected !== undefined) throw rejected.reason;
      if (invalidText) return await this.finish(run, config, failure('journal_invalid'));
      const nowStored = storedShas();
      if (needed.every(sha => nowStored.has(sha))) {
        this.toReviewing(run);
        return;
      }
    } catch (error) {
      if (!(error instanceof GithubUnavailableError)) throw error;
      if (error.retryAt !== null) this.record(run, { githubRetryAt: error.retryAt });
    }
    if (progressed) {
      this.record(run, { stalledAlarms: 0, progressAt: Date.now() });
      return;
    }
    const stalled = run.stalledAlarms + 1;
    if (stalled >= MAX_STALLED_ALARMS)
      return await this.finish(run, config, failure('github_unavailable'));
    this.record(run, { stalledAlarms: stalled });
  }

  /**
   * A blob's text from the cache, or fetched, checked against its git hash and stored. Undefined
   * when the bytes are not UTF-8 text, which no migration file or journal may be; a hash mismatch
   * is treated as GitHub being unavailable.
   */
  private async storedBlob(github: GithubClient, sha: string): Promise<string | undefined> {
    const cached = this.db.select().from(blobs).where(eq(blobs.sha, sha)).get();
    if (cached !== undefined) return cached.content;
    const bytes = await github.blob(sha);
    if ((await gitBlobSha(bytes)) !== sha) throw new GithubUnavailableError('blob hash mismatch');
    let content: string;
    try {
      // The BOM stays: the bytes, BOM included, are what the blob id and the container's
      // reviewed-blob check hash.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
    this.db
      .insert(blobs)
      .values({ sha, content, fetchedAt: Date.now() })
      .onConflictDoNothing()
      .run();
    return content;
  }

  private async reviewStep(run: ActiveRun, config: ProxyConfig, now: number): Promise<void> {
    if (run.githubRetryAt !== null && now < run.githubRetryAt) {
      if (now - run.progressAt > REVIEW_STALL_MS) {
        await this.finish(run, config, failure('github_unavailable'));
      }
      return;
    }
    let progressed = false;
    const github = cachedGithub(this.db, this.github(config), run.createdAt, Date.now, () => {
      progressed = true;
    });
    const read: TreeReader = sha => github.tree(sha);
    try {
      const owners = checkCodeowners(await this.codeownersAt(github, run.sha));
      const reviewBase = this.newestRun('succeeded')?.sha ?? config.reviewBaselineSha;
      if (owners !== 'ok') {
        await this.reviewFailed(run, config, reviewBase, [`.github/CODEOWNERS#-:${owners}`]);
        return await this.finish(run, config, failure(owners));
      }
      const [head, base] = await Promise.all([
        subtreeSha(read, run.sha, MIGRATIONS_DIR),
        subtreeSha(read, reviewBase, MIGRATIONS_DIR),
      ]);
      const changes = await changedPaths(read, MIGRATIONS_DIR, head, base);
      const verdicts = {
        passed: (path: string, blob: string | null) => {
          const row = this.db
            .select()
            .from(reviewVerdicts)
            .where(and(eq(reviewVerdicts.path, path), eq(reviewVerdicts.blob, blob ?? '')))
            .get();
          return row === undefined ? null : { pr: row.pr, approver: row.approver };
        },
        savePassed: (verdict: {
          path: string;
          blob: string | null;
          pr: number;
          approver: string;
        }) => {
          this.db
            .insert(reviewVerdicts)
            .values({ ...verdict, blob: verdict.blob ?? '' })
            .onConflictDoNothing()
            .run();
        },
      };
      const { passed, failed } = await reviewChanges(github, verdicts, run.sha, changes);
      if (failed.length > 0) {
        await this.reviewFailed(
          run,
          config,
          reviewBase,
          failed.map(item => `${item.path}#${item.pr ?? '-'}:${item.reason}`)
        );
        return await this.finish(
          run,
          config,
          failure('migration_not_approved', {
            files: failed.map(item => ({ path: item.path, reason: item.reason, pr: item.pr })),
          })
        );
      }
      const started = this.toStarting(run, { reviewBase, reviewed: passed });
      if (started === null) return;
      await this.appendAudit(config.environment, {
        type: 'reviewCheckPassed',
        outcome: 'success',
        actor: SYSTEM_ACTOR,
        attributes: {
          runId: run.id,
          sha: run.sha,
          reviewBase,
          files: capped(
            passed.map(item => `${item.path}@${item.blob ?? 'absent'}#${item.pr}:${item.approver}`)
          ),
        },
      });
    } catch (error) {
      if (!(error instanceof GithubUnavailableError)) throw error;
      const values: RunValues = error.retryAt === null ? {} : { githubRetryAt: error.retryAt };
      if (progressed) values.progressAt = Date.now();
      this.record(run, values);
      if (!progressed && now - run.progressAt > REVIEW_STALL_MS) {
        await this.finish(run, config, failure('github_unavailable'));
      }
    }
  }

  /** `.github/CODEOWNERS` at the run's commit, or null when the file is missing or not text. */
  private async codeownersAt(github: GithubClient, sha: string): Promise<string | null> {
    const root = await github.tree(sha);
    const dotGithub = root?.find(entry => entry.name === '.github' && entry.type === 'tree');
    const entries = dotGithub === undefined ? null : await github.tree(dotGithub.sha);
    const file = entries?.find(entry => entry.name === 'CODEOWNERS' && entry.type === 'blob');
    if (file === undefined) return null;
    return (await this.storedBlob(github, file.sha)) ?? null;
  }

  private async reviewFailed(
    run: ActiveRun,
    config: ProxyConfig,
    reviewBase: string,
    failures: string[]
  ): Promise<void> {
    this.record(run, { reviewBase });
    await this.appendAudit(config.environment, {
      type: 'reviewCheckFailed',
      outcome: 'failure',
      actor: SYSTEM_ACTOR,
      attributes: { runId: run.id, sha: run.sha, reviewBase, failures: capped(failures) },
    });
  }

  private async startStep(run: ActiveRun, config: ProxyConfig, now: number): Promise<void> {
    const container = this.container();
    if (container === undefined) {
      return await this.finish(run, config, failure('container_start_failed'));
    }
    /** A start or `/apply` that did not land: it counts toward `container_start_failed`. */
    const stall = async (): Promise<void> => {
      const stalled = run.stalledAlarms + 1;
      if (stalled >= MAX_STALLED_ALARMS) {
        return await this.finish(run, config, failure('container_start_failed'));
      }
      this.record(run, { stalledAlarms: stalled });
    };
    let startedAt = run.containerStartedAt;
    if (startedAt === null) {
      try {
        if (!container.running) await this.startContainer(container, config);
      } catch (error) {
        // A refused start must not hold the run in `starting`: it counts like any stalled alarm.
        console.error(
          'migration-proxy: container start refused',
          error instanceof Error ? error.message : 'unknown'
        );
        return await stall();
      }
      startedAt = now;
      if (this.record(run, { containerStartedAt: startedAt }) === null) return;
    }
    if (!(await this.waitReady(CONTAINER_READY_WAIT_MS))) {
      if (now - startedAt > CONTAINER_START_LIMIT_MS) {
        await this.finish(run, config, failure('container_start_failed'));
      }
      return;
    }
    if (run.applySent) return;
    const password = await this.secret(DB_PASSWORD).catch(() => null);
    if (password === null) return await stall();
    const files: Record<string, string> = {};
    for (const [name, sha] of Object.entries(run.files ?? {})) {
      files[name] = this.db.select().from(blobs).where(eq(blobs.sha, sha)).get()?.content ?? '';
    }
    const journal = this.db
      .select()
      .from(blobs)
      .where(eq(blobs.sha, run.journalBlob ?? ''))
      .get()?.content;
    // The password travels only in this body, never in start({ env }) or a log (§3).
    const response = await this.containerFetch('/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: run.id,
        target: config.target,
        user: config.user,
        password,
        loginMode: config.loginMode,
        sessionKey: config.sessionKey,
        recordedPairs: this.recordedPairs(now),
        journal: journal ?? '',
        files,
        reviewed: (run.reviewed ?? []).map(item => ({ path: item.path, blob: item.blob ?? '' })),
      }),
      signal: AbortSignal.timeout(APPLY_DEADLINE_MS),
    }).catch(() => null);
    if (response?.status === 202) {
      this.toProbing(run);
      return;
    }
    if (response?.status === 409) {
      // Another run's container: never reuse it.
      await container.destroy().catch(() => {});
      return await this.finish(run, config, failure('container_start_failed'));
    }
    // No answer in time, or any other status: the container did not take the run.
    await stall();
  }

  private async pollStep(run: ActiveRun, config: ProxyConfig, now: number): Promise<void> {
    const response = await this.containerFetch('/status', {
      signal: AbortSignal.timeout(STATUS_DEADLINE_MS),
    }).catch(() => null);
    const parsed =
      response?.status === 200
        ? StatusSchema.safeParse(await response.json().catch(() => null))
        : null;
    if (parsed?.success !== true || parsed.data.runId !== run.id) {
      // No status, `no_run`, or another run's status: a lost tick, whether or not the container
      // still runs; a running container that stops answering gets more ticks.
      const lostTicks = run.lostTicks + 1;
      const limit = this.container()?.running === true ? LOST_TICKS_UP : LOST_TICKS_DOWN;
      if (lostTicks >= limit) return await this.finish(run, config, failure('container_lost'));
      this.record(run, { lostTicks });
      return;
    }
    const status = parsed.data;
    let current: Run | null = run;
    if (status.pair !== null && run.phase === 'probing') {
      // The probe passed. The run's own pair is stored, once, before anything else uses it (§2).
      this.recordPair(status.pair, run.id, now);
      current = this.toRunning(run, now);
    }
    if (!isActive(current)) return;
    const values: RunValues = { lostTicks: 0, heartbeatAt: now };
    if (status.pending !== null) values.pending = status.pending;
    const cleanup = current.terminatedSessions === null ? status.cleanup : null;
    if (cleanup !== null) {
      values.terminatedSessions = cleanup.terminated;
      values.unexpectedSessions = cleanup.unexpected;
    }
    const known = new Set(current.applied.map(item => item.tag));
    const fresh = status.applied.filter(item => !known.has(item.tag));
    if (fresh.length > 0) values.applied = [...current.applied, ...fresh];
    current = this.record(current, values);
    if (!isActive(current)) return;
    // Audited only once the write landed, so a late answer leaves no row.
    if (cleanup !== null) {
      await this.appendAudit(config.environment, {
        type: 'sessionTerminated',
        outcome: 'success',
        actor: SYSTEM_ACTOR,
        attributes: { runId: run.id, count: cleanup.terminated },
      });
    }
    for (const item of fresh) {
      await this.appendAudit(config.environment, {
        type: 'migrationApplied',
        outcome: 'success',
        actor: SYSTEM_ACTOR,
        attributes: {
          runId: run.id,
          tag: item.tag,
          hash: item.hash,
          createdAt: item.createdAt,
          sha: run.sha,
        },
      });
    }
    if (status.phase !== 'done') return;
    const reported = status.failure;
    await this.finish(
      current,
      config,
      reported === null
        ? null
        : failure(reported.code, {
            ...(reported.code === 'probe_failed' && reported.reason !== null
              ? { reason: reported.reason }
              : {}),
            sqlstate: reported.sqlstate,
            migrationTag: reported.migrationTag,
            ...(reported.code === 'invalid_index_present' ? { indexes: reported.indexes } : {}),
          })
    );
  }

  /**
   * A final state: stored only if the run is still where `run` says, then audited, and the
   * container destroyed. A run another step already finished is left alone.
   */
  private async finish(
    run: ActiveRun,
    config: ProxyConfig,
    outcome: RunFailure | null
  ): Promise<void> {
    const now = Date.now();
    const done = this.transition(
      run,
      { state: outcome === null ? 'succeeded' : 'failed', phase: 'done' },
      { finishedAt: now, failure: outcome }
    );
    if (done === null) return;
    await this.appendAudit(config.environment, {
      type: 'runFinished',
      outcome: outcome === null ? 'success' : 'failure',
      actor: SYSTEM_ACTOR,
      attributes: {
        runId: run.id,
        result: outcome === null ? 'succeeded' : 'failed',
        failureCode: outcome?.code,
        probeReason: outcome?.reason,
        sqlstate: outcome?.sqlstate,
        migrationTag: outcome?.migrationTag,
        invalidIndexes: outcome?.indexes === undefined ? undefined : capped(outcome.indexes),
        unexpectedSessions: done.unexpectedSessions,
        retryable: outcome?.retryable,
        appliedCount: done.applied.length,
        pendingTags: capped(done.pending),
        durationSeconds: Math.round((now - run.createdAt) / 1000),
      },
    });
    const container = this.container();
    if (container?.running === true) await container.destroy().catch(() => {});
  }

  // ---- the sampled check (§3) ----

  private async sampleIfDue(config: ProxyConfig, now: number): Promise<void> {
    if (config.sampleMinutes === 0 || this.activeRun() !== undefined) return;
    if (now < this.nextSampleAt(config)) return;
    const container = this.container();
    const sampleId = crypto.randomUUID();
    this.db.insert(samples).values({ id: sampleId, startedAt: now }).run();
    let result: z.infer<typeof SampleResultSchema> | null = null;
    try {
      if (container !== undefined) {
        if (!container.running) await this.startContainer(container, config);
        if (await this.waitReady(SAMPLE_READY_WAIT_MS)) {
          const password = await this.secret(DB_PASSWORD);
          const response = await this.containerFetch('/sample', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sampleId,
              target: config.target,
              user: config.user,
              password,
              loginMode: config.loginMode,
              sessionKey: config.sessionKey,
              recordedPairs: this.recordedPairs(now),
            }),
            signal: AbortSignal.timeout(SAMPLE_READY_WAIT_MS),
          });
          const parsed = SampleResultSchema.safeParse(await response.json());
          if (parsed.success) result = parsed.data;
        }
      }
    } catch {
      result = null;
    } finally {
      if (container?.running === true) await container.destroy().catch(() => {});
    }
    const ok = result?.result === 'ok';
    if (ok && result?.pair) this.recordPair(result.pair, `sample:${sampleId}`, Date.now());
    const unexpected = ok ? (result?.unexpected ?? 0) : 0;
    const leftover = ok ? (result?.leftover ?? 0) : 0;
    this.db
      .update(samples)
      .set({ finishedAt: Date.now(), result: ok ? 'ok' : 'failed' })
      .where(eq(samples.id, sampleId))
      .run();
    await this.appendAudit(config.environment, {
      type: 'sessionSampled',
      outcome: ok && unexpected === 0 ? 'success' : 'failure',
      actor: SYSTEM_ACTOR,
      attributes: { sampleId, result: ok ? 'ok' : 'failed', unexpected, leftover },
    });
  }

  private nextSampleAt(config: ProxyConfig): number {
    const last = this.db
      .select({ startedAt: samples.startedAt })
      .from(samples)
      .orderBy(desc(samples.startedAt))
      .limit(1)
      .get();
    return last === undefined ? 0 : last.startedAt + config.sampleMinutes * MINUTE_MS;
  }

  // ---- container ----

  /**
   * Starts the container with HTTP(S) out refused: both intercepts are registered before
   * `start()` (an intercept added to a running container has no effect, spike A), then the
   * 6-hour inactivity timeout is set. Raw TCP stays open for Postgres.
   */
  private async startContainer(container: ProxyContainer, config: ProxyConfig): Promise<void> {
    const deny = this.ctx.exports.DenyOutbound({ props: {} });
    await container.interceptAllOutboundHttp(deny);
    await container.interceptOutboundHttps('*', deny);
    const image = container.images.proxy;
    if (image === undefined) throw new Error('container image proxy is not configured');
    // `basic` (§1) everywhere it is deployed; local workerd refuses that name, and the local stack
    // runs on whatever Docker gives it.
    container.start({
      image,
      ...(config.environment === 'development' ? {} : { instance: 'basic' as const }),
      enableInternet: true,
    });
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  private async waitReady(waitMs: number): Promise<boolean> {
    const until = Date.now() + waitMs;
    for (;;) {
      const response = await this.containerFetch('/health', {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      if (response?.status === 200) return true;
      if (Date.now() >= until) return false;
      await scheduler.wait(1_000);
    }
  }

  /**
   * `ctx.container` as the object uses it. `start` takes the `basic` instance name (1/4 vCPU,
   * 1 GiB, 4 GB disk, §1), which the generated workerd types predate (their names stop at `lite`
   * and `standard-*`); the runtime accepts it.
   */
  private container(): ProxyContainer | undefined {
    return this.ctx.container as ProxyContainer | undefined;
  }

  private async containerFetch(path: string, init: RequestInit): Promise<Response> {
    const container = this.container();
    if (container === undefined) throw new Error('no container');
    return await container.getTcpPort(CONTAINER_PORT).fetch(`http://container${path}`, init);
  }

  // ---- state helpers ----

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private activeRun(): ActiveRun | undefined {
    const row = this.db
      .select()
      .from(runs)
      .where(inArray(runs.state, [...ACTIVE_STATES]))
      .orderBy(desc(runs.seq))
      .limit(1)
      .get();
    const run = row === undefined ? null : asRun(row);
    return isActive(run) ? run : undefined;
  }

  private newestRun(state?: 'succeeded'): Run | undefined {
    const row = this.db
      .select()
      .from(runs)
      .where(state === undefined ? undefined : eq(runs.state, state))
      .orderBy(desc(runs.seq))
      .limit(1)
      .get();
    return row === undefined ? undefined : asRun(row);
  }

  // ---- run transitions: each write lands only while the run is where the caller read it ----

  /**
   * Writes `values` (and the new stage `to`) only if the run is still at `run`'s stage. Null means
   * another step moved it first: the caller holds a late result, which is dropped.
   */
  private transition(run: ActiveRun, to: Stage | null, values: RunValues): Run | null {
    const atStage = and(eq(runs.id, run.id), eq(runs.state, run.state), eq(runs.phase, run.phase));
    const changes = { ...values, ...(to ?? {}) };
    // Nothing to write (a deferred step with no news): only check the run is still there.
    const row =
      Object.keys(changes).length === 0
        ? this.db.select().from(runs).where(atStage).get()
        : this.db.update(runs).set(changes).where(atStage).returning().get();
    if (row === undefined) {
      console.warn(
        `migration-proxy: dropped a late result for run ${run.id} at ${run.state}/${run.phase}`
      );
      return null;
    }
    return asRun(row);
  }

  /** A write within the run's current stage. */
  private record(run: ActiveRun, values: RunValues): Run | null {
    return this.transition(run, null, values);
  }

  private toReviewing(run: ActiveRun): Run | null {
    if (run.phase !== 'fetching') return null;
    this.nextPhaseReady = true;
    return this.transition(
      run,
      { state: 'pending', phase: 'reviewing' },
      { stalledAlarms: 0, progressAt: Date.now(), githubRetryAt: null }
    );
  }

  private toStarting(
    run: ActiveRun,
    values: Pick<RunValues, 'reviewBase' | 'reviewed'>
  ): Run | null {
    if (run.phase !== 'reviewing') return null;
    this.nextPhaseReady = true;
    return this.transition(
      run,
      { state: 'pending', phase: 'starting' },
      { ...values, stalledAlarms: 0, progressAt: Date.now(), githubRetryAt: null }
    );
  }

  private toProbing(run: ActiveRun): Run | null {
    if (run.phase !== 'starting') return null;
    return this.transition(
      run,
      { state: 'pending', phase: 'probing' },
      { applySent: true, stalledAlarms: 0 }
    );
  }

  /** The probe passed: the run is `running` from now (§4). */
  private toRunning(run: ActiveRun, startedAt: number): Run | null {
    if (run.phase !== 'probing') return null;
    return this.transition(run, { state: 'running', phase: 'migrating' }, { startedAt });
  }

  private recordPair(
    pair: { pid: number; backendStart: string },
    owner: string,
    now: number
  ): void {
    this.db
      .insert(sessionPairs)
      .values({ pid: pair.pid, backendStart: pair.backendStart, owner, recordedAt: now })
      .onConflictDoNothing()
      .run();
  }

  /** The pairs of the last 7 days, at most the newest 100 (§2). */
  private recordedPairs(now: number): { pid: number; backendStart: string }[] {
    return this.db
      .select({ pid: sessionPairs.pid, backendStart: sessionPairs.backendStart })
      .from(sessionPairs)
      .where(gt(sessionPairs.recordedAt, now - PAIR_RETENTION_MS))
      .orderBy(desc(sessionPairs.recordedAt))
      .limit(MAX_PAIRS)
      .all();
  }

  private prune(now: number): void {
    this.db
      .delete(sessionPairs)
      .where(lt(sessionPairs.recordedAt, now - PAIR_RETENTION_MS))
      .run();
    const keep = this.recordedPairs(now).map(pair => `${pair.pid}@${pair.backendStart}`);
    if (keep.length >= MAX_PAIRS) {
      for (const row of this.db.select().from(sessionPairs).all()) {
        if (!keep.includes(`${row.pid}@${row.backendStart}`)) {
          this.db
            .delete(sessionPairs)
            .where(
              and(eq(sessionPairs.pid, row.pid), eq(sessionPairs.backendStart, row.backendStart))
            )
            .run();
        }
      }
    }
    this.db
      .delete(denialWindows)
      .where(lt(denialWindows.minute, Math.floor((now - HOUR_MS) / MINUTE_MS)))
      .run();
    // Samples older than a week; their audit events stay in the stream.
    this.db
      .delete(samples)
      .where(lt(samples.startedAt, now - PAIR_RETENTION_MS))
      .run();
    this.audit.pruneIfDue(now);
  }

  private async scheduleNext(config: ProxyConfig | null): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];
    const active = this.activeRun() !== undefined;
    if (active) candidates.push(this.nextPhaseReady ? now : now + TICK_MS);
    this.nextPhaseReady = false;
    if (this.audit.hasUnrelayed()) {
      const backoff = Math.min(RELAY_BACKOFF_MAX_MS, AUDIT_RETRY_MS * 2 ** this.relayFailures);
      candidates.push(now + backoff);
    }
    // A sample waits for the run to end; the run's own ticks keep the object awake till then.
    if (!active && config !== null && config.sampleMinutes > 0) {
      candidates.push(Math.max(now + 1_000, this.nextSampleAt(config)));
    }
    const current = await this.ctx.storage.getAlarm();
    if (candidates.length === 0) return;
    const next = Math.min(...candidates);
    // A step may already have asked for an earlier alarm (a phase change sets one for now).
    if (current !== null && current > now && current <= next) return;
    await this.ctx.storage.setAlarm(next);
  }

  private async ensureAlarm(now: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(now);
  }

  private async relay(stream: string | null): Promise<void> {
    if (stream === null) return;
    try {
      await this.audit.relay(stream);
      this.relayFailures = 0;
    } catch (error) {
      this.relayFailures = Math.min(this.relayFailures + 1, 10);
      console.error(
        'migration-proxy: audit relay failed',
        error instanceof Error ? error.name : 'unknown'
      );
    }
  }

  private async appendAudit(
    environment: StsEnvironment,
    event: Omit<Parameters<typeof auditEventOf>[0], 'environment' | 'now'>
  ): Promise<void> {
    await this.audit.append(
      migrationProxyAuditStream(environment),
      auditEventOf({ ...event, environment, now: Date.now() })
    );
  }

  private environment(): StsEnvironment | null {
    const value = this.env.MIGRATION_PROXY_ENVIRONMENT;
    return value === 'production' || value === 'staging' || value === 'development' ? value : null;
  }

  private secret(name: string): Promise<string> {
    this.secrets ??= createWorkerSecrets(this.env.STS);
    return this.secrets.get(name);
  }

  private github(config: ProxyConfig): GithubClient {
    const { appId, installationId, apiUrl, relayUrl } = config.github;
    const key = `${appId}:${installationId}:${apiUrl}:${relayUrl ?? ''}`;
    if (this.githubClient?.key !== key) {
      this.githubClient = {
        key,
        client: createGithubClient(
          {
            appId,
            installationId,
            apiUrl,
            privateKey: () => this.secret(GITHUB_APP_KEY),
            ...(relayUrl === null
              ? {}
              : { relay: { url: relayUrl, token: () => this.relayToken() } }),
          },
          (url, init) => fetch(url, init)
        ),
      };
    }
    return this.githubClient.client;
  }

  /** The STS token for the GitHub relay, held by the client until shortly before it expires. */
  private relayToken(): Promise<string> {
    this.serviceTokens ??= createWorkerServiceTokens(this.env.STS);
    return this.serviceTokens.get(STS_GITHUB_RELAY_MIGRATION_PROXY_READ, {
      waitUntil: promise => this.ctx.waitUntil(promise),
    });
  }

  private view(row: RunRow): RunView {
    const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
    return {
      id: row.id,
      environment: this.environment() ?? 'unknown',
      state: row.state,
      phase: row.phase,
      sha: row.sha,
      attestedSha: row.attestedSha,
      github: {
        runId: row.githubRunId,
        runAttempt: row.githubRunAttempt,
        eventName: row.eventName,
      },
      createdAt: new Date(row.createdAt).toISOString(),
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      heartbeatAt: iso(row.heartbeatAt),
      pending: row.pending,
      applied: row.applied satisfies AppliedMigration[],
      failure: row.failure ?? null,
      pollAfterSeconds: POLL_AFTER_SECONDS,
    };
  }
}
