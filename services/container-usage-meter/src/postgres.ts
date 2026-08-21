import {
  cloud_billing_sku,
  compute_usage_charge,
  container_usage_interval,
  container_usage_segment,
  getWorkerDb,
  kilocode_users,
  organizations,
  type WorkerDb,
} from '@kilocode/db';
import { and, eq, gt, lt, ne, sql } from 'drizzle-orm';
import type {
  RecordHeartbeatInput,
  RecordStartFailureCode,
  RecordStartInput,
  RecordStopInput,
  UsageContext,
} from '@kilocode/container-usage';
import { heartbeatIdempotencyKey } from '@kilocode/container-usage';
import {
  billingModeFor,
  MINIMUM_REMAINING_MICRODOLLARS,
  SHADOW_ONLY_BILLING_CONFIG,
  type BillingConfig,
} from './billing-config';

const POSTGRES_TIMEOUT_MS = 2_500;
const STALE_INTERVAL_GRACE_MS = 15 * 60 * 1_000;
const SINGLE_OPEN_INTERVAL_CONSTRAINT = 'UQ_container_usage_interval_single_open';

export class UsageMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageMutationConflictError';
  }
}

export class UsageIntervalNotFoundError extends Error {
  constructor(intervalId: string) {
    super(`Container usage interval not found: ${intervalId}`);
    this.name = 'UsageIntervalNotFoundError';
  }
}

export function getContainerUsageDb(env: Cloudflare.Env): WorkerDb {
  return getWorkerDb(env.HYPERDRIVE.connectionString, {
    connectionTimeoutMillis: POSTGRES_TIMEOUT_MS,
    statement_timeout: POSTGRES_TIMEOUT_MS,
  });
}

export type StartSkuAdmission =
  | { kind: 'applied'; dedup: boolean; billingMode: 'shadow' }
  | { kind: 'applied'; dedup: boolean; billingMode: 'paid'; remainingMicrodollars: number }
  | {
      kind: 'rejected';
      code: Exclude<RecordStartFailureCode, 'insufficient_credits'>;
      message: string;
    }
  | {
      kind: 'rejected';
      code: 'insufficient_credits';
      message: string;
      remainingMicrodollars: number;
      minimumRequiredMicrodollars: number;
    };

export type ApplyResult = {
  kind: 'applied';
  dedup: boolean;
  billingMode: 'shadow' | 'paid';
  budget:
    | { verdict: 'continue' }
    | {
        verdict: 'warn' | 'stop';
        remainingMicrodollars: number;
        minimumRequiredMicrodollars: number;
      };
};

function isPostgresConstraintError(error: unknown, code: string, constraint: string): boolean {
  if (!error || typeof error !== 'object') return false;
  if (
    'code' in error &&
    error.code === code &&
    'constraint' in error &&
    error.constraint === constraint
  ) {
    return true;
  }
  return 'cause' in error && isPostgresConstraintError(error.cause, code, constraint);
}

function mapSingleOpenIntervalConflict(error: unknown): never {
  if (isPostgresConstraintError(error, '23505', SINGLE_OPEN_INTERVAL_CONSTRAINT)) {
    throw new UsageMutationConflictError('Another usage interval is already open');
  }
  throw error;
}

function timestamp(receivedAtMs: number): string {
  return new Date(receivedAtMs).toISOString();
}

function intervalValues(
  intervalId: string,
  startEpochMs: number,
  context: UsageContext,
  contextFingerprint: string,
  receivedAt: string,
  billingMode: 'shadow' | 'paid' = 'shadow',
  rateCentsPerUnit?: string
) {
  return {
    id: intervalId,
    service: context.service,
    instance_id: context.instanceId,
    start_epoch_ms: startEpochMs,
    cloud_billing_sku_id: context.sku,
    context_fingerprint: contextFingerprint,
    subject_type: context.subject.type,
    subject_id: context.subject.id,
    actor_type: context.actor.type,
    actor_id: context.actor.id,
    session_id: context.sessionId,
    metadata: context.metadata,
    started_at: receivedAt,
    last_seen_at: receivedAt,
    billing_mode: billingMode,
    ...(billingMode === 'paid' && rateCentsPerUnit
      ? { rate_cents_per_unit: rateCentsPerUnit }
      : {}),
  } as const;
}

