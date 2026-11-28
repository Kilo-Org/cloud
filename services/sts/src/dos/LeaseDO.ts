import { withDORetry } from '@kilocode/worker-utils';
import {
  LEASE_GRANT_MAX_TTL_SECONDS,
  LEASE_MIN_TTL_SECONDS,
  LeaseGrantSchema,
  LeaseIdSchema,
  StsEnvironmentSchema,
  WorkloadNameSchema,
  type LeaseGrant,
  type LeaseLimitedReason,
} from '@kilocode/sts-contracts';
import { DurableObject } from 'cloudflare:workers';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle.lease/migrations';
import {
  leaseCreatedEvent,
  leaseReplicaSweptEvent,
  leaseRevokedEvent,
  type LeaseAuditCaller,
  type LeaseRevocationResult,
  type LeaseRevokeCause,
  type ReplicaSweepResult,
} from '../audit/events';
import { AuditLog } from '../audit/log';
import {
  LEASE_CREATE_BUDGET_MS,
  LEASE_CREATES_PER_MINUTE,
  LEASE_EXPIRY_TOLERANCE_MS,
  LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR,
  LEASE_REPLICA_SWEEP_INTERVAL_MS,
  LEASE_RETRY_AFTER_SECONDS,
  LEASE_REVOKE_CLEANUP_MS,
  LEASE_REVOKE_RETRIES_PER_ALARM,
  LEASE_REVOKE_RETRY_MS,
  LEASE_ROW_RETENTION_MS,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
} from '../constants';
import * as schema from '../db/lease-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { InfisicalClient, type DynamicSecretRef } from '../infisical/client';
import { sweepReplica, type ReplicaSweep } from '../leases/replica-sweep';
import { getSignerStub } from './stubs';

type LeaseDatabase = DrizzleSqliteDODatabase<typeof schema>;
type LeaseRow = typeof schema.lease.$inferSelect;

/**
 * Each grant's Infisical dynamic secret (README "Database leases"), alone in its own folder so the
 * STS identity's `lease` permission can name it.
 */
export const LEASE_DYNAMIC_SECRETS: Readonly<Record<LeaseGrant, DynamicSecretRef>> = {
  'replica-read': { name: 'replica-read', path: '/dynamic/replica-read' },
};

const MINUTE_MS = 60 * 1000;

/** A lease caller is a Worker in the account: only `replica-read` exists, for worker bindings. */
const CallerSchema = z.strictObject({
  workload: WorkloadNameSchema,
  identity: z.literal('worker-binding'),
  channel: z.literal('worker-binding'),
  run: z.null(),
});

/** What STS asks the lease object for, after its policy check allowed the grant and the lifetime. */
export type LeaseCreateRequest = {
  environment: string;
  caller: LeaseAuditCaller;
  grant: LeaseGrant;
  ttlSeconds: number;
  requestedTtlSeconds: number | null;
  clamped: boolean;
  /** The policy's limit on this workload's active leases of this grant. */
  maxActive: number;
  /**
   * When STS called this object (epoch milliseconds), the start of its own wait: the creation
   * budget runs from here.
   */
  requestedAt: number;
};

const LeaseCreateRequestSchema = z
  .strictObject({
    environment: StsEnvironmentSchema,
    caller: CallerSchema,
    grant: LeaseGrantSchema,
    ttlSeconds: z.number().int().min(LEASE_MIN_TTL_SECONDS),
    requestedTtlSeconds: z.number().int().positive().nullable(),
    clamped: z.boolean(),
    maxActive: z.number().int().min(1),
    requestedAt: z.number().int().positive(),
  })
  .refine(request => request.ttlSeconds <= LEASE_GRANT_MAX_TTL_SECONDS[request.grant], {
    message: 'ttlSeconds is above the grant maximum',
  });

export type LeaseCreateResult =
  /** Handed to the caller; its audit row is committed. */
  | { status: 'created'; leaseId: string; username: string; password: string; expiresAt: number }
  | { status: 'limited'; reason: LeaseLimitedReason; retryAfterSeconds: number }
  | { status: 'unavailable'; retryAfterSeconds: number };

