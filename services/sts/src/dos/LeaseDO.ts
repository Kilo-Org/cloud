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
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';
import migrations from '../../drizzle.lease/migrations';
import {
  leaseCreatedEvent,
  leaseRevokedEvent,
  type LeaseAuditCaller,
  type LeaseRevocationResult,
  type LeaseRevokeCause,
} from '../audit/events';
import { AuditLog } from '../audit/log';
import {
  LEASE_CREATE_BUDGET_MS,
  LEASE_CREATES_PER_MINUTE,
  LEASE_EXPIRY_TOLERANCE_MS,
  LEASE_RETRY_AFTER_SECONDS,
  LEASE_REVOKE_RETRIES_PER_ALARM,
  LEASE_REVOKE_RETRY_MS,
  LEASE_ROW_RETENTION_MS,
  RELAY_DELAY_MS,
  RELAY_RETRY_MS,
} from '../constants';
import * as schema from '../db/lease-schema';
import { readConfig, type Env, type StsConfig } from '../env';
import { InfisicalClient, type DynamicSecretRef } from '../infisical/client';
import { getSignerStub } from './stubs';

type LeaseDatabase = DrizzleSqliteDODatabase<typeof schema>;
type LeaseRow = typeof schema.lease.$inferSelect;

/**
 * Each grant's Infisical dynamic secret (README "Database leases"), alone in its own folder so the
 * STS identity's `lease` permission can name it.
 */
export const LEASE_DYNAMIC_SECRETS: Readonly<Record<LeaseGrant, DynamicSecretRef>> = {
  'replica-read': { name: 'replica-read', path: '/dynamic/replica-read' },
  'ci-migration': { name: 'ci-migration', path: '/dynamic/ci-migration' },
};

const MINUTE_MS = 60 * 1000;