async function balanceForSubject(
  tx: Parameters<Parameters<WorkerDb['transaction']>[0]>[0],
  subject: UsageContext['subject'],
  lock = false
): Promise<number> {
  const query =
    subject.type === 'user'
      ? tx
          .select({
            remaining: sql<number>`${kilocode_users.total_microdollars_acquired} - ${kilocode_users.microdollars_used}`,
          })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, subject.id))
          .limit(1)
      : tx
          .select({
            remaining: sql<number>`${organizations.total_microdollars_acquired} - ${organizations.microdollars_used}`,
          })
          .from(organizations)
          .where(eq(organizations.id, subject.id))
          .limit(1);
  const rows = lock ? await query.for('update') : await query;
  const row = rows[0];
  if (!row) throw new UsageMutationConflictError('Billing subject not found');
  return Number(row.remaining);
}

function budgetForRemaining(
  billingMode: 'shadow' | 'paid',
  remainingMicrodollars: number,
  warnRemainingMicrodollars: number
): ApplyResult['budget'] {
  if (billingMode === 'shadow') return { verdict: 'continue' };
  if (remainingMicrodollars <= MINIMUM_REMAINING_MICRODOLLARS) {
    return {
      verdict: 'stop',
      remainingMicrodollars,
      minimumRequiredMicrodollars: MINIMUM_REMAINING_MICRODOLLARS,
    };
  }
  if (remainingMicrodollars < warnRemainingMicrodollars) {
    return {
      verdict: 'warn',
      remainingMicrodollars,
      minimumRequiredMicrodollars: MINIMUM_REMAINING_MICRODOLLARS,
    };
  }
  return { verdict: 'continue' };
}

async function settleSegment(
  tx: Parameters<Parameters<WorkerDb['transaction']>[0]>[0],
  interval: typeof container_usage_interval.$inferSelect,
  usageSourceId: string,
  appliedSeconds: number,
  receivedAt: string,
  billingConfig: BillingConfig
): Promise<ApplyResult['budget']> {
  if (interval.billing_mode === 'shadow') {
    await tx
      .update(container_usage_interval)
      .set({
        confirmed_seconds: sql`${container_usage_interval.confirmed_seconds} + ${appliedSeconds}`,
      })
      .where(eq(container_usage_interval.id, interval.id));
    return { verdict: 'continue' };
  }
  if (!interval.rate_cents_per_unit) {
    throw new UsageMutationConflictError('Paid usage interval is missing its rate snapshot');
  }

  const settledAfter = interval.settled_billable_seconds + appliedSeconds;
  const [calculation] = await tx
    .select({
      amount: sql<number>`floor((${settledAfter}) * ${container_usage_interval.rate_cents_per_unit} * 10000) - floor(${interval.settled_billable_seconds} * ${container_usage_interval.rate_cents_per_unit} * 10000)`,
    })
    .from(container_usage_interval)
    .where(eq(container_usage_interval.id, interval.id))
    .limit(1);
  if (!calculation) throw new Error('Usage interval disappeared during settlement');
  const amountMicrodollars = Number(calculation.amount);

  await tx
    .update(container_usage_interval)
    .set({
      confirmed_seconds: sql`${container_usage_interval.confirmed_seconds} + ${appliedSeconds}`,
      settled_billable_seconds: settledAfter,
    })
    .where(eq(container_usage_interval.id, interval.id));

  let remainingMicrodollars: number;
  if (amountMicrodollars > 0) {
    const charge: typeof compute_usage_charge.$inferInsert = {
      usage_source: 'container_usage_segment',
      usage_source_id: usageSourceId,
      user_id: interval.subject_type === 'user' ? interval.subject_id : undefined,
      organization_id: interval.subject_type === 'org' ? interval.subject_id : undefined,
      cloud_billing_sku_id: interval.cloud_billing_sku_id,
      quantity: String(appliedSeconds),
      settled_quantity_after: String(settledAfter),
      rate_cents_per_unit: interval.rate_cents_per_unit,
      amount_microdollars: amountMicrodollars,
      created_at: receivedAt,
    };
    await tx.insert(compute_usage_charge).values(charge);
    if (interval.subject_type === 'user') {
      const [payer] = await tx
        .update(kilocode_users)
        .set({
          microdollars_used: sql`${kilocode_users.microdollars_used} + ${amountMicrodollars}`,
        })
        .where(eq(kilocode_users.id, interval.subject_id))
        .returning({
          remaining: sql<number>`${kilocode_users.total_microdollars_acquired} - ${kilocode_users.microdollars_used}`,
        });
      if (!payer) throw new UsageMutationConflictError('Billing subject not found');
      remainingMicrodollars = Number(payer.remaining);
    } else {
      const [payer] = await tx
        .update(organizations)
        .set({
          microdollars_used: sql`${organizations.microdollars_used} + ${amountMicrodollars}`,
          // Keep the deprecated rollback column synchronized with aggregate usage.
          microdollars_balance: sql`${organizations.microdollars_balance} - ${amountMicrodollars}`,
        })
        .where(eq(organizations.id, interval.subject_id))
        .returning({
          remaining: sql<number>`${organizations.total_microdollars_acquired} - ${organizations.microdollars_used}`,
        });
      if (!payer) throw new UsageMutationConflictError('Billing subject not found');
      remainingMicrodollars = Number(payer.remaining);
    }
  } else {
    remainingMicrodollars = await balanceForSubject(
      tx,
      { type: interval.subject_type, id: interval.subject_id },
      true
    );
  }
  return budgetForRemaining('paid', remainingMicrodollars, billingConfig.warnRemainingMicrodollars);
}