export type LeaseRevokeRequest = { environment: string; caller: LeaseAuditCaller; leaseId: string };

const LeaseRevokeRequestSchema = z.strictObject({
  environment: StsEnvironmentSchema,
  caller: CallerSchema,
  leaseId: LeaseIdSchema,
});

export type LeaseRevokeOutcome =
  | { status: 'revoked' }
  /** The caller hears `not_found` in every case; the reason is for its denial row. */
  | { status: 'not_found'; reason: 'not_owner' | 'unknown_lease' }
  | { status: 'unavailable'; retryAfterSeconds: number };

function retryAfterSeconds(ms: number | null): number {
  if (ms === null) return LEASE_RETRY_AFTER_SECONDS;
  return Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** A replica's sweep result for logs and audit: the error's name and code (a SQLSTATE or errno). */
function sweepFailureDetail(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return code === null ? errorName(error) : `${errorName(error)} ${code}`;
}

/** A Hyperdrive binding as the sweep uses it. */
const HyperdriveBindingSchema = z.object({ connectionString: z.string().min(1) });

/** `LEASE_REPLICA_SWEEP_BINDINGS` names a binding this Worker does not have. */
class ReplicaBindingMissingError extends Error {
  override name = 'ReplicaBindingMissingError';
}

/**
 * The row of a revocation STS stopped without Infisical confirming it, a day past the lease's
 * expiry: a delivered lease ends in state `unconfirmed` (a later revoke answers without making it
 * owed again), an undelivered one stays `failed`.
 */
function unconfirmedEnd(row: LeaseRow, now: number): Partial<LeaseRow> {
  return {
    state: row.state === 'active' ? 'unconfirmed' : row.state,
    endedAt: now,
    revokeCause: null,
    revokeRetryAt: null,
  };
}

/**
 * One object per environment (design 6.1 job 3): it creates and revokes database leases through
 * Infisical's dynamic secrets, keeps one row per lease with its owner (never a username or
 * password), enforces each workload's active and per-minute limits, and owns the
 * `sts:<environment>:leases` audit stream. A lease is returned only with its `lease.created` row
 * committed; one STS cannot hand over (too late, an unexpected expiry, or a failed audit append) is
 * revoked at once. A revocation Infisical does not confirm is audited as `revoke_failed` and retried
 * by the alarm until Infisical confirms it, also after the lease expired (expiry stops new logins,
 * not open sessions), for at most a day past the expiry; then it is audited as `unconfirmed` and
 * logged as an error. It also sweeps each configured read replica once a minute, ending there the
 * sessions of lease roles that are gone, blocked or past `VALID UNTIL`, since a revocation or an
 * expiry ends sessions on the primary only (design decision Q63). Leases are few (a few hundred a
 * day), so one object serves the environment.
 * A stub can call every prototype method, so everything but `create`, `revoke` and `alarm` is
 * ECMAScript-private: no caller revokes a lease past `revoke`'s owner check. `ensureSweeping` only
 * schedules the alarm.
 */
export class LeaseDO extends DurableObject<Env> {
  /**
   * Runs one sweep of one replica; a test replaces it, as no Postgres runs in the Workers pool
   * (the end-to-end check runs the real one, README "Tests").
   */
  static replicaSweep: ReplicaSweep = sweepReplica;

  readonly #config: StsConfig;
  readonly #db: LeaseDatabase;
  readonly #audit: AuditLog;
  readonly #stream: string;
  readonly #client: InfisicalClient;
  /**
   * Revocations in flight, by lease id: concurrent revokes of one lease (callers and the alarm)
   * share one manager call.
   */
  readonly #revoking = new Map<string, Promise<LeaseRevocationResult>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = readConfig(env);
    this.#config = config;
    this.#db = drizzle(ctx.storage, { schema });
    this.#audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE);
    this.#stream = `sts:${config.environment}:leases`;
    this.#client = new InfisicalClient(config.manager, () =>
      withDORetry(
        () => getSignerStub(env, config),
        stub => stub.signManagerToken(),
        'sts.signManagerToken'
      )
    );
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.#db, migrations);
    });
  }

  /**
   * Creates one lease. The budget runs from when STS called this object, so a slow start of
   * this object counts. The pending row taken before the manager call holds the workload's slot,
   * so concurrent requests cannot pass the limits together. Never retried by STS (see
   * `InfisicalClient.createLease`).
   */
  async create(raw: LeaseCreateRequest): Promise<LeaseCreateResult> {
    const input = LeaseCreateRequestSchema.parse(raw);
    if (input.environment !== this.#config.environment) {
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    if (this.#config.manager.projectSlug === null) {
      console.warn('sts: lease refused: MANAGER_PROJECT_SLUG is empty in this environment');
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    const { caller, grant } = input;
    const callStartedAt = Date.now();
    // A Worker clock ahead of this one must not lengthen the budget.
    const deadline = Math.min(input.requestedAt, callStartedAt) + LEASE_CREATE_BUDGET_MS;
    if (callStartedAt >= deadline) {
      console.error('sts: lease request reached the lease object after its budget; none is made', {
        workload: caller.workload,
        grant,
      });
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    const limited = this.#limitFor(caller.workload, grant, input.maxActive, callStartedAt);
    if (limited !== null) return limited;

    const { slot } = this.#db
      .insert(schema.lease)
      .values({
        workload: caller.workload,
        caller: JSON.stringify(caller),
        grant,
        state: 'pending',
        createdAt: callStartedAt,
        expiresAt: deadline,
      })
      .returning({ slot: schema.lease.slot })
      .get();

    const created = await this.#client.createLease(LEASE_DYNAMIC_SECRETS[grant], input.ttlSeconds);
    const finishedAt = Date.now();
    if (created.status === 'unreachable') {
      console.error('sts: lease creation failed', {
        workload: caller.workload,
        grant,
        detail: created.detail,
      });
      this.#end(slot, 'failed', finishedAt);
      await this.#scheduleAlarm(finishedAt, false);
      return { status: 'unavailable', retryAfterSeconds: retryAfterSeconds(created.retryAfterMs) };
    }

    // Infisical sets the expiry from its own clock, somewhere between the call's start and end.
    const ttlMs = input.ttlSeconds * 1000;
    let cause: LeaseRevokeCause | null = null;
    if (finishedAt > deadline) {
      cause = 'late';
    } else if (
      created.expiresAt < callStartedAt + ttlMs - LEASE_EXPIRY_TOLERANCE_MS ||
      created.expiresAt > finishedAt + ttlMs + LEASE_EXPIRY_TOLERANCE_MS
    ) {
      cause = 'expiry_mismatch';
    } else {
      try {
        await this.#audit.append(
          this.#stream,
          leaseCreatedEvent({
            environment: this.#config.environment,
            caller,
            grant,
            leaseId: created.leaseId,
            ttlSeconds: input.ttlSeconds,
            requestedTtlSeconds: input.requestedTtlSeconds,
            clamped: input.clamped,
            expiresAt: created.expiresAt,
          })
        );
        // The row is written; the lease still goes back only while STS is waiting for it.
        if (Date.now() > deadline) cause = 'late';
      } catch (error) {
        console.error('sts: lease audit append failed; the lease is revoked', {
          workload: caller.workload,
          reason: errorName(error),
        });
        cause = 'audit_failed';
      }
    }
    if (cause !== null) {
      // Owed until Infisical takes it: the alarm retries this row if the first attempt fails.
      this.#db
        .update(schema.lease)
        .set({
          leaseId: created.leaseId,
          state: 'failed',
          expiresAt: created.expiresAt,
          revokeCause: cause,
        })
        .where(eq(schema.lease.slot, slot))
        .run();
      await this.#revokeOnce(created.leaseId);
      await this.#scheduleAlarm(Date.now(), false);
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    // In the same output gate as the audit row.
    this.#db
      .update(schema.lease)
      .set({ leaseId: created.leaseId, state: 'active', expiresAt: created.expiresAt })
      .where(eq(schema.lease.slot, slot))
      .run();
    await this.#scheduleAlarm(Date.now(), false);
    return {
      status: 'created',
      leaseId: created.leaseId,
      username: created.username,
      password: created.password,
      expiresAt: created.expiresAt,
    };
  }

  /**
   * Revokes one of the caller's own leases. A lease id STS never handed to this workload is
   * `not_found`, whoever holds it. A lease STS already revoked answers `revoked` without a manager
   * call, and one whose revocation STS stopped unconfirmed answers `unavailable` without one; an
   * expired one still goes to Infisical, since expiry alone does not end an open session (Infisical
   * answers 404 once its own expiry revocation succeeded).
   */
  async revoke(raw: LeaseRevokeRequest): Promise<LeaseRevokeOutcome> {
    const input = LeaseRevokeRequestSchema.parse(raw);
    if (input.environment !== this.#config.environment) {
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    const row = this.#db
      .select()
      .from(schema.lease)
      .where(eq(schema.lease.leaseId, input.leaseId))
      .get();
    if (row === undefined || row.state === 'failed' || row.state === 'pending') {
      return { status: 'not_found', reason: 'unknown_lease' };
    }
    if (row.workload !== input.caller.workload) return { status: 'not_found', reason: 'not_owner' };
    if (row.state === 'revoked') return { status: 'revoked' };
    if (row.state === 'unconfirmed') {
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }

    if (row.revokeCause === null) {
      // Owed from now on: the alarm retries it if Infisical cannot take it.
      this.#db
        .update(schema.lease)
        .set({ revokeCause: 'caller' })
        .where(eq(schema.lease.slot, row.slot))
        .run();
    }
    const result = await this.#revokeOnce(input.leaseId);
    await this.#scheduleAlarm(Date.now(), false);
    return result === 'revoke_failed' || result === 'unconfirmed'
      ? { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS }
      : { status: 'revoked' };
  }

  /**
   * The cron calls this every 5 minutes while replicas are configured, so the sweep runs without
   * a lease call: Infisical's own expiry never calls STS. Idempotent.
   */
  async ensureSweeping(): Promise<void> {
    await this.#scheduleAlarm(Date.now(), false);
  }

  /**
   * The replica sweep starts first and runs beside the rest, timed from when the alarm fired, so a
   * slow or failing relay, Infisical call or row write never delays it; neither can a throw in that
   * upkeep skip the sweep or the next alarm. The next alarm is scheduled as soon as the sweep ends,
   * so a long upkeep cannot hold it back, and again once the upkeep ends.
   */
  async alarm(): Promise<void> {
    const firedAt = Date.now();
    const sweep = this.#sweepReplicas(firedAt).catch((error: unknown) => {
      console.error('sts: replica sweep did not run; the next alarm retries it', {
        reason: errorName(error),
      });
    });
    const upkeep = this.#upkeep();
    await sweep;
    await this.#scheduleSweepAlarm(Date.now());
    const relayFailed = await upkeep;
    await this.#scheduleAlarm(Date.now(), relayFailed);
  }

  /**
   * The alarm's work beside the sweep: the audit relay, owed revocations, stopping unconfirmed ones
   * and pruning. Never throws; answers whether the relay failed.
   */
  async #upkeep(): Promise<boolean> {
    let relayFailed = false;
    try {
      await this.#audit.relay(this.#stream);
    } catch (error) {
      relayFailed = true;
      console.warn('sts: lease audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    try {
      await this.#retryOwedRevocations();
      const now = Date.now();
      await this.#stopUnconfirmedRevocations(now);
      this.#audit.pruneIfDue(now);
      this.#db
        .delete(schema.lease)
        .where(
          and(
            isNull(schema.lease.revokeCause),
            lt(
              sql`coalesce(${schema.lease.endedAt}, ${schema.lease.expiresAt})`,
              now - LEASE_ROW_RETENTION_MS
            )
          )
        )
        .run();
    } catch (error) {
      console.error('sts: lease alarm upkeep failed; the next alarm retries it', {
        reason: errorName(error),
      });
    }
    return relayFailed;
  }

  /**
   * The refusal for a workload at its limits: its active leases of this grant (a pending creation
   * counts), then its creations of any grant in the last minute, whatever their outcome.
   */
  #limitFor(
    workload: string,
    grant: LeaseGrant,
    maxActive: number,
    now: number
  ): LeaseCreateResult | null {
    const active = this.#db
      .select({ expiresAt: schema.lease.expiresAt })
      .from(schema.lease)
      .where(
        and(
          eq(schema.lease.workload, workload),
          eq(schema.lease.grant, grant),
          inArray(schema.lease.state, ['pending', 'active']),
          gt(schema.lease.expiresAt, now)
        )
      )
      .all();
    if (active.length >= maxActive) {
      const soonest = Math.min(...active.map(row => row.expiresAt));
      return {
        status: 'limited',
        reason: 'too_many_active',
        retryAfterSeconds: retryAfterSeconds(soonest - now),
      };
    }
    const recent = this.#db
      .select({ createdAt: schema.lease.createdAt })
      .from(schema.lease)
      .where(and(eq(schema.lease.workload, workload), gt(schema.lease.createdAt, now - MINUTE_MS)))
      .orderBy(asc(schema.lease.createdAt))
      .all();
    if (recent.length >= LEASE_CREATES_PER_MINUTE) {
      return {
        status: 'limited',
        reason: 'rate_limited',
        retryAfterSeconds: retryAfterSeconds(recent[0].createdAt + MINUTE_MS - now),
      };
    }
    return null;
  }

  /** One revocation attempt of an owed lease, shared with any attempt already in flight. */
  async #revokeOnce(leaseId: string): Promise<LeaseRevocationResult> {
    const inFlight = this.#revoking.get(leaseId);
    if (inFlight !== undefined) return await inFlight;
    const pending = this.#attemptRevocation(leaseId).finally(() => {
      this.#revoking.delete(leaseId);
    });
    this.#revoking.set(leaseId, pending);
    return await pending;
  }

  /**
   * Asks Infisical to revoke an owed lease (its row carries `revokeCause`), and sets when the alarm
   * may try it next. On success it writes `lease.revoked` and ends the row. When Infisical cannot
   * be reached, the first failure whose `revoke_failed` row is written marks the row, so later
   * failures write none, and an append that failed is tried again on the next failure. A failed
   * audit append after a success also leaves it owed: the retry finds the lease gone and writes
   * the row then. A 404 after a recorded failure is `gone` as well: Infisical keeps a lease whose
   * revocation statement failed (a 200 with the row and its "Failed to delete" status, never a 404)
   * and deletes it only once a revocation succeeds; the success's own 200 still carries that stale
   * status, so the 404 that follows is the confirmation (README trial check 3, run on 2026-11-26).
   * Its row says `detail: gone_after_failure` and it logs a warning, not an error: a forced delete
   * at Infisical would look the same (README Risks), so it stays visible without paging.
   */
  async #attemptRevocation(leaseId: string): Promise<LeaseRevocationResult> {
    const row = this.#db.select().from(schema.lease).where(eq(schema.lease.leaseId, leaseId)).get();
    if (row === undefined || row.revokeCause === null) return 'gone';
    const cause = row.revokeCause;
    const caller: LeaseAuditCaller = CallerSchema.parse(JSON.parse(row.caller));
    this.#setRevokeRetryAt(row.slot, Date.now() + LEASE_REVOKE_RETRY_MS);
    const revocation = await this.#client.revokeLease(LEASE_DYNAMIC_SECRETS[row.grant], leaseId);
    const result: LeaseRevocationResult =
      revocation.status === 'unreachable' ? 'revoke_failed' : revocation.status;
    const goneAfterFailure = result === 'gone' && row.revokeFailureAudited;
    if (goneAfterFailure) {
      console.warn(
        'sts: Infisical no longer has a lease whose revocation failed before; read as revoked',
        { workload: row.workload, grant: row.grant, cause, leaseId }
      );
    }
    if (revocation.status === 'unreachable') {
      const expired = row.expiresAt <= Date.now();
      console.error(
        expired
          ? 'sts: lease revocation still unconfirmed after the lease expired; its sessions may still be open, the lease object retries it'
          : 'sts: lease revocation failed; the lease object retries it',
        { workload: row.workload, grant: row.grant, cause, detail: revocation.detail }
      );
      if (revocation.retryAfterMs !== null && revocation.retryAfterMs > LEASE_REVOKE_RETRY_MS) {
        this.#setRevokeRetryAt(row.slot, Date.now() + revocation.retryAfterMs);
      }
      if (row.revokeFailureAudited) return result;
    }
    try {
      await this.#audit.append(
        this.#stream,
        leaseRevokedEvent({
          environment: this.#config.environment,
          caller,
          grant: row.grant,
          leaseId,
          cause,
          result,
          ...(goneAfterFailure ? { detail: 'gone_after_failure' as const } : {}),
        })
      );
    } catch (error) {
      console.error('sts: lease revocation audit append failed', {
        workload: row.workload,
        reason: errorName(error),
      });
      return 'revoke_failed';
    }
    const now = Date.now();
    this.#db
      .update(schema.lease)
      .set(
        result === 'revoke_failed'
          ? { revokeFailureAudited: true }
          : {
              state: row.state === 'active' ? 'revoked' : 'failed',
              endedAt: now,
              revokeCause: null,
              revokeRetryAt: null,
            }
      )
      .where(eq(schema.lease.slot, row.slot))
      .run();
    return result;
  }

  #setRevokeRetryAt(slot: number, at: number): void {
    this.#db
      .update(schema.lease)
      .set({ revokeRetryAt: at })
      .where(eq(schema.lease.slot, slot))
      .run();
  }

  /**
   * The owed revocations that are due by `dueBy`, least recently tried first: those of unexpired
   * leases and of leases that expired less than `LEASE_REVOKE_CLEANUP_MS` ago, since expiry ends no
   * open session.
   */
  #owedRevocations(now: number, dueBy: number, limit: number): LeaseRow[] {
    return this.#db
      .select()
      .from(schema.lease)
      .where(
        and(
          isNotNull(schema.lease.revokeCause),
          isNotNull(schema.lease.leaseId),
          inArray(schema.lease.state, ['active', 'failed']),
          gt(schema.lease.expiresAt, now - LEASE_REVOKE_CLEANUP_MS),
          or(isNull(schema.lease.revokeRetryAt), lte(schema.lease.revokeRetryAt, dueBy))
        )
      )
      .orderBy(sql`coalesce(${schema.lease.revokeRetryAt}, 0)`, asc(schema.lease.slot))
      .limit(limit)
      .all();
  }

  async #retryOwedRevocations(): Promise<void> {
    const now = Date.now();
    for (const row of this.#owedRevocations(now, now, LEASE_REVOKE_RETRIES_PER_ALARM)) {
      if (row.leaseId === null) continue;
      await this.#revokeOnce(row.leaseId);
    }
  }

  /**
   * Stops the owed revocations whose lease expired `LEASE_REVOKE_CLEANUP_MS` ago with no attempt
   * confirmed: each gets a `lease.revoked` row with result `unconfirmed` and an error log, for a
   * person to end the role's sessions by hand, and a delivered lease ends in state `unconfirmed`, so
   * a later revoke makes it owed no more. One whose row cannot be written stays owed and is tried
   * again `LEASE_REVOKE_RETRY_MS` later.
   */
  async #stopUnconfirmedRevocations(now: number): Promise<void> {
    const rows = this.#db
      .select()
      .from(schema.lease)
      .where(
        and(
          isNotNull(schema.lease.revokeCause),
          isNotNull(schema.lease.leaseId),
          lte(schema.lease.expiresAt, now - LEASE_REVOKE_CLEANUP_MS),
          or(isNull(schema.lease.revokeRetryAt), lte(schema.lease.revokeRetryAt, now))
        )
      )
      .all();
    for (const row of rows) {
      if (row.leaseId === null || row.revokeCause === null) continue;
      console.error(
        'sts: lease revocation unconfirmed a day after the lease expired; the lease object stopped retrying, end the role sessions by hand',
        { workload: row.workload, grant: row.grant, cause: row.revokeCause, leaseId: row.leaseId }
      );
      try {
        await this.#audit.append(
          this.#stream,
          leaseRevokedEvent({
            environment: this.#config.environment,
            caller: CallerSchema.parse(JSON.parse(row.caller)),
            grant: row.grant,
            leaseId: row.leaseId,
            cause: row.revokeCause,
            result: 'unconfirmed',
          })
        );
      } catch (error) {
        console.error('sts: lease revocation audit append failed', {
          workload: row.workload,
          reason: errorName(error),
        });
        this.#setRevokeRetryAt(row.slot, now + LEASE_REVOKE_RETRY_MS);
        continue;
      }
      this.#db
        .update(schema.lease)
        .set(unconfirmedEnd(row, now))
        .where(eq(schema.lease.slot, row.slot))
        .run();
    }
  }

  #end(slot: number, state: 'failed' | 'revoked', at: number): void {
    this.#db
      .update(schema.lease)
      .set({ state, endedAt: at })
      .where(eq(schema.lease.slot, slot))
      .run();
  }

  /**
   * The earliest time a lease row is due for deletion, or for an owed revocation to stop (a day
   * after its lease expired, or its next try when writing its row failed), or null for none.
   */
  #nextRowDueAt(): number | null {
    const row = this.#db
      .select({
        due: sql<
          number | null
        >`min(case when ${schema.lease.revokeCause} is null then coalesce(${schema.lease.endedAt}, ${schema.lease.expiresAt}) + ${LEASE_ROW_RETENTION_MS} else max(${schema.lease.expiresAt} + ${LEASE_REVOKE_CLEANUP_MS}, coalesce(${schema.lease.revokeRetryAt}, 0)) end)`,
      })
      .from(schema.lease)
      .get();
    return row === undefined || row.due === null ? null : row.due;
  }

  /**
   * Sweeps each configured replica whose sweep is due, all at once, and forgets the rows of
   * replicas no longer configured. Each replica gets one attempt per interval; a failure waits for
   * the next one (README "Replica sessions").
   */
  async #sweepReplicas(firedAt: number): Promise<void> {
    const replicas = this.#config.replicaSweepBindings;
    this.#db
      .delete(schema.leaseReplicaSweep)
      .where(
        replicas.length === 0
          ? undefined
          : notInArray(schema.leaseReplicaSweep.replica, [...replicas])
      )
      .run();
    if (replicas.length === 0) return;
    const rows = new Map(
      this.#db
        .select()
        .from(schema.leaseReplicaSweep)
        .all()
        .map(row => [row.replica, row])
    );
    await Promise.all(
      replicas
        .filter(replica => (rows.get(replica)?.nextAt ?? firedAt) <= firedAt)
        .map(replica => this.#sweepReplica(replica, rows.get(replica)?.failures ?? 0, firedAt))
    );
  }

  /**
   * One sweep of one replica. Its next sweep is due one interval after `firedAt`, the time the
   * alarm fired, written before the attempt, so the interval does not grow by the sweep's own time.
   * A sweep that ended sessions, or the first to succeed after failures, writes
   * `lease.replica_swept` with result `ended`; the first failure of a streak and the
   * `LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR`th write it with result `failed`. Failures are
   * warnings until that one, which is logged as an error once per streak.
   */
  async #sweepReplica(replica: string, failuresBefore: number, firedAt: number): Promise<void> {
    const nextAt = firedAt + LEASE_REPLICA_SWEEP_INTERVAL_MS;
    this.#db
      .insert(schema.leaseReplicaSweep)
      .values({ replica, nextAt, failures: failuresBefore })
      .onConflictDoUpdate({ target: schema.leaseReplicaSweep.replica, set: { nextAt } })
      .run();
    let failures = 0;
    let sweep: ReplicaSweepResult | null = null;
    try {
      const binding = HyperdriveBindingSchema.safeParse(Reflect.get(this.env, replica));
      if (!binding.success) throw new ReplicaBindingMissingError();
      const sessions = await LeaseDO.replicaSweep(binding.data.connectionString);
      if (sessions > 0) {
        console.log('sts: replica sweep ended sessions of ended leases', { replica, sessions });
      }
      if (sessions > 0 || failuresBefore > 0) {
        sweep = { result: 'ended', sessions, afterFailures: failuresBefore };
      }
    } catch (error) {
      failures = failuresBefore + 1;
      const detail = sweepFailureDetail(error);
      const fields = { replica, consecutiveFailures: failures, detail };
      if (failures === LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR) {
        console.error(
          'sts: replica sweep keeps failing; replica sessions of ended leases may stay open',
          fields
        );
      } else {
        console.warn('sts: replica sweep failed; the next sweep retries it', fields);
      }
      if (failures === 1 || failures === LEASE_REPLICA_SWEEP_FAILURES_BEFORE_ERROR) {
        sweep = { result: 'failed', consecutiveFailures: failures, detail };
      }
    }
    this.#db
      .update(schema.leaseReplicaSweep)
      .set({ failures })
      .where(eq(schema.leaseReplicaSweep.replica, replica))
      .run();
    if (sweep === null) return;
    try {
      await this.#audit.append(
        this.#stream,
        leaseReplicaSweptEvent({ environment: this.#config.environment, replica, sweep })
      );
    } catch (error) {
      console.error('sts: replica sweep audit append failed', {
        replica,
        reason: errorName(error),
      });
    }
  }

  /**
   * When the next replica sweep is due: now for a configured replica never swept, or null when no
   * replica is configured.
   */
  #nextSweepAt(now: number): number | null {
    const replicas = this.#config.replicaSweepBindings;
    if (replicas.length === 0) return null;
    const due = new Map(
      this.#db
        .select({
          replica: schema.leaseReplicaSweep.replica,
          nextAt: schema.leaseReplicaSweep.nextAt,
        })
        .from(schema.leaseReplicaSweep)
        .all()
        .map(row => [row.replica, row.nextAt])
    );
    return Math.min(...replicas.map(replica => due.get(replica) ?? now));
  }

  async #scheduleAlarm(now: number, failed: boolean): Promise<void> {
    let target = Number.POSITIVE_INFINITY;
    if (this.#audit.hasUnrelayed()) {
      target = now + (failed ? RELAY_RETRY_MS : RELAY_DELAY_MS);
    } else if (this.#audit.hasRows()) {
      target = Math.max(now + 1_000, this.#audit.nextPruneAt());
    }
    const [nextRevocation] = this.#owedRevocations(now, Number.MAX_SAFE_INTEGER, 1);
    if (nextRevocation !== undefined) {
      const due = nextRevocation.revokeRetryAt ?? now;
      target = Math.min(target, Math.max(now + 1_000, due));
    }
    const rowDue = this.#nextRowDueAt();
    if (rowDue !== null) target = Math.min(target, Math.max(now + 1_000, rowDue));
    const sweepDue = this.#nextSweepAt(now);
    if (sweepDue !== null) target = Math.min(target, Math.max(now + 1_000, sweepDue));
    await this.#moveAlarmTo(target, now);
  }

  /**
   * Sets the alarm for the next replica sweep only. The alarm calls it as soon as the sweep ends,
   * before the upkeep has updated the relay and revocation state that `#scheduleAlarm` reads, so
   * a stale owed revocation cannot pull the alarm in and skip its 30-second backoff.
   */
  async #scheduleSweepAlarm(now: number): Promise<void> {
    const sweepDue = this.#nextSweepAt(now);
    if (sweepDue !== null) await this.#moveAlarmTo(Math.max(now + 1_000, sweepDue), now);
  }

  /** Moves the alarm to `target` when none is set, it is later, or it already passed. */
  async #moveAlarmTo(target: number, now: number): Promise<void> {
    if (target === Number.POSITIVE_INFINITY) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target || current < now) {
      await this.ctx.storage.setAlarm(target);
    }
  }
}
