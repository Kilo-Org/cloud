import {
  cloud_billing_sku,
  container_usage_interval,
  container_usage_segment,
  getWorkerDb,
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
  | ApplyResult
  | { kind: 'rejected'; code: RecordStartFailureCode; message: string };

export type ApplyResult = { kind: 'applied'; dedup: boolean };

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
  receivedAt: string
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
  } as const;
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

export async function applyStart(
  env: Cloudflare.Env,
  input: RecordStartInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number
): Promise<StartSkuAdmission> {
  return applyStartWithDb(
    getContainerUsageDb(env),
    input,
    intervalId,
    contextFingerprint,
    receivedAtMs
  );
}

export async function applyStartWithDb(
  db: WorkerDb,
  input: RecordStartInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number
): Promise<StartSkuAdmission> {
  const operation: Promise<StartSkuAdmission> = db.transaction(async tx => {
    const [existing] = await tx
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId))
      .limit(1);
    if (existing) {
      assertMatchingContext(existing, input, contextFingerprint);
      return { kind: 'applied', dedup: true };
    }

    const [sku] = await tx
      .select({
        unit: cloud_billing_sku.unit,
        acceptsNewUsage: cloud_billing_sku.accepts_new_usage,
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
      .values(intervalValues(intervalId, input.startEpochMs, input, contextFingerprint, receivedAt))
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
      return { kind: 'applied', dedup: true };
    }
    return { kind: 'applied', dedup: false };
  });
  return operation.catch(mapSingleOpenIntervalConflict);
}

export async function applyHeartbeat(
  env: Cloudflare.Env,
  input: RecordHeartbeatInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number
): Promise<ApplyResult> {
  return applyHeartbeatWithDb(
    getContainerUsageDb(env),
    input,
    intervalId,
    contextFingerprint,
    receivedAtMs
  );
}

export async function applyHeartbeatWithDb(
  db: WorkerDb,
  input: RecordHeartbeatInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number
): Promise<ApplyResult> {
  const operation: Promise<ApplyResult> = db.transaction(async tx => {
    const [interval] = await tx
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId))
      .for('update')
      .limit(1);
    if (!interval) throw new UsageIntervalNotFoundError(intervalId);
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
      return { kind: 'applied', dedup: true };
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
    await tx
      .update(container_usage_interval)
      .set({
        last_seen_at: sql`GREATEST(${container_usage_interval.last_seen_at}, ${receivedAt})`,
        last_heartbeat_seq: sql`GREATEST(${container_usage_interval.last_heartbeat_seq}, ${input.seq})`,
        confirmed_seconds: sql`${container_usage_interval.confirmed_seconds} + ${appliedSeconds}`,
      })
      .where(eq(container_usage_interval.id, intervalId));
    return { kind: 'applied', dedup: false };
  });
  return operation.catch(mapSingleOpenIntervalConflict);
}

export async function applyStop(
  env: Cloudflare.Env,
  input: RecordStopInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number
): Promise<ApplyResult> {
  return applyStopWithDb(
    getContainerUsageDb(env),
    input,
    intervalId,
    contextFingerprint,
    receivedAtMs
  );
}

export async function applyStopWithDb(
  db: WorkerDb,
  input: RecordStopInput,
  intervalId: string,
  contextFingerprint: string,
  receivedAtMs: number
): Promise<ApplyResult> {
  const finalSegmentKey = heartbeatIdempotencyKey(
    input.service,
    input.instanceId,
    input.startEpochMs,
    input.seq
  );
  return db.transaction(async tx => {
    const [interval] = await tx
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId))
      .for('update')
      .limit(1);
    if (!interval) throw new UsageIntervalNotFoundError(intervalId);
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
      return { kind: 'applied', dedup: true };
    }
    let finalSeconds = 0;
    if (existingSegment) {
      if (
        existingSegment.idempotency_key !== finalSegmentKey ||
        existingSegment.reported_seconds !== input.usageSinceLast
      ) {
        throw new UsageMutationConflictError('Final usage segment has conflicting payload');
      }
    } else {
      finalSeconds = appliedUsageSeconds(interval, input.usageSinceLast, receivedAtMs);
      await tx.insert(container_usage_segment).values({
        interval_id: intervalId,
        seq: input.seq,
        idempotency_key: finalSegmentKey,
        reported_seconds: input.usageSinceLast,
        usage_seconds: finalSeconds,
        received_at: timestamp(receivedAtMs),
      });
    }

    const stopAt = timestamp(Math.max(new Date(interval.last_seen_at).getTime(), receivedAtMs));

    await tx
      .update(container_usage_interval)
      .set({
        status: 'closed',
        close_reason: input.reason,
        exit_code: input.exitCode,
        final_stop_seq: input.seq,
        last_seen_at: stopAt,
        stopped_at: stopAt,
        last_heartbeat_seq: sql`GREATEST(${container_usage_interval.last_heartbeat_seq}, ${input.seq})`,
        confirmed_seconds: interval.confirmed_seconds + finalSeconds,
      })
      .where(eq(container_usage_interval.id, intervalId));
    return { kind: 'applied', dedup: false };
  });
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