function assertMatchingContext(
  row: typeof container_usage_interval.$inferSelect,
  context: UsageContext,
  contextFingerprint: string
): void {
  if (
    row.service !== context.service ||
    row.instance_id !== context.instanceId ||
    row.cloud_billing_sku_id !== context.sku ||
    row.context_fingerprint !== contextFingerprint
  ) {
    throw new UsageMutationConflictError('Usage context does not match the interval');
  }
}

function appliedUsageSeconds(
  interval: typeof container_usage_interval.$inferSelect,
  reportedSeconds: number,
  receivedAtMs: number
): number {
  const confirmedEndMs = Math.max(new Date(interval.last_seen_at).getTime(), receivedAtMs);
  const maximumConfirmedSeconds = Math.max(
    0,
    Math.floor((confirmedEndMs - new Date(interval.started_at).getTime()) / 1_000)
  );
  return Math.min(
    reportedSeconds,
    Math.max(0, maximumConfirmedSeconds - interval.confirmed_seconds)
  );
}

async function recoverMissingInterval(
  tx: Parameters<Parameters<WorkerDb['transaction']>[0]>[0],
  intervalId: string,
  startEpochMs: number,
  context: UsageContext,
  contextFingerprint: string,
  receivedAtMs: number
): Promise<typeof container_usage_interval.$inferSelect> {
  const [sku] = await tx
    .select({ unit: cloud_billing_sku.unit })
    .from(cloud_billing_sku)
    .where(eq(cloud_billing_sku.id, context.sku))
    .limit(1);
  if (!sku) throw new UsageMutationConflictError('Billing SKU not found during interval recovery');
  if (sku.unit !== 'second') {
    throw new UsageMutationConflictError('Billing SKU is not measured in seconds');
  }

  const receivedAt = timestamp(receivedAtMs);
  const [inserted] = await tx
    .insert(container_usage_interval)
    .values(intervalValues(intervalId, startEpochMs, context, contextFingerprint, receivedAt))
    .onConflictDoNothing({ target: container_usage_interval.id })
    .returning();
  if (inserted) return inserted;

  const [existing] = await tx
    .select()
    .from(container_usage_interval)
    .where(eq(container_usage_interval.id, intervalId))
    .for('update')
    .limit(1);
  if (!existing) throw new Error('Container usage interval recovery lost without a winner');
  assertMatchingContext(existing, context, contextFingerprint);
  return existing;
}

export async function applyStart(
  env: Cloudflare.Env,
  input: RecordStartInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number,
  billingConfig: BillingConfig
): Promise<StartSkuAdmission> {
  return applyStartWithDb(
    getContainerUsageDb(env),
    input,
    intervalId,
    contextFingerprint,
    receivedAtMs,
    billingConfig
  );
}