const CallerSchema = z.strictObject({
  workload: WorkloadNameSchema,
  identity: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  channel: z.enum(['worker-binding', 'http']),
  run: z
    .strictObject({
      jobWorkflowRef: z.string().min(1).max(512),
      runId: z.string().regex(/^[0-9]{1,20}$/),
      runAttempt: z
        .string()
        .regex(/^[0-9]{1,20}$/)
        .optional(),
    })
    .nullable(),
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
  | { status: 'not_found'; reason: 'not_owner' | 'other_run' | 'unknown_lease' }
  | { status: 'unavailable'; retryAfterSeconds: number };

function retryAfterSeconds(ms: number | null): number {
  if (ms === null) return LEASE_RETRY_AFTER_SECONDS;
  return Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * One object per environment (design 6.1 job 3): it creates and revokes database leases through
 * Infisical's dynamic secrets, keeps one row per lease with its owner (never a username or
 * password), enforces each workload's active and per-minute limits, and owns the
 * `sts:<environment>:leases` audit stream. A lease is returned only with its `lease.created` row
 * committed; one STS cannot hand over (too late, an unexpected expiry, or a failed audit append) is
 * revoked at once. A revocation Infisical cannot take is audited as `revoke_failed` and retried by
 * the alarm until it succeeds or the lease expires. Leases are few (a few hundred a day), so one
 * object serves the environment.
 */
export class LeaseDO extends DurableObject<Env> {
  private readonly config: StsConfig;
  private readonly db: LeaseDatabase;
  private readonly audit: AuditLog;
  private readonly stream: string;
  private readonly client: InfisicalClient;
  /**
   * Revocations in flight, by lease id: concurrent revokes of one lease (callers and the alarm)
   * share one manager call.
   */
  private readonly revoking = new Map<string, Promise<LeaseRevocationResult>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = readConfig(env);
    this.config = config;
    this.db = drizzle(ctx.storage, { schema });
    this.audit = new AuditLog(ctx.storage, env.AUDIT_QUEUE);
    this.stream = `sts:${config.environment}:leases`;
    this.client = new InfisicalClient(config.manager, () =>
      withDORetry(
        () => getSignerStub(env, config),
        stub => stub.signManagerToken(),
        'sts.signManagerToken'
      )
    );
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
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
    if (input.environment !== this.config.environment) {
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    if (this.config.manager.projectSlug === null) {
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
    const limited = this.limitFor(caller.workload, grant, input.maxActive, callStartedAt);
    if (limited !== null) return limited;

    const { slot } = this.db
      .insert(schema.lease)
      .values({
        workload: caller.workload,
        caller: JSON.stringify(caller),
        runId: caller.run?.runId ?? null,
        grant,
        state: 'pending',
        createdAt: callStartedAt,
        expiresAt: deadline,
      })
      .returning({ slot: schema.lease.slot })
      .get();

    const created = await this.client.createLease(LEASE_DYNAMIC_SECRETS[grant], input.ttlSeconds);
    const finishedAt = Date.now();
    if (created.status === 'unreachable') {
      console.error('sts: lease creation failed', {
        workload: caller.workload,
        grant,
        detail: created.detail,
      });
      this.end(slot, 'failed', finishedAt);
      await this.scheduleAlarm(finishedAt, false);
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
        await this.audit.append(
          this.stream,
          leaseCreatedEvent({
            environment: this.config.environment,
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
      this.db
        .update(schema.lease)
        .set({
          leaseId: created.leaseId,
          state: 'failed',
          expiresAt: created.expiresAt,
          revokeCause: cause,
        })
        .where(eq(schema.lease.slot, slot))
        .run();
      await this.revokeOnce(created.leaseId, { firstAttempt: true });
      await this.scheduleAlarm(Date.now(), false);
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    // In the same output gate as the audit row.
    this.db
      .update(schema.lease)
      .set({ leaseId: created.leaseId, state: 'active', expiresAt: created.expiresAt })
      .where(eq(schema.lease.slot, slot))
      .run();
    await this.scheduleAlarm(Date.now(), false);
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
   * `not_found`, whoever holds it, and so is a GitHub run's lease asked for by another run. A lease
   * of the caller's that already ended answers `revoked` without a manager call.
   */
  async revoke(raw: LeaseRevokeRequest): Promise<LeaseRevokeOutcome> {
    const input = LeaseRevokeRequestSchema.parse(raw);
    if (input.environment !== this.config.environment) {
      return { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS };
    }
    const row = this.db
      .select()
      .from(schema.lease)
      .where(eq(schema.lease.leaseId, input.leaseId))
      .get();
    if (row === undefined || row.state === 'failed' || row.state === 'pending') {
      return { status: 'not_found', reason: 'unknown_lease' };
    }
    if (row.workload !== input.caller.workload) return { status: 'not_found', reason: 'not_owner' };
    if (row.runId !== null && row.runId !== (input.caller.run?.runId ?? null)) {
      return { status: 'not_found', reason: 'other_run' };
    }
    if (row.state === 'revoked' || row.expiresAt <= Date.now()) return { status: 'revoked' };

    const firstAttempt = row.revokeCause === null;
    if (firstAttempt) {
      // Owed from now on: the alarm retries it if Infisical cannot take it.
      this.db
        .update(schema.lease)
        .set({ revokeCause: 'caller' })
        .where(eq(schema.lease.slot, row.slot))
        .run();
    }
    const result = await this.revokeOnce(input.leaseId, { firstAttempt });
    await this.scheduleAlarm(Date.now(), false);
    return result === 'revoke_failed'
      ? { status: 'unavailable', retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS }
      : { status: 'revoked' };
  }

  async alarm(): Promise<void> {
    let failed = false;
    try {
      await this.audit.relay(this.stream);
    } catch (error) {
      failed = true;
      console.warn('sts: lease audit relay failed; rows stay for the next alarm', {
        reason: errorName(error),
      });
    }
    await this.retryOwedRevocations();
    const now = Date.now();
    this.audit.pruneIfDue(now);
    this.db
      .delete(schema.lease)
      .where(
        lt(
          sql`coalesce(${schema.lease.endedAt}, ${schema.lease.expiresAt})`,
          now - LEASE_ROW_RETENTION_MS
        )
      )
      .run();
    await this.scheduleAlarm(Date.now(), failed);
  }

  /**
   * The refusal for a workload at its limits: its active leases of this grant (a pending creation
   * counts), then its creations of any grant in the last minute, whatever their outcome.
   */
  private limitFor(
    workload: string,
    grant: LeaseGrant,
    maxActive: number,
    now: number
  ): LeaseCreateResult | null {
    const active = this.db
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
    const recent = this.db
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
  private async revokeOnce(
    leaseId: string,
    options: { firstAttempt: boolean }
  ): Promise<LeaseRevocationResult> {
    const inFlight = this.revoking.get(leaseId);
    if (inFlight !== undefined) return await inFlight;
    const pending = this.attemptRevocation(leaseId, options.firstAttempt).finally(() => {
      this.revoking.delete(leaseId);
    });
    this.revoking.set(leaseId, pending);
    return await pending;
  }

  /**
   * Asks Infisical to revoke an owed lease (its row carries `revokeCause`). On success it writes
   * `lease.revoked` and ends the row. When Infisical cannot be reached, the first attempt writes
   * `lease.revoked` with result `revoke_failed` and the row stays owed for the alarm. A failed
   * audit append also leaves it owed: the retry finds the lease gone and writes the row then.
   */
  private async attemptRevocation(
    leaseId: string,
    firstAttempt: boolean
  ): Promise<LeaseRevocationResult> {
    const row = this.db.select().from(schema.lease).where(eq(schema.lease.leaseId, leaseId)).get();
    if (row === undefined || row.revokeCause === null) return 'gone';
    const cause = row.revokeCause;
    const caller: LeaseAuditCaller = CallerSchema.parse(JSON.parse(row.caller));
    const revocation = await this.client.revokeLease(LEASE_DYNAMIC_SECRETS[row.grant], leaseId);
    const result: LeaseRevocationResult =
      revocation.status === 'unreachable' ? 'revoke_failed' : revocation.status;
    if (revocation.status === 'unreachable') {
      console.error('sts: lease revocation failed; the lease object retries it', {
        workload: row.workload,
        grant: row.grant,
        cause,
        detail: revocation.detail,
      });
      if (!firstAttempt) return result;
    }
    try {
      await this.audit.append(
        this.stream,
        leaseRevokedEvent({
          environment: this.config.environment,
          caller,
          grant: row.grant,
          leaseId,
          cause,
          result,
        })
      );
    } catch (error) {
      console.error('sts: lease revocation audit append failed', {
        workload: row.workload,
        reason: errorName(error),
      });
      return 'revoke_failed';
    }
    if (result !== 'revoke_failed') {
      this.db
        .update(schema.lease)
        .set({
          state: row.state === 'active' ? 'revoked' : 'failed',
          endedAt: Date.now(),
          revokeCause: null,
        })
        .where(eq(schema.lease.slot, row.slot))
        .run();
    }
    return result;
  }

  /** The owed revocations of unexpired leases, oldest first; Infisical drops an expired one itself. */
  private owedRevocations(now: number, limit: number): LeaseRow[] {
    return this.db
      .select()
      .from(schema.lease)
      .where(
        and(
          isNotNull(schema.lease.revokeCause),
          isNotNull(schema.lease.leaseId),
          inArray(schema.lease.state, ['active', 'failed']),
          gt(schema.lease.expiresAt, now)
        )
      )
      .orderBy(asc(schema.lease.slot))
      .limit(limit)
      .all();
  }

  private async retryOwedRevocations(): Promise<void> {
    for (const row of this.owedRevocations(Date.now(), LEASE_REVOKE_RETRIES_PER_ALARM)) {
      if (row.leaseId === null) continue;
      await this.revokeOnce(row.leaseId, { firstAttempt: false });
    }
  }

  private end(slot: number, state: 'failed' | 'revoked', at: number): void {
    this.db
      .update(schema.lease)
      .set({ state, endedAt: at })
      .where(eq(schema.lease.slot, slot))
      .run();
  }

  /** The earliest time a lease row is due for deletion, or null for none. */
  private nextRowPruneAt(): number | null {
    const row = this.db
      .select({
        end: sql<number | null>`min(coalesce(${schema.lease.endedAt}, ${schema.lease.expiresAt}))`,
      })
      .from(schema.lease)
      .get();
    return row === undefined || row.end === null ? null : row.end + LEASE_ROW_RETENTION_MS;
  }

  private async scheduleAlarm(now: number, failed: boolean): Promise<void> {
    let target = Number.POSITIVE_INFINITY;
    if (this.audit.hasUnrelayed()) {
      target = now + (failed ? RELAY_RETRY_MS : RELAY_DELAY_MS);
    } else if (this.audit.hasRows()) {
      target = Math.max(now + 1_000, this.audit.nextPruneAt());
    }
    if (this.owedRevocations(now, 1).length > 0)
      target = Math.min(target, now + LEASE_REVOKE_RETRY_MS);
    const rowPrune = this.nextRowPruneAt();
    if (rowPrune !== null) target = Math.min(target, Math.max(now + 1_000, rowPrune));
    if (target === Number.POSITIVE_INFINITY) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target || current < now) {
      await this.ctx.storage.setAlarm(target);
    }
  }
}