export async function applyStartWithDb(
  db: WorkerDb,
  input: RecordStartInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number,
  billingConfig: BillingConfig = SHADOW_ONLY_BILLING_CONFIG
): Promise<StartSkuAdmission> {
  const operation: Promise<StartSkuAdmission> = db.transaction(async tx => {
    const [existing] = await tx
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId))
      .limit(1);
    if (existing) {
      assertMatchingContext(existing, input, contextFingerprint);
      if (existing.billing_mode === 'paid') {
        return {
          kind: 'applied',
          dedup: true,
          billingMode: 'paid',
          remainingMicrodollars: await balanceForSubject(tx, input.subject, true),
        };
      }
      return { kind: 'applied', dedup: true, billingMode: 'shadow' };
    }

    const [sku] = await tx
      .select({
        unit: cloud_billing_sku.unit,
        acceptsNewUsage: cloud_billing_sku.accepts_new_usage,
        rateCentsPerUnit: cloud_billing_sku.rate_cents_per_unit,
      })
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, input.sku))
      .limit(1);
    if (!sku) return { kind: 'rejected', code: 'sku_not_found', message: 'Billing SKU not found' };
    if (sku.unit !== 'second') {
      return {
        kind: 'rejected',
        code: 'sku_unit_mismatch',
        message: 'Billing SKU is not measured in seconds',
      };
    }
    if (!sku.acceptsNewUsage) {
      return {
        kind: 'rejected',
        code: 'sku_not_accepting_new_usage',
        message: 'Billing SKU is not accepting new usage',
      };
    }

    const billingMode = billingModeFor(billingConfig, input.service, input.subject);
    const [open] = await tx
      .select()
      .from(container_usage_interval)
      .where(
        and(
          eq(container_usage_interval.service, input.service),
          eq(container_usage_interval.instance_id, input.instanceId),
          eq(container_usage_interval.status, 'open'),
          ne(container_usage_interval.id, intervalId)
        )
      )
      .for('update')
      .limit(1);
    if (open) {
      if (open.start_epoch_ms > input.startEpochMs) {
        throw new UsageMutationConflictError('Cannot supersede a newer usage interval');
      }
    }

    if (billingMode === 'paid') {
      const remaining = await balanceForSubject(tx, input.subject, true);
      if (remaining <= MINIMUM_REMAINING_MICRODOLLARS) {
        return {
          kind: 'rejected',
          code: 'insufficient_credits',
          message: 'Container billing requires at least $5.00 in remaining credits',
          remainingMicrodollars: remaining,
          minimumRequiredMicrodollars: MINIMUM_REMAINING_MICRODOLLARS,
        };
      }
    }

    if (open) {
      await tx
        .update(container_usage_interval)
        .set({
          status: 'closed',
          close_reason: 'superseded',
          stopped_at: open.last_seen_at,
        })
        .where(eq(container_usage_interval.id, open.id));
    }

    const receivedAt = timestamp(receivedAtMs);
    const [inserted] = await tx
      .insert(container_usage_interval)
      .values(
        intervalValues(
          intervalId,
          input.startEpochMs,
          input,
          contextFingerprint,
          receivedAt,
          billingMode,
          billingMode === 'paid' ? sku.rateCentsPerUnit : undefined
        )
      )
      .onConflictDoNothing({ target: container_usage_interval.id })
      .returning({ id: container_usage_interval.id });
    if (!inserted) {
      const [winner] = await tx
        .select()
        .from(container_usage_interval)
        .where(eq(container_usage_interval.id, intervalId))
        .limit(1);
      if (!winner) throw new Error('Container usage interval insert lost without a winner');
      assertMatchingContext(winner, input, contextFingerprint);
      if (winner.billing_mode === 'paid') {
        return {
          kind: 'applied',
          dedup: true,
          billingMode: 'paid',
          remainingMicrodollars: await balanceForSubject(tx, input.subject, true),
        };
      }
      return { kind: 'applied', dedup: true, billingMode: 'shadow' };
    }
    if (billingMode === 'paid') {
      return {
        kind: 'applied',
        dedup: false,
        billingMode: 'paid',
        remainingMicrodollars: await balanceForSubject(tx, input.subject),
      };
    }
    return { kind: 'applied', dedup: false, billingMode: 'shadow' };
  });
  return operation.catch(mapSingleOpenIntervalConflict);
}

export async function applyHeartbeat(
  env: Cloudflare.Env,
  input: RecordHeartbeatInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number,
  billingConfig: BillingConfig
): Promise<ApplyResult> {
  return applyHeartbeatWithDb(
    getContainerUsageDb(env),
    input,
    intervalId,
    contextFingerprint,
    receivedAtMs,
    billingConfig
  );
}

export async function applyHeartbeatWithDb(
  db: WorkerDb,
  input: RecordHeartbeatInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number,
  billingConfig: BillingConfig = SHADOW_ONLY_BILLING_CONFIG
): Promise<ApplyResult> {
  const operation: Promise<ApplyResult> = db.transaction(async tx => {
    const [existingInterval] = await tx
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId))
      .for('update')
      .limit(1);
    const interval =
      existingInterval ??
      (await recoverMissingInterval(
        tx,
        intervalId,
        input.startEpochMs,
        input.context,
        contextFingerprint,
        receivedAtMs
      ));
    assertMatchingContext(interval, input.context, contextFingerprint);

    const [existingSegment] = await tx
      .select()
      .from(container_usage_segment)
      .where(
        and(
          eq(container_usage_segment.interval_id, intervalId),
          eq(container_usage_segment.seq, input.seq)
        )
      )
      .limit(1);
    if (existingSegment) {
      if (
        existingSegment.idempotency_key !== input.idempotencyKey ||
        existingSegment.reported_seconds !== (input.usageSinceLast ?? 0)
      ) {
        throw new UsageMutationConflictError('Heartbeat sequence has conflicting payload');
      }
      const remaining =
        interval.billing_mode === 'paid'
          ? await balanceForSubject(tx, input.context.subject, true)
          : 0;
      return {
        kind: 'applied',
        dedup: true,
        billingMode: interval.billing_mode,
        budget: budgetForRemaining(
          interval.billing_mode,
          remaining,
          billingConfig.warnRemainingMicrodollars
        ),
      };
    }
    if (interval.status === 'closed' && interval.close_reason === 'unconfirmed') {
      const [newerGeneration] = await tx
        .select({ id: container_usage_interval.id })
        .from(container_usage_interval)
        .where(
          and(
            eq(container_usage_interval.service, interval.service),
            eq(container_usage_interval.instance_id, interval.instance_id),
            gt(container_usage_interval.start_epoch_ms, interval.start_epoch_ms)
          )
        )
        .limit(1);
      if (newerGeneration) {
        throw new UsageMutationConflictError('Cannot reopen a superseded usage interval');
      }
      await tx
        .update(container_usage_interval)
        .set({
          status: 'open',
          stopped_at: null,
          close_reason: null,
        })
        .where(eq(container_usage_interval.id, intervalId));
    } else if (interval.status !== 'open') {
      throw new UsageMutationConflictError('Cannot heartbeat a closed usage interval');
    }

    const receivedAt = timestamp(receivedAtMs);
    const reportedSeconds = input.usageSinceLast ?? 0;
    const appliedSeconds = appliedUsageSeconds(interval, reportedSeconds, receivedAtMs);
    await tx.insert(container_usage_segment).values({
      interval_id: intervalId,
      seq: input.seq,
      idempotency_key: input.idempotencyKey,
      reported_seconds: reportedSeconds,
      usage_seconds: appliedSeconds,
      received_at: receivedAt,
    });
    const budget = await settleSegment(
      tx,
      interval,
      input.idempotencyKey,
      appliedSeconds,
      receivedAt,
      billingConfig
    );
    await tx
      .update(container_usage_interval)
      .set({
        last_seen_at: sql`GREATEST(${container_usage_interval.last_seen_at}, ${receivedAt})`,
        last_heartbeat_seq: sql`GREATEST(${container_usage_interval.last_heartbeat_seq}, ${input.seq})`,
      })
      .where(eq(container_usage_interval.id, intervalId));
    return { kind: 'applied', dedup: false, billingMode: interval.billing_mode, budget };
  });
  return operation.catch(mapSingleOpenIntervalConflict);
}

export async function applyStop(
  env: Cloudflare.Env,
  input: RecordStopInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number,
  billingConfig: BillingConfig = SHADOW_ONLY_BILLING_CONFIG
): Promise<ApplyResult> {
  return applyStopWithDb(
    getContainerUsageDb(env),
    input,
    intervalId,
    contextFingerprint,
    receivedAtMs,
    billingConfig
  );
}

export async function applyStopWithDb(
  db: WorkerDb,
  input: RecordStopInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number,
  billingConfig: BillingConfig = SHADOW_ONLY_BILLING_CONFIG
): Promise<ApplyResult> {
  const finalSegmentKey = heartbeatIdempotencyKey(
    input.service,
    input.instanceId,
    input.startEpochMs,
    input.seq
  );
  const operation: Promise<ApplyResult> = db.transaction(async tx => {
    const [existingInterval] = await tx
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId))
      .for('update')
      .limit(1);
    const interval =
      existingInterval ??
      (await recoverMissingInterval(
        tx,
        intervalId,
        input.startEpochMs,
        input.context,
        contextFingerprint,
        receivedAtMs
      ));
    assertMatchingContext(interval, input.context, contextFingerprint);
    const [existingSegment] = await tx
      .select()
      .from(container_usage_segment)
      .where(
        and(
          eq(container_usage_segment.interval_id, intervalId),
          eq(container_usage_segment.seq, input.seq)
        )
      )
      .limit(1);
    if (interval.status !== 'open' && interval.close_reason !== 'unconfirmed') {
      if (
        interval.close_reason !== input.reason ||
        interval.exit_code !== (input.exitCode ?? null) ||
        interval.final_stop_seq !== input.seq ||
        !existingSegment ||
        existingSegment.idempotency_key !== finalSegmentKey ||
        existingSegment.reported_seconds !== input.usageSinceLast
      ) {
        throw new UsageMutationConflictError('Closed interval has conflicting stop details');
      }
      const remaining =
        interval.billing_mode === 'paid'
          ? await balanceForSubject(tx, input.context.subject, true)
          : 0;
      return {
        kind: 'applied',
        dedup: true,
        billingMode: interval.billing_mode,
        budget: budgetForRemaining(
          interval.billing_mode,
          remaining,
          billingConfig.warnRemainingMicrodollars
        ),
      };
    }
    let finalSeconds = 0;
    const receivedAt = timestamp(receivedAtMs);
    if (existingSegment) {
      if (
        existingSegment.idempotency_key !== finalSegmentKey ||
        existingSegment.reported_seconds !== input.usageSinceLast
      ) {
        throw new UsageMutationConflictError('Final usage segment has conflicting payload');
      }
    } else {
      finalSeconds =
        interval.status === 'closed' && interval.close_reason === 'unconfirmed'
          ? 0
          : appliedUsageSeconds(interval, input.usageSinceLast, receivedAtMs);
      await tx.insert(container_usage_segment).values({
        interval_id: intervalId,
        seq: input.seq,
        idempotency_key: finalSegmentKey,
        reported_seconds: input.usageSinceLast,
        usage_seconds: finalSeconds,
        received_at: receivedAt,
      });
    }

    const wasReconciled = interval.status === 'closed' && interval.close_reason === 'unconfirmed';
    const stopAt = wasReconciled
      ? (interval.stopped_at ?? interval.last_seen_at)
      : timestamp(Math.max(new Date(interval.last_seen_at).getTime(), receivedAtMs));

    const budget = wasReconciled
      ? interval.billing_mode === 'paid'
        ? budgetForRemaining(
            'paid',
            await balanceForSubject(tx, input.context.subject, true),
            billingConfig.warnRemainingMicrodollars
          )
        : { verdict: 'continue' as const }
      : await settleSegment(tx, interval, finalSegmentKey, finalSeconds, receivedAt, billingConfig);

    await tx
      .update(container_usage_interval)
      .set({
        status: 'closed',
        close_reason: input.reason,
        exit_code: input.exitCode,
        final_stop_seq: input.seq,
        last_seen_at: wasReconciled ? interval.last_seen_at : stopAt,
        stopped_at: stopAt,
        last_heartbeat_seq: sql`GREATEST(${container_usage_interval.last_heartbeat_seq}, ${input.seq})`,
        confirmed_seconds: wasReconciled
          ? interval.confirmed_seconds
          : interval.confirmed_seconds + finalSeconds,
      })
      .where(eq(container_usage_interval.id, intervalId));
    return { kind: 'applied', dedup: false, billingMode: interval.billing_mode, budget };
  });
  return operation.catch(mapSingleOpenIntervalConflict);
}

export async function reconcileStaleIntervals(
  env: Cloudflare.Env,
  nowMs = Date.now()
): Promise<number> {
  return reconcileStaleIntervalsWithDb(getContainerUsageDb(env), nowMs);
}

export async function reconcileStaleIntervalsWithDb(
  db: WorkerDb,
  nowMs = Date.now()
): Promise<number> {
  const cutoff = timestamp(nowMs - STALE_INTERVAL_GRACE_MS);
  const rows = await db
    .update(container_usage_interval)
    .set({
      status: 'closed',
      close_reason: 'unconfirmed',
      stopped_at: sql`${container_usage_interval.last_seen_at}`,
    })
    .where(
      and(
        eq(container_usage_interval.status, 'open'),
        lt(container_usage_interval.last_seen_at, cutoff)
      )
    )
    .returning({ id: container_usage_interval.id });
  return rows.length;
}
